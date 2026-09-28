import fs from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_BACKUP_RETENTION_COUNT,
  DEFAULT_PROVIDER
} from "./constants.js";
import {
  configDeclaresProvider,
  listConfiguredProviderIds,
  readConfigText,
  readCurrentProviderFromConfigText
} from "./config-file.js";
import { createBackup, pruneBackups, updateSessionBackupManifest } from "./backup.js";
import { acquireLock } from "./locking.js";
import {
  applySessionChanges,
  collectSessionChanges,
  splitLockedSessionChanges
} from "./session-files.js";
import { assertSqliteWritable, updateSqliteProvider } from "./sqlite-state.js";
import { readThreadCwdStats, syncWorkspaceRoots } from "./workspace-roots.js";
import {
  buildExportPreview,
  buildImportPlan,
  cleanupExtractedHistory,
  copyImportedRollouts,
  createHistoryArchive,
  extractHistoryArchive,
  mergeImportedSqliteThreads,
  readExportTranscript,
  resolveImportConflicts,
  summarizeImportPlan,
  toggleExportConversationArchived
} from "./history-transfer.js";
import {
  ensureCodexHome,
  normalizeCodexHome,
  resolveStorageLayout
} from "./storage-layout.js";

function emitProgress(onProgress, event) {
  onProgress?.(event);
}

function pathComparisonKey(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function ensureCodexHomePath(codexHome) {
  await ensureCodexHome(resolveStorageLayout({ codexHome, env: {} }));
}

async function readConfigTextOrEmpty(configPath) {
  try {
    return await readConfigText(configPath);
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

async function filterChangesCoveredByBackup(backupDir, changes) {
  if (!changes.length) return [];
  const manifestPath = path.join(backupDir, "session-meta-backup.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const backedUpPaths = new Set(
    (manifest.files ?? []).map((entry) => pathComparisonKey(entry.path))
  );
  return changes.filter((change) => backedUpPaths.has(pathComparisonKey(change.path)));
}

function formatLocalTimestampForFileName(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "_",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join("");
}

export function defaultHistoryArchivePath(date = new Date()) {
  return path.resolve(process.cwd(), `codex-history_${formatLocalTimestampForFileName(date)}.tgz`);
}

export function parseExportThreadIds(rawValue) {
  if (rawValue === undefined) return null;
  if (rawValue === true) {
    throw new Error("Missing --ids value. Expected comma-separated thread ids.");
  }
  const ids = String(rawValue).split(",").map((value) => value.trim()).filter(Boolean);
  if (ids.length === 0) {
    throw new Error("Missing --ids value. Expected comma-separated thread ids.");
  }
  return ids;
}

export async function runExportHistory({
  codexHome: explicitCodexHome,
  archivePath,
  overwrite = false,
  selectionKeys,
  threadIds,
  onProgress
} = {}) {
  const codexHome = normalizeCodexHome(explicitCodexHome);
  const resolvedArchivePath = archivePath ? path.resolve(archivePath) : defaultHistoryArchivePath();
  await ensureCodexHomePath(codexHome);
  let resolvedSelectionKeys = selectionKeys ?? null;
  if (!resolvedSelectionKeys && threadIds?.length) {
    const preview = await buildExportPreview(codexHome);
    const requestedIds = new Set(threadIds);
    const matched = preview.filter((entry) => entry.threadId && requestedIds.has(entry.threadId));
    const matchedIds = new Set(matched.map((entry) => entry.threadId));
    const missingIds = [...requestedIds].filter((threadId) => !matchedIds.has(threadId));
    if (missingIds.length > 0) {
      throw new Error(`No exportable conversation found for thread id(s): ${missingIds.join(", ")}`);
    }
    resolvedSelectionKeys = matched.map((entry) => entry.key);
  }
  const releaseLock = await acquireLock(codexHome, "export-history");
  try {
    emitProgress(onProgress, { stage: "create_history_archive", status: "start" });
    const result = await createHistoryArchive({
      codexHome,
      archivePath: resolvedArchivePath,
      overwrite,
      selectionKeys: resolvedSelectionKeys
    });
    emitProgress(onProgress, { stage: "create_history_archive", status: "complete", archivePath: result.archivePath });
    return { codexHome, ...result };
  } finally {
    await releaseLock();
  }
}

export async function getExportHistoryPreview({ codexHome: explicitCodexHome } = {}) {
  const codexHome = normalizeCodexHome(explicitCodexHome);
  await ensureCodexHomePath(codexHome);
  return { codexHome, conversations: await buildExportPreview(codexHome) };
}

export async function toggleExportHistoryArchived({ codexHome: explicitCodexHome, entry } = {}) {
  const codexHome = normalizeCodexHome(explicitCodexHome);
  await ensureCodexHomePath(codexHome);
  const releaseLock = await acquireLock(codexHome, "toggle-history-archive");
  try {
    return await toggleExportConversationArchived(codexHome, entry);
  } finally {
    await releaseLock();
  }
}

export async function getExportHistoryTranscript({ codexHome: explicitCodexHome, entry, limit } = {}) {
  const codexHome = normalizeCodexHome(explicitCodexHome);
  await ensureCodexHomePath(codexHome);
  return readExportTranscript(codexHome, entry, { limit });
}

async function syncProviderMetadataAfterImport({
  codexHome,
  targetProvider,
  backupDir,
  sqliteBusyTimeoutMs,
  onProgress
}) {
  emitProgress(onProgress, { stage: "scan_imported_history", status: "start" });
  const {
    changes,
    lockedPaths: lockedReadPaths,
    userEventThreadIds,
    threadCwdById
  } = await collectSessionChanges(codexHome, targetProvider, { skipLockedReads: true });
  emitProgress(onProgress, {
    stage: "scan_imported_history",
    status: "complete",
    scannedChanges: changes.length,
    lockedReadCount: lockedReadPaths.length
  });

  const cwdStats = await readThreadCwdStats(codexHome);
  const { writableChanges, lockedChanges } = await splitLockedSessionChanges(changes);
  let applyResult = { appliedChanges: 0, appliedPaths: [], skippedPaths: [] };
  let workspaceRootResult = { updatedWorkspaceRoots: 0, savedWorkspaceRootCount: 0 };

  emitProgress(onProgress, { stage: "sync_imported_metadata", status: "start" });
  const sqliteResult = await updateSqliteProvider(
    codexHome,
    targetProvider,
    async () => {
      if (writableChanges.length > 0) {
        applyResult = await applySessionChanges(writableChanges);
        const appliedPathSet = new Set(applyResult.appliedPaths ?? []);
        const appliedSessionChanges = writableChanges.filter((change) => appliedPathSet.has(change.path));
        const backedUpSessionChanges = await filterChangesCoveredByBackup(backupDir, appliedSessionChanges);
        await updateSessionBackupManifest(backupDir, backedUpSessionChanges);
      }
      workspaceRootResult = await syncWorkspaceRoots(codexHome, { cwdStats });
    },
    { busyTimeoutMs: sqliteBusyTimeoutMs, userEventThreadIds, threadCwdById }
  );
  emitProgress(onProgress, {
    stage: "sync_imported_metadata",
    status: "complete",
    updatedRows: sqliteResult.updatedRows,
    appliedChanges: applyResult.appliedChanges
  });

  return {
    changedSessionFiles: applyResult.appliedChanges,
    skippedLockedRolloutFiles: [...new Set([
      ...lockedReadPaths,
      ...lockedChanges.map((change) => change.path),
      ...applyResult.skippedPaths
    ])].sort((left, right) => left.localeCompare(right)),
    sqliteRowsUpdated: sqliteResult.updatedRows,
    sqliteProviderRowsUpdated: sqliteResult.providerRowsUpdated,
    sqliteUserEventRowsUpdated: sqliteResult.userEventRowsUpdated,
    sqliteCwdRowsUpdated: sqliteResult.cwdRowsUpdated,
    updatedWorkspaceRoots: workspaceRootResult.updatedWorkspaceRoots,
    savedWorkspaceRootCount: workspaceRootResult.savedWorkspaceRootCount,
    sqlitePresent: sqliteResult.databasePresent
  };
}

export async function runImportHistory({
  codexHome: explicitCodexHome,
  archivePath,
  provider,
  conflict = "ask",
  dryRun = false,
  keepCount = DEFAULT_BACKUP_RETENTION_COUNT,
  sqliteBusyTimeoutMs,
  onConflict,
  onProgress
} = {}) {
  if (!archivePath) {
    throw new Error("Missing archive path. Usage: codex-provider import <archive-path>");
  }
  if (!Number.isInteger(keepCount) || keepCount < 1) {
    throw new Error(`Invalid automatic keep count: ${keepCount}. Expected an integer greater than or equal to 1.`);
  }

  const codexHome = normalizeCodexHome(explicitCodexHome);
  await ensureCodexHomePath(codexHome);
  const configPath = path.join(codexHome, "config.toml");
  const configText = await readConfigTextOrEmpty(configPath);
  const current = readCurrentProviderFromConfigText(configText);
  const targetProvider = provider ?? current.provider ?? DEFAULT_PROVIDER;
  if (provider && !configDeclaresProvider(configText, provider)) {
    throw new Error(`Provider "${provider}" is not available in config.toml. Configure it first or use one of: ${listConfiguredProviderIds(configText).join(", ")}`);
  }

  const releaseLock = await acquireLock(codexHome, "import-history");
  let extracted = null;
  try {
    emitProgress(onProgress, { stage: "extract_history_archive", status: "start" });
    extracted = await extractHistoryArchive(archivePath);
    emitProgress(onProgress, { stage: "extract_history_archive", status: "complete" });

    emitProgress(onProgress, { stage: "plan_history_import", status: "start" });
    const plan = await buildImportPlan({ codexHome, extracted });
    const planSummary = summarizeImportPlan(plan);
    emitProgress(onProgress, { stage: "plan_history_import", status: "complete", ...planSummary });

    const decisions = await resolveImportConflicts({ plan, conflict, onConflict });
    if (dryRun) {
      return {
        codexHome,
        archivePath: path.resolve(archivePath),
        targetProvider,
        dryRun: true,
        backupDir: null,
        plan: planSummary,
        importedRolloutFiles: 0,
        skippedRolloutFiles: plan.conflicts.filter((item) => decisions.get(item.key) === "skip").length,
        sqliteRowsInserted: 0,
        sqliteRowsUpdatedByImport: 0,
        sqliteRowsSkipped: 0,
        changedSessionFiles: 0,
        skippedLockedRolloutFiles: [],
        sqliteRowsUpdated: 0,
        sqlitePresent: Boolean(plan.localThreads.dbPath)
      };
    }

    emitProgress(onProgress, { stage: "check_import_targets", status: "start" });
    await assertSqliteWritable(codexHome, { busyTimeoutMs: sqliteBusyTimeoutMs });
    emitProgress(onProgress, { stage: "check_import_targets", status: "complete" });

    emitProgress(onProgress, { stage: "create_backup", status: "start" });
    const backupStartedAt = Date.now();
    const backupDir = await createBackup({
      codexHome,
      targetProvider,
      sessionChanges: [],
      configPath
    });
    const backupDurationMs = Date.now() - backupStartedAt;
    emitProgress(onProgress, { stage: "create_backup", status: "complete", backupDir, durationMs: backupDurationMs });

    emitProgress(onProgress, { stage: "copy_history_rollouts", status: "start" });
    const rolloutResult = await copyImportedRollouts({ codexHome, extracted, plan, decisions });
    emitProgress(onProgress, { stage: "copy_history_rollouts", status: "complete", copied: rolloutResult.copied });

    emitProgress(onProgress, { stage: "merge_history_sqlite", status: "start" });
    const sqliteMergeResult = await mergeImportedSqliteThreads({
      codexHome,
      extracted,
      plan,
      decisions,
      targetProvider
    });
    emitProgress(onProgress, {
      stage: "merge_history_sqlite",
      status: "complete",
      insertedRows: sqliteMergeResult.insertedRows,
      updatedRows: sqliteMergeResult.updatedRows
    });

    const syncResult = await syncProviderMetadataAfterImport({
      codexHome,
      targetProvider,
      backupDir,
      sqliteBusyTimeoutMs,
      onProgress
    });

    let autoPruneResult = null;
    let autoPruneWarning = null;
    emitProgress(onProgress, { stage: "clean_backups", status: "start", keepCount });
    try {
      autoPruneResult = await pruneBackups(codexHome, keepCount);
    } catch (pruneError) {
      autoPruneWarning = `Automatic backup cleanup failed: ${pruneError instanceof Error ? pruneError.message : String(pruneError)}`;
    }
    emitProgress(onProgress, {
      stage: "clean_backups",
      status: "complete",
      deletedCount: autoPruneResult?.deletedCount ?? 0,
      warning: autoPruneWarning
    });

    return {
      codexHome,
      archivePath: path.resolve(archivePath),
      targetProvider,
      dryRun: false,
      backupDir,
      backupDurationMs,
      plan: planSummary,
      importedRolloutFiles: rolloutResult.copied,
      skippedRolloutFiles: rolloutResult.skipped,
      removedLocalConflictRolloutFiles: rolloutResult.removedLocalConflicts,
      sqliteRowsInserted: sqliteMergeResult.insertedRows,
      sqliteRowsUpdatedByImport: sqliteMergeResult.updatedRows,
      sqliteRowsSkipped: sqliteMergeResult.skippedRows,
      sqliteDatabaseCopied: sqliteMergeResult.databaseCopied,
      copiedDbFiles: sqliteMergeResult.copiedDbFiles,
      ...syncResult,
      autoPruneResult,
      autoPruneWarning
    };
  } finally {
    await cleanupExtractedHistory(extracted);
    await releaseLock();
  }
}
