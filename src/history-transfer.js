import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";

import * as tar from "tar";

import {
  DB_FILE_BASENAME,
  GLOBAL_STATE_BACKUP_FILE_BASENAME,
  GLOBAL_STATE_FILE_BASENAME,
  SESSION_DIRS
} from "./constants.js";
import { openDatabase } from "./sqlite.js";
import {
  detectStateDb,
  existingStateDbPath,
  wrapSqliteBusyError,
  wrapSqliteMalformedError
} from "./sqlite-state.js";

const HISTORY_NAMESPACE = "provider-sync-history";
const HISTORY_VERSION = 1;
const DEFAULT_TRANSCRIPT_MESSAGE_LIMIT = 200;

function toArchivePath(value) {
  return value.split(path.sep).join("/");
}

function validateRelativePath(relativePath) {
  if (typeof relativePath !== "string" || !relativePath.trim()) {
    throw new Error("Invalid empty path in history archive.");
  }
  const normalized = relativePath.replaceAll("\\", "/");
  if (
    normalized.startsWith("/")
    || normalized.split("/").includes("..")
    || path.isAbsolute(normalized)
  ) {
    throw new Error(`Invalid unsafe path in history archive: ${relativePath}`);
  }
  return normalized;
}

function resolveArchivePath(rootDir, relativePath) {
  const normalized = validateRelativePath(relativePath);
  return path.join(rootDir, ...normalized.split("/"));
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function copyIfPresent(sourcePath, destinationPath) {
  if (!await pathExists(sourcePath)) {
    return false;
  }
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  await fs.copyFile(sourcePath, destinationPath);
  return true;
}

async function listFilesRecursive(rootDir, predicate) {
  let entries;
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFilesRecursive(fullPath, predicate));
      continue;
    }
    if (entry.isFile() && predicate(fullPath, entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

async function listStagedFiles(rootDir) {
  const files = await listFilesRecursive(rootDir, () => true);
  return files.map((filePath) => toArchivePath(path.relative(rootDir, filePath)));
}

async function readFirstLine(filePath) {
  const handle = await fs.open(filePath, "r");
  try {
    let position = 0;
    let collected = Buffer.alloc(0);
    while (true) {
      const chunk = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) {
        break;
      }
      position += bytesRead;
      collected = Buffer.concat([collected, chunk.subarray(0, bytesRead)]);
      const newlineIndex = collected.indexOf(0x0a);
      if (newlineIndex !== -1) {
        const crlf = newlineIndex > 0 && collected[newlineIndex - 1] === 0x0d;
        const lineBuffer = crlf ? collected.subarray(0, newlineIndex - 1) : collected.subarray(0, newlineIndex);
        return lineBuffer.toString("utf8");
      }
    }
    return collected.toString("utf8");
  } finally {
    await handle.close();
  }
}

function parseSessionMeta(firstLine) {
  if (!firstLine) {
    return null;
  }
  try {
    const parsed = JSON.parse(firstLine);
    if (parsed?.type !== "session_meta" || !parsed.payload || typeof parsed.payload !== "object") {
      return null;
    }
    return parsed.payload;
  } catch {
    return null;
  }
}

function textFromContent(value) {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map(textFromContent)
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if (!value || typeof value !== "object") {
    return "";
  }
  for (const key of ["text", "input_text", "output_text", "message", "content"]) {
    const text = textFromContent(value[key]);
    if (text) {
      return text;
    }
  }
  return "";
}

function normalizeTranscriptRole(role) {
  if (role === "assistant" || role === "user" || role === "system") {
    return role;
  }
  return null;
}

function messageFromRecord(record) {
  if (!record || typeof record !== "object") {
    return null;
  }

  const payload = record.payload;
  if (record.type === "event_msg" && payload && typeof payload === "object") {
    if (payload.type === "user_message") {
      const text = textFromContent(payload.message ?? payload.content ?? payload.text);
      return text ? { role: "user", text } : null;
    }
    if (payload.type === "assistant_message" || payload.type === "agent_message") {
      const text = textFromContent(payload.message ?? payload.content ?? payload.text);
      return text ? { role: "assistant", text } : null;
    }
  }

  for (const value of [record.payload, record.item, record.msg, record]) {
    if (!value || typeof value !== "object") {
      continue;
    }
    const role = normalizeTranscriptRole(value.role);
    if (value.type === "message" && role) {
      const text = textFromContent(value.content ?? value.message ?? value.text);
      if (text) {
        return { role, text };
      }
    }
  }
  return null;
}

async function scanRolloutMessages(filePath, {
  firstUserOnly = false,
  limit = DEFAULT_TRANSCRIPT_MESSAGE_LIMIT
} = {}) {
  const messages = [];
  let truncated = false;
  const stream = createReadStream(filePath, {
    encoding: "utf8",
    highWaterMark: 1024 * 1024
  });
  const lines = readline.createInterface({
    input: stream,
    crlfDelay: Infinity
  });

  try {
    for await (const line of lines) {
      if (!line) {
        continue;
      }
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const message = messageFromRecord(record);
      if (!message) {
        continue;
      }
      if (firstUserOnly) {
        if (message.role === "user") {
          return { messages: [message], truncated: false };
        }
        continue;
      }
      if (messages.length >= limit) {
        truncated = true;
        break;
      }
      messages.push({
        ...message,
        timestamp: typeof record.timestamp === "string" ? record.timestamp : null
      });
    }
    return { messages, truncated };
  } finally {
    lines.close();
    stream.destroy();
  }
}

async function readRolloutFirstUserMessage(filePath) {
  try {
    const { messages } = await scanRolloutMessages(filePath, { firstUserOnly: true, limit: 1 });
    return messages[0]?.text ?? "";
  } catch {
    return "";
  }
}

function summarizeRollout(entry) {
  if (!entry) {
    return null;
  }
  return {
    threadId: entry.threadId ?? null,
    scope: entry.scope,
    provider: entry.provider ?? "(missing)",
    cwd: entry.cwd ?? "",
    timestamp: entry.timestamp ?? "",
    relativePath: entry.relativePath,
    size: entry.size ?? 0
  };
}

function summarizeSqliteRow(row, sourceColumns = []) {
  if (!row) {
    return null;
  }
  const timestamp =
    row.updated_at_ms ?? row.created_at_ms
    ?? (row.updated_at !== undefined ? Number(row.updated_at) * 1000 : undefined)
    ?? (row.created_at !== undefined ? Number(row.created_at) * 1000 : undefined)
    ?? "";
  return {
    threadId: row.id,
    scope: Number(row.archived) ? "archived_sessions" : "sessions",
    provider: row.model_provider ?? "(missing)",
    cwd: row.cwd ?? "",
    firstUserMessage: row.first_user_message ?? "",
    timestamp,
    columns: sourceColumns.length
  };
}

function buildExportKey(rollout) {
  return rollout.threadId ? `thread:${rollout.threadId}` : `path:${rollout.relativePath}`;
}

function selectedThreadIdsFromRollouts(rollouts) {
  return rollouts
    .map((rollout) => rollout.threadId)
    .filter((threadId) => typeof threadId === "string" && threadId);
}

function oppositeSessionScope(scope) {
  if (scope === "sessions") {
    return "archived_sessions";
  }
  if (scope === "archived_sessions") {
    return "sessions";
  }
  throw new Error(`Cannot toggle archive state for unsupported scope: ${scope}`);
}

function replaceRelativePathScope(relativePath, nextScope) {
  const normalized = validateRelativePath(relativePath);
  const parts = normalized.split("/");
  if (!SESSION_DIRS.includes(parts[0])) {
    throw new Error(`Cannot toggle archive state for rollout outside sessions directories: ${relativePath}`);
  }
  parts[0] = nextScope;
  return parts.join("/");
}

async function updateThreadArchivedFlag(codexHome, threadId, archived) {
  if (!threadId) {
    return 0;
  }
  const dbPath = await existingStateDbPath(codexHome);
  if (!dbPath) {
    return 0;
  }

  let db;
  let transactionOpen = false;
  try {
    db = await openDatabase(dbPath);
    if (!tableExists(db, "threads") || !tableColumns(db, "threads").includes("archived")) {
      return 0;
    }
    db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    const result = db
      .prepare("UPDATE threads SET archived = ? WHERE id = ?")
      .run(archived ? 1 : 0, threadId);
    db.exec("COMMIT");
    transactionOpen = false;
    return result.changes ?? 0;
  } catch (error) {
    if (transactionOpen) {
      try {
        db?.exec("ROLLBACK");
      } catch {
        // Ignore rollback failures and surface the original SQLite error.
      }
    }
    throw wrapSqliteMalformedError(
      wrapSqliteBusyError(error, "toggle archived session state"),
      "toggle archived session state"
    );
  } finally {
    db?.close();
  }
}

export async function collectRolloutInventory(codexHome) {
  const rollouts = [];
  for (const scope of SESSION_DIRS) {
    const rootDir = path.join(codexHome, scope);
    const rolloutPaths = await listFilesRecursive(
      rootDir,
      (_filePath, name) => name.startsWith("rollout-") && name.endsWith(".jsonl")
    );
    for (const rolloutPath of rolloutPaths) {
      const stat = await fs.stat(rolloutPath);
      const relativePath = toArchivePath(path.relative(codexHome, rolloutPath));
      const meta = parseSessionMeta(await readFirstLine(rolloutPath));
      rollouts.push({
        relativePath,
        scope,
        threadId: typeof meta?.id === "string" && meta.id ? meta.id : null,
        title: typeof meta?.title === "string" && meta.title ? meta.title : null,
        provider: typeof meta?.model_provider === "string" ? meta.model_provider : null,
        cwd: typeof meta?.cwd === "string" ? meta.cwd : null,
        timestamp: typeof meta?.timestamp === "string" ? meta.timestamp : null,
        size: stat.size,
        mtimeMs: stat.mtimeMs
      });
    }
  }
  return rollouts.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function copyRolloutsToStaging(codexHome, stagingDir, rollouts) {
  for (const rollout of rollouts) {
    await copyIfPresent(
      resolveArchivePath(codexHome, rollout.relativePath),
      resolveArchivePath(stagingDir, rollout.relativePath)
    );
  }
}

async function copyGlobalStateToStaging(codexHome, stagingDir) {
  const copied = [];
  for (const fileName of [GLOBAL_STATE_FILE_BASENAME, GLOBAL_STATE_BACKUP_FILE_BASENAME]) {
    if (await copyIfPresent(path.join(codexHome, fileName), path.join(stagingDir, fileName))) {
      copied.push(fileName);
    }
  }
  return copied;
}

async function copyStateDbToStaging(codexHome, stagingDir) {
  const stateDb = await detectStateDb(codexHome);
  if (!stateDb) {
    return [];
  }

  const copied = [];
  for (const suffix of ["", "-wal", "-shm"]) {
    const sourcePath = `${stateDb.path}${suffix}`;
    const relativePath = toArchivePath(path.relative(codexHome, sourcePath));
    if (await copyIfPresent(sourcePath, resolveArchivePath(stagingDir, path.join("db", relativePath)))) {
      copied.push(relativePath);
    }
  }
  return copied;
}

async function pruneStagedStateDb(stagingDir, dbFiles, selectedThreadIds) {
  if (!selectedThreadIds) {
    return dbFiles;
  }
  const baseFile = dbFiles.find((fileName) => path.basename(fileName) === DB_FILE_BASENAME);
  if (!baseFile) {
    return [];
  }

  const dbPath = resolveArchivePath(stagingDir, path.join("db", baseFile));
  let db;
  try {
    db = await openDatabase(dbPath);
    if (tableExists(db, "threads")) {
      if (selectedThreadIds.length === 0) {
        db.prepare("DELETE FROM threads").run();
      } else {
        const placeholders = selectedThreadIds.map(() => "?").join(", ");
        db.prepare(`DELETE FROM threads WHERE id NOT IN (${placeholders})`).run(...selectedThreadIds);
      }
    }
  } finally {
    db?.close();
  }

  for (const dbFile of dbFiles) {
    if (dbFile !== baseFile) {
      await fs.rm(resolveArchivePath(stagingDir, path.join("db", dbFile)), { force: true });
    }
  }
  return [baseFile];
}

export async function buildExportPreview(codexHome) {
  const rollouts = await collectRolloutInventory(codexHome);
  const localThreads = await readLocalThreads(codexHome);
  const rowsById = mapRowsById(localThreads.rows);
  const sortedRollouts = [...rollouts].sort((left, right) => (
    String(right.timestamp ?? "").localeCompare(String(left.timestamp ?? ""))
    || left.relativePath.localeCompare(right.relativePath)
  ));
  const conversations = [];
  for (let index = 0; index < sortedRollouts.length; index += 1) {
    const rollout = sortedRollouts[index];
    const sqlite = rollout.threadId ? rowsById.get(rollout.threadId) : null;
    const sqliteFirstUserMessage = sqlite?.first_user_message ?? "";
    const firstUserMessage = sqliteFirstUserMessage
      || await readRolloutFirstUserMessage(resolveArchivePath(codexHome, rollout.relativePath));
    conversations.push({
      index: index + 1,
      key: buildExportKey(rollout),
      threadId: rollout.threadId,
      scope: rollout.scope,
      title: sqlite?.title ?? rollout.title ?? "",
      provider: rollout.provider ?? sqlite?.model_provider ?? "(missing)",
      cwd: rollout.cwd ?? sqlite?.cwd ?? "",
      timestamp: rollout.timestamp
        ?? sqlite?.updated_at_ms
        ?? sqlite?.created_at_ms
        ?? "",
      firstUserMessage,
      relativePath: rollout.relativePath,
      size: rollout.size
    });
  }
  return conversations;
}

export async function readExportTranscript(codexHome, entry, { limit = DEFAULT_TRANSCRIPT_MESSAGE_LIMIT } = {}) {
  if (!entry?.relativePath) {
    throw new Error("Cannot read transcript because the selected conversation is missing rollout metadata.");
  }
  const filePath = resolveArchivePath(codexHome, entry.relativePath);
  const { messages, truncated } = await scanRolloutMessages(filePath, { limit });
  return {
    threadId: entry.threadId ?? null,
    title: entry.title ?? "",
    relativePath: entry.relativePath,
    scope: entry.scope,
    provider: entry.provider ?? "",
    cwd: entry.cwd ?? "",
    timestamp: entry.timestamp ?? "",
    messages,
    truncated
  };
}

export async function toggleExportConversationArchived(codexHome, entry) {
  if (!entry?.relativePath || !entry.scope) {
    throw new Error("Cannot toggle archive state because the selected conversation is missing rollout metadata.");
  }

  const nextScope = oppositeSessionScope(entry.scope);
  const nextRelativePath = replaceRelativePathScope(entry.relativePath, nextScope);
  const sourcePath = resolveArchivePath(codexHome, entry.relativePath);
  const destinationPath = resolveArchivePath(codexHome, nextRelativePath);

  if (await pathExists(destinationPath)) {
    throw new Error(`Cannot toggle archive state because target rollout already exists: ${nextRelativePath}`);
  }

  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  await fs.rename(sourcePath, destinationPath);
  let sqliteRowsUpdated = 0;
  try {
    sqliteRowsUpdated = await updateThreadArchivedFlag(codexHome, entry.threadId, nextScope === "archived_sessions");
  } catch (error) {
    try {
      await fs.mkdir(path.dirname(sourcePath), { recursive: true });
      await fs.rename(destinationPath, sourcePath);
    } catch (rollbackError) {
      const originalMessage = error instanceof Error ? error.message : String(error);
      const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
      throw new Error(
        `Failed to restore rollout after archive toggle error. Original error: ${originalMessage}. Restore error: ${rollbackMessage}`
      );
    }
    throw error;
  }

  const stat = await fs.stat(destinationPath);
  return {
    ...entry,
    scope: nextScope,
    relativePath: nextRelativePath,
    key: entry.threadId ? `thread:${entry.threadId}` : `path:${nextRelativePath}`,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    sqliteRowsUpdated
  };
}

export async function createHistoryArchive({
  codexHome,
  archivePath,
  overwrite = false,
  selectionKeys
}) {
  const resolvedArchivePath = path.resolve(archivePath);
  if (await pathExists(resolvedArchivePath)) {
    if (!overwrite) {
      throw new Error(`Archive already exists: ${resolvedArchivePath}. Use --overwrite to replace it.`);
    }
    await fs.rm(resolvedArchivePath, { force: true });
  }

  await fs.mkdir(path.dirname(resolvedArchivePath), { recursive: true });
  const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-history-export-"));
  try {
    const allRollouts = await collectRolloutInventory(codexHome);
    const selectedKeySet = selectionKeys ? new Set(selectionKeys) : null;
    const rollouts = selectedKeySet
      ? allRollouts.filter((rollout) => selectedKeySet.has(buildExportKey(rollout)))
      : allRollouts;
    if (selectedKeySet && rollouts.length === 0) {
      throw new Error("No conversations matched the selected export items.");
    }
    await copyRolloutsToStaging(codexHome, stagingDir, rollouts);
    const globalStateFiles = await copyGlobalStateToStaging(codexHome, stagingDir);
    const copiedDbFiles = await copyStateDbToStaging(codexHome, stagingDir);
    const dbFiles = await pruneStagedStateDb(
      stagingDir,
      copiedDbFiles,
      selectedKeySet ? selectedThreadIdsFromRollouts(rollouts) : null
    );
    const manifest = {
      version: HISTORY_VERSION,
      namespace: HISTORY_NAMESPACE,
      createdAt: new Date().toISOString(),
      codexHome,
      selected: Boolean(selectedKeySet),
      rollouts,
      dbFiles,
      globalStateFiles
    };
    await fs.writeFile(
      path.join(stagingDir, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8"
    );

    const stagedFiles = await listStagedFiles(stagingDir);
    await tar.create({
      gzip: true,
      file: resolvedArchivePath,
      cwd: stagingDir,
      portable: true
    }, stagedFiles);

    const stat = await fs.stat(resolvedArchivePath);
    return {
      archivePath: resolvedArchivePath,
      rolloutFiles: rollouts.length,
      dbFiles: dbFiles.length,
      globalStateFiles: globalStateFiles.length,
      selected: Boolean(selectedKeySet),
      bytes: stat.size
    };
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true });
  }
}

function validateManifest(manifest) {
  if (manifest?.namespace !== HISTORY_NAMESPACE || manifest.version !== HISTORY_VERSION) {
    throw new Error("Archive is not a supported codex-provider history export.");
  }
  if (!Array.isArray(manifest.rollouts) || !Array.isArray(manifest.dbFiles)) {
    throw new Error("History archive manifest is malformed.");
  }
  for (const rollout of manifest.rollouts) {
    rollout.relativePath = validateRelativePath(rollout.relativePath);
    if (!SESSION_DIRS.includes(rollout.scope)) {
      throw new Error(`Invalid rollout scope in history archive: ${rollout.scope}`);
    }
  }
  manifest.dbFiles = manifest.dbFiles.map(validateRelativePath);
  manifest.globalStateFiles = (manifest.globalStateFiles ?? []).map(validateRelativePath);
  return manifest;
}

export async function extractHistoryArchive(archivePath) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-history-import-"));
  try {
    await tar.extract({
      file: path.resolve(archivePath),
      cwd: tempDir,
      filter(entryPath) {
        const normalized = entryPath.replaceAll("\\", "/");
        return !normalized.startsWith("/") && !normalized.split("/").includes("..");
      }
    });
    const manifest = validateManifest(JSON.parse(await fs.readFile(path.join(tempDir, "manifest.json"), "utf8")));
    return {
      tempDir,
      manifest
    };
  } catch (error) {
    await fs.rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

export async function cleanupExtractedHistory(extracted) {
  if (extracted?.tempDir) {
    await fs.rm(extracted.tempDir, { recursive: true, force: true });
  }
}

function tableColumns(db, tableName) {
  return db
    .prepare(`PRAGMA table_info("${tableName.replaceAll("\"", "\"\"")}")`)
    .all()
    .map((column) => column.name);
}

function tableExists(db, tableName) {
  return Boolean(db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName));
}

function readThreadRows(db) {
  if (!tableExists(db, "threads")) {
    return { columns: [], rows: [] };
  }
  const columns = tableColumns(db, "threads");
  return {
    columns,
    rows: db.prepare("SELECT * FROM threads").all()
  };
}

function exportedDbBaseFile(manifest) {
  return manifest.dbFiles.find((fileName) => path.basename(fileName) === DB_FILE_BASENAME) ?? null;
}

function exportedDbPath(extracted) {
  const relativePath = exportedDbBaseFile(extracted.manifest);
  return relativePath ? resolveArchivePath(extracted.tempDir, path.join("db", relativePath)) : null;
}

async function readExportedThreads(extracted) {
  const dbPath = exportedDbPath(extracted);
  if (!dbPath || !await pathExists(dbPath)) {
    return { columns: [], rows: [] };
  }
  let db;
  try {
    db = await openDatabase(dbPath, { readOnly: true });
    return readThreadRows(db);
  } finally {
    db?.close();
  }
}

async function readLocalThreads(codexHome) {
  const dbPath = await existingStateDbPath(codexHome);
  if (!dbPath) {
    return { dbPath: null, columns: [], rows: [] };
  }
  let db;
  try {
    db = await openDatabase(dbPath, { readOnly: true });
    return { dbPath, ...readThreadRows(db) };
  } finally {
    db?.close();
  }
}

function mapByThreadId(entries) {
  const mapped = new Map();
  for (const entry of entries) {
    if (entry.threadId && !mapped.has(entry.threadId)) {
      mapped.set(entry.threadId, entry);
    }
  }
  return mapped;
}

function mapRowsById(rows) {
  const mapped = new Map();
  for (const row of rows) {
    if (typeof row.id === "string" && row.id) {
      mapped.set(row.id, row);
    }
  }
  return mapped;
}

function buildConflictKey(rollout) {
  return rollout.threadId ? `thread:${rollout.threadId}` : `path:${rollout.relativePath}`;
}

function conflictThreadIdFromKey(key) {
  return key.startsWith("thread:") ? key.slice("thread:".length) : null;
}

export async function buildImportPlan({ codexHome, extracted }) {
  const importedRollouts = extracted.manifest.rollouts;
  const localRollouts = await collectRolloutInventory(codexHome);
  const localByThreadId = mapByThreadId(localRollouts);
  const localByPath = new Map(localRollouts.map((entry) => [entry.relativePath, entry]));
  const exportedThreads = await readExportedThreads(extracted);
  const localThreads = await readLocalThreads(codexHome);
  const exportedRowsById = mapRowsById(exportedThreads.rows);
  const localRowsById = mapRowsById(localThreads.rows);
  const conflicts = new Map();

  for (const rollout of importedRollouts) {
    const localRollout =
      (rollout.threadId ? localByThreadId.get(rollout.threadId) : null)
      ?? localByPath.get(rollout.relativePath);
    if (!localRollout) {
      continue;
    }
    const key = buildConflictKey(rollout);
    conflicts.set(key, {
      key,
      threadId: rollout.threadId ?? null,
      imported: {
        rollout: summarizeRollout(rollout),
        sqlite: summarizeSqliteRow(exportedRowsById.get(rollout.threadId), exportedThreads.columns)
      },
      local: {
        rollout: summarizeRollout(localRollout),
        sqlite: summarizeSqliteRow(localRowsById.get(rollout.threadId), localThreads.columns)
      }
    });
  }

  for (const row of exportedThreads.rows) {
    if (typeof row.id !== "string" || !row.id || !localRowsById.has(row.id)) {
      continue;
    }
    const key = `thread:${row.id}`;
    if (conflicts.has(key)) {
      continue;
    }
    conflicts.set(key, {
      key,
      threadId: row.id,
      imported: {
        rollout: summarizeRollout(importedRollouts.find((rollout) => rollout.threadId === row.id)),
        sqlite: summarizeSqliteRow(row, exportedThreads.columns)
      },
      local: {
        rollout: summarizeRollout(localByThreadId.get(row.id)),
        sqlite: summarizeSqliteRow(localRowsById.get(row.id), localThreads.columns)
      }
    });
  }

  const conflictList = [...conflicts.values()].sort((left, right) => left.key.localeCompare(right.key));
  return {
    importedRollouts,
    localRollouts,
    exportedThreads,
    localThreads,
    conflicts: conflictList,
    newRolloutFiles: importedRollouts.filter((rollout) => !conflicts.has(buildConflictKey(rollout))).length,
    newSqliteRows: exportedThreads.rows.filter((row) => row.id && !localRowsById.has(row.id)).length
  };
}

export async function resolveImportConflicts({ plan, conflict = "ask", onConflict }) {
  const valid = new Set(["ask", "skip", "overwrite", "fail"]);
  if (!valid.has(conflict)) {
    throw new Error(`Invalid --conflict value: ${conflict}. Expected ask, skip, overwrite, or fail.`);
  }
  const decisions = new Map();
  if (plan.conflicts.length === 0) {
    return decisions;
  }
  if (conflict === "fail") {
    throw new Error(`History import found ${plan.conflicts.length} conflict(s). Rerun with --conflict ask, skip, or overwrite.`);
  }
  if (conflict === "skip" || conflict === "overwrite") {
    for (const item of plan.conflicts) {
      decisions.set(item.key, conflict);
    }
    return decisions;
  }
  if (typeof onConflict !== "function") {
    throw new Error(`History import found ${plan.conflicts.length} conflict(s), but no interactive conflict handler is available. Rerun with --conflict skip, overwrite, or fail.`);
  }

  let defaultDecision = null;
  for (const item of plan.conflicts) {
    const decision = defaultDecision ?? await onConflict(item);
    if (decision === "abort") {
      throw new Error("History import aborted by user.");
    }
    if (decision === "skipAll" || decision === "overwriteAll") {
      defaultDecision = decision === "skipAll" ? "skip" : "overwrite";
      decisions.set(item.key, defaultDecision);
      continue;
    }
    if (decision !== "skip" && decision !== "overwrite") {
      throw new Error(`Invalid conflict decision: ${decision}`);
    }
    decisions.set(item.key, decision);
  }
  return decisions;
}

function shouldSkipConflict(decisions, rollout) {
  return decisions.get(buildConflictKey(rollout)) === "skip";
}

function shouldOverwriteConflict(decisions, rollout) {
  return decisions.get(buildConflictKey(rollout)) === "overwrite";
}

export async function copyImportedRollouts({ codexHome, extracted, plan, decisions }) {
  const localByThreadId = mapByThreadId(plan.localRollouts);
  let copied = 0;
  let skipped = 0;
  let removedLocalConflicts = 0;
  for (const rollout of plan.importedRollouts) {
    if (shouldSkipConflict(decisions, rollout)) {
      skipped += 1;
      continue;
    }

    if (shouldOverwriteConflict(decisions, rollout) && rollout.threadId) {
      const localRollout = localByThreadId.get(rollout.threadId);
      if (localRollout && localRollout.relativePath !== rollout.relativePath) {
        await fs.rm(resolveArchivePath(codexHome, localRollout.relativePath), { force: true });
        removedLocalConflicts += 1;
      }
    }

    const sourcePath = resolveArchivePath(extracted.tempDir, rollout.relativePath);
    const destinationPath = resolveArchivePath(codexHome, rollout.relativePath);
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.copyFile(sourcePath, destinationPath);
    if (Number.isFinite(rollout.mtimeMs)) {
      const mtime = new Date(rollout.mtimeMs);
      await fs.utimes(destinationPath, mtime, mtime);
    }
    copied += 1;
  }
  return { copied, skipped, removedLocalConflicts };
}

function quotedIdentifier(identifier) {
  return `"${identifier.replaceAll("\"", "\"\"")}"`;
}

function updateRowProvider(row, targetProvider, columns) {
  if (columns.includes("model_provider")) {
    return {
      ...row,
      model_provider: targetProvider
    };
  }
  return row;
}

function decisionForThreadId(decisions, threadId) {
  return decisions.get(`thread:${threadId}`);
}

async function copyExportedDatabase({ codexHome, extracted }) {
  const baseFile = exportedDbBaseFile(extracted.manifest);
  if (!baseFile) {
    return { copied: false, copiedFiles: 0 };
  }
  const destinationBase = path.join(codexHome, baseFile);
  await fs.mkdir(path.dirname(destinationBase), { recursive: true });
  let copiedFiles = 0;
  for (const dbFile of extracted.manifest.dbFiles) {
    const sourcePath = resolveArchivePath(extracted.tempDir, path.join("db", dbFile));
    const destinationPath = resolveArchivePath(codexHome, dbFile);
    if (await pathExists(sourcePath)) {
      await fs.mkdir(path.dirname(destinationPath), { recursive: true });
      await fs.copyFile(sourcePath, destinationPath);
      copiedFiles += 1;
    }
  }
  return { copied: true, copiedFiles };
}

export async function mergeImportedSqliteThreads({ codexHome, extracted, plan, decisions, targetProvider }) {
  const exportedDb = exportedDbPath(extracted);
  if (!exportedDb || !await pathExists(exportedDb)) {
    return {
      databasePresent: false,
      databaseCopied: false,
      copiedDbFiles: 0,
      insertedRows: 0,
      updatedRows: 0,
      skippedRows: 0
    };
  }

  const destinationDb = await existingStateDbPath(codexHome);
  if (!destinationDb) {
    const copyResult = await copyExportedDatabase({ codexHome, extracted });
    return {
      databasePresent: true,
      databaseCopied: copyResult.copied,
      copiedDbFiles: copyResult.copiedFiles,
      insertedRows: plan.exportedThreads.rows.length,
      updatedRows: 0,
      skippedRows: 0
    };
  }

  const sourceRows = plan.exportedThreads.rows;
  if (sourceRows.length === 0) {
    return {
      databasePresent: true,
      databaseCopied: false,
      copiedDbFiles: 0,
      insertedRows: 0,
      updatedRows: 0,
      skippedRows: 0
    };
  }

  let db;
  try {
    db = await openDatabase(destinationDb);
    db.exec("BEGIN IMMEDIATE");
    const destinationColumns = tableColumns(db, "threads");
    const commonColumns = plan.exportedThreads.columns.filter((column) => destinationColumns.includes(column));
    if (!commonColumns.includes("id")) {
      throw new Error("Destination SQLite threads table does not have an id column.");
    }

    const existingStmt = db.prepare("SELECT id FROM threads WHERE id = ?");
    const insertSql = `INSERT INTO threads (${commonColumns.map(quotedIdentifier).join(", ")}) VALUES (${commonColumns.map(() => "?").join(", ")})`;
    const insertStmt = db.prepare(insertSql);
    const updateColumns = commonColumns.filter((column) => column !== "id");
    const updateStmt = updateColumns.length
      ? db.prepare(`UPDATE threads SET ${updateColumns.map((column) => `${quotedIdentifier(column)} = ?`).join(", ")} WHERE id = ?`)
      : null;

    let insertedRows = 0;
    let updatedRows = 0;
    let skippedRows = 0;
    for (const originalRow of sourceRows) {
      const threadId = originalRow.id;
      if (typeof threadId !== "string" || !threadId) {
        skippedRows += 1;
        continue;
      }
      const decision = decisionForThreadId(decisions, threadId);
      const exists = Boolean(existingStmt.get(threadId));
      if (exists && decision !== "overwrite") {
        skippedRows += 1;
        continue;
      }

      const row = updateRowProvider(originalRow, targetProvider, commonColumns);
      if (exists) {
        if (!updateStmt) {
          skippedRows += 1;
          continue;
        }
        updateStmt.run(...updateColumns.map((column) => row[column] ?? null), threadId);
        updatedRows += 1;
      } else {
        insertStmt.run(...commonColumns.map((column) => row[column] ?? null));
        insertedRows += 1;
      }
    }
    db.exec("COMMIT");
    return {
      databasePresent: true,
      databaseCopied: false,
      copiedDbFiles: 0,
      insertedRows,
      updatedRows,
      skippedRows
    };
  } catch (error) {
    try {
      db?.exec("ROLLBACK");
    } catch {
      // Ignore rollback failures and surface the original merge error.
    }
    throw error;
  } finally {
    db?.close();
  }
}

export function summarizeImportPlan(plan) {
  return {
    archiveRolloutFiles: plan.importedRollouts.length,
    archiveSqliteRows: plan.exportedThreads.rows.length,
    newRolloutFiles: plan.newRolloutFiles,
    newSqliteRows: plan.newSqliteRows,
    conflicts: plan.conflicts.length
  };
}
