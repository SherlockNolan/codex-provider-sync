import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  getExportHistoryPreview,
  runExportHistory,
  runImportHistory
} from "../src/service.js";
import {
  DB_FILE_BASENAME,
  SQLITE_DIR_BASENAME
} from "../src/constants.js";
import { openDatabase } from "../src/sqlite.js";

async function makeTempCodexHome() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-provider-history-"));
  const codexHome = path.join(root, ".codex");
  await fs.mkdir(codexHome, { recursive: true });
  return { root, codexHome };
}

async function writeConfig(codexHome, modelProviderLine = 'model_provider = "openai"') {
  const config = `${modelProviderLine}\n\n[model_providers.apigather]\nbase_url = "https://example.com"\n`;
  await fs.writeFile(path.join(codexHome, "config.toml"), config, "utf8");
}

async function writeRollout(codexHome, scope, day, id, provider, message, cwd = "C:\\AITemp") {
  const dir = path.join(codexHome, scope, "2026", "03", day);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `rollout-${id}.jsonl`);
  const timestamp = `2026-03-${day}T00:00:00.000Z`;
  const payload = {
    id,
    timestamp,
    cwd,
    source: "cli",
    cli_version: "0.115.0",
    model_provider: provider
  };
  await fs.writeFile(
    filePath,
    [
      JSON.stringify({ timestamp, type: "session_meta", payload }),
      JSON.stringify({ timestamp, type: "event_msg", payload: { type: "user_message", message } })
    ].join("\n") + "\n",
    "utf8"
  );
  return filePath;
}

function stateDbPath(codexHome) {
  return path.join(codexHome, SQLITE_DIR_BASENAME, DB_FILE_BASENAME);
}

async function writeStateDb(codexHome, rows) {
  const dbPath = stateDbPath(codexHome);
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const db = await openDatabase(dbPath);
  try {
    db.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        model_provider TEXT,
        cwd TEXT NOT NULL DEFAULT '',
        archived INTEGER NOT NULL DEFAULT 0,
        has_user_event INTEGER NOT NULL DEFAULT 0,
        first_user_message TEXT NOT NULL DEFAULT '',
        updated_at_ms INTEGER NOT NULL DEFAULT 0
      )
    `);
    const stmt = db.prepare("INSERT INTO threads (id, model_provider, cwd, archived, has_user_event, first_user_message, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const row of rows) {
      stmt.run(
        row.id,
        row.model_provider,
        row.cwd ?? "C:\\AITemp",
        row.archived ? 1 : 0,
        row.has_user_event ? 1 : 0,
        row.first_user_message ?? "hello",
        row.updated_at_ms ?? 1
      );
    }
  } finally {
    db.close();
  }
}

async function readThreadRows(codexHome) {
  const db = await openDatabase(stateDbPath(codexHome));
  try {
    return db
      .prepare("SELECT id, model_provider, archived, first_user_message FROM threads ORDER BY id")
      .all()
      .map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}

async function runCli(args, cwd) {
  const cliPath = path.resolve("src", "cli.js");
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

test("runExportHistory creates an archive with active, archived, and SQLite history", async () => {
  const { root, codexHome } = await makeTempCodexHome();
  await writeConfig(codexHome);
  await writeRollout(codexHome, "sessions", "19", "thread-a", "apigather", "active");
  await writeRollout(codexHome, "archived_sessions", "18", "thread-b", "apigather", "archived");
  await writeStateDb(codexHome, [
    { id: "thread-a", model_provider: "apigather", archived: false },
    { id: "thread-b", model_provider: "apigather", archived: true }
  ]);
  const archivePath = path.join(root, "history.tgz");

  const result = await runExportHistory({ codexHome, archivePath });

  assert.equal(result.rolloutFiles, 2);
  assert.equal(result.dbFiles, 1);
  assert.ok(result.bytes > 0);
  await fs.access(archivePath);
  await assert.rejects(
    () => runExportHistory({ codexHome, archivePath }),
    /Archive already exists/
  );
});

test("cli export defaults to a dated archive in the current terminal directory", async () => {
  const { root, codexHome } = await makeTempCodexHome();
  await writeConfig(codexHome);
  await writeRollout(codexHome, "sessions", "19", "thread-default", "openai", "default archive");
  await writeStateDb(codexHome, [
    { id: "thread-default", model_provider: "openai", archived: false }
  ]);

  const result = await runCli(["export", "--codex-home", codexHome], root);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Exported history archive:/);
  const archiveNames = (await fs.readdir(root))
    .filter((name) => /^codex-history_\d{8}_\d{6}\.tgz$/.test(name));
  assert.equal(archiveNames.length, 1);
  await fs.access(path.join(root, archiveNames[0]));
});

test("selected export includes only chosen conversations and merges them incrementally", async () => {
  const { root, codexHome: sourceHome } = await makeTempCodexHome();
  await writeConfig(sourceHome, 'model_provider = "openai"');
  await writeRollout(sourceHome, "sessions", "19", "thread-a", "openai", "source a");
  await writeRollout(sourceHome, "sessions", "20", "thread-b", "openai", "source b");
  await writeRollout(sourceHome, "archived_sessions", "21", "thread-c", "openai", "source c");
  await writeStateDb(sourceHome, [
    { id: "thread-a", model_provider: "openai", first_user_message: "source sqlite a" },
    { id: "thread-b", model_provider: "openai", first_user_message: "source sqlite b" },
    { id: "thread-c", model_provider: "openai", archived: true, first_user_message: "source sqlite c" }
  ]);

  const preview = await getExportHistoryPreview({ codexHome: sourceHome });
  assert.equal(preview.conversations.length, 3);
  const archivePath = path.join(root, "selected.tgz");
  const exportResult = await runExportHistory({
    codexHome: sourceHome,
    archivePath,
    threadIds: ["thread-b"]
  });
  assert.equal(exportResult.selected, true);
  assert.equal(exportResult.rolloutFiles, 1);

  const { codexHome: targetHome } = await makeTempCodexHome();
  await writeConfig(targetHome, 'model_provider = "openai"');
  await writeRollout(targetHome, "sessions", "18", "thread-local", "openai", "local");
  await writeStateDb(targetHome, [
    { id: "thread-local", model_provider: "openai", first_user_message: "local sqlite" }
  ]);

  const importResult = await runImportHistory({
    codexHome: targetHome,
    archivePath,
    conflict: "fail"
  });

  assert.equal(importResult.plan.archiveRolloutFiles, 1);
  assert.equal(importResult.plan.archiveSqliteRows, 1);
  assert.equal(importResult.sqliteRowsInserted, 1);
  assert.deepEqual(await readThreadRows(targetHome), [
    { id: "thread-b", model_provider: "openai", archived: 0, first_user_message: "source sqlite b" },
    { id: "thread-local", model_provider: "openai", archived: 0, first_user_message: "local sqlite" }
  ]);
  await fs.access(path.join(targetHome, "sessions", "2026", "03", "20", "rollout-thread-b.jsonl"));
  await assert.rejects(fs.access(path.join(targetHome, "sessions", "2026", "03", "19", "rollout-thread-a.jsonl")));
  await assert.rejects(fs.access(path.join(targetHome, "archived_sessions", "2026", "03", "21", "rollout-thread-c.jsonl")));
});

test("runImportHistory imports into a Codex home without SQLite and rewrites provider to current provider", async () => {
  const { root, codexHome: sourceHome } = await makeTempCodexHome();
  await writeConfig(sourceHome, 'model_provider = "apigather"');
  const sourceRollout = await writeRollout(sourceHome, "sessions", "19", "thread-a", "apigather", "source message");
  await writeStateDb(sourceHome, [
    { id: "thread-a", model_provider: "apigather", archived: false, first_user_message: "source sqlite" }
  ]);
  const archivePath = path.join(root, "history.tgz");
  await runExportHistory({ codexHome: sourceHome, archivePath });

  const { codexHome: targetHome } = await makeTempCodexHome();
  await writeConfig(targetHome, 'model_provider = "openai"');
  const result = await runImportHistory({ codexHome: targetHome, archivePath, conflict: "fail" });

  assert.equal(result.importedRolloutFiles, 1);
  assert.equal(result.sqliteDatabaseCopied, true);
  const importedRolloutPath = path.join(targetHome, path.relative(sourceHome, sourceRollout));
  const rolloutText = await fs.readFile(importedRolloutPath, "utf8");
  assert.match(rolloutText, /"model_provider":"openai"/);
  assert.match(rolloutText, /source message/);
  assert.deepEqual(await readThreadRows(targetHome), [
    { id: "thread-a", model_provider: "openai", archived: 0, first_user_message: "source sqlite" }
  ]);
});

test("runImportHistory inserts non-conflicting SQLite rows and supports provider override", async () => {
  const { root, codexHome: sourceHome } = await makeTempCodexHome();
  await writeConfig(sourceHome, 'model_provider = "openai"');
  await writeRollout(sourceHome, "sessions", "19", "thread-source", "openai", "source");
  await writeStateDb(sourceHome, [
    { id: "thread-source", model_provider: "openai", first_user_message: "source sqlite" }
  ]);
  const archivePath = path.join(root, "history.tgz");
  await runExportHistory({ codexHome: sourceHome, archivePath });

  const { codexHome: targetHome } = await makeTempCodexHome();
  await writeConfig(targetHome, 'model_provider = "openai"');
  await writeRollout(targetHome, "sessions", "20", "thread-local", "openai", "local");
  await writeStateDb(targetHome, [
    { id: "thread-local", model_provider: "openai", first_user_message: "local sqlite" }
  ]);

  const result = await runImportHistory({
    codexHome: targetHome,
    archivePath,
    provider: "apigather",
    conflict: "fail"
  });

  assert.equal(result.sqliteRowsInserted, 1);
  assert.deepEqual(await readThreadRows(targetHome), [
    { id: "thread-local", model_provider: "apigather", archived: 0, first_user_message: "local sqlite" },
    { id: "thread-source", model_provider: "apigather", archived: 0, first_user_message: "source sqlite" }
  ]);
});

test("runImportHistory handles conflicts with skip, overwrite, fail, and ask callback", async () => {
  const { root, codexHome: sourceHome } = await makeTempCodexHome();
  await writeConfig(sourceHome, 'model_provider = "apigather"');
  await writeRollout(sourceHome, "sessions", "19", "thread-conflict", "apigather", "source message");
  await writeStateDb(sourceHome, [
    { id: "thread-conflict", model_provider: "apigather", first_user_message: "source sqlite" }
  ]);
  const archivePath = path.join(root, "history.tgz");
  await runExportHistory({ codexHome: sourceHome, archivePath });

  const { codexHome: skipHome } = await makeTempCodexHome();
  await writeConfig(skipHome, 'model_provider = "openai"');
  const skipRollout = await writeRollout(skipHome, "sessions", "19", "thread-conflict", "openai", "local message");
  await writeStateDb(skipHome, [
    { id: "thread-conflict", model_provider: "openai", first_user_message: "local sqlite" }
  ]);
  const skipResult = await runImportHistory({ codexHome: skipHome, archivePath, conflict: "skip" });
  assert.equal(skipResult.plan.conflicts, 1);
  assert.match(await fs.readFile(skipRollout, "utf8"), /local message/);
  assert.deepEqual(await readThreadRows(skipHome), [
    { id: "thread-conflict", model_provider: "openai", archived: 0, first_user_message: "local sqlite" }
  ]);

  const { codexHome: overwriteHome } = await makeTempCodexHome();
  await writeConfig(overwriteHome, 'model_provider = "openai"');
  const overwriteRollout = await writeRollout(overwriteHome, "sessions", "19", "thread-conflict", "openai", "local message");
  await writeStateDb(overwriteHome, [
    { id: "thread-conflict", model_provider: "openai", first_user_message: "local sqlite" }
  ]);
  const overwriteResult = await runImportHistory({ codexHome: overwriteHome, archivePath, conflict: "overwrite" });
  assert.equal(overwriteResult.sqliteRowsUpdatedByImport, 1);
  assert.match(await fs.readFile(overwriteRollout, "utf8"), /source message/);
  assert.deepEqual(await readThreadRows(overwriteHome), [
    { id: "thread-conflict", model_provider: "openai", archived: 0, first_user_message: "source sqlite" }
  ]);

  const { codexHome: failHome } = await makeTempCodexHome();
  await writeConfig(failHome, 'model_provider = "openai"');
  await writeRollout(failHome, "sessions", "19", "thread-conflict", "openai", "local message");
  await writeStateDb(failHome, [
    { id: "thread-conflict", model_provider: "openai", first_user_message: "local sqlite" }
  ]);
  await assert.rejects(
    () => runImportHistory({ codexHome: failHome, archivePath, conflict: "fail" }),
    /found 1 conflict/
  );

  const { codexHome: askHome } = await makeTempCodexHome();
  await writeConfig(askHome, 'model_provider = "openai"');
  const askRollout = await writeRollout(askHome, "sessions", "19", "thread-conflict", "openai", "local message");
  await writeStateDb(askHome, [
    { id: "thread-conflict", model_provider: "openai", first_user_message: "local sqlite" }
  ]);
  const decisions = [];
  await runImportHistory({
    codexHome: askHome,
    archivePath,
    conflict: "ask",
    onConflict(conflict) {
      decisions.push(conflict.threadId);
      return "overwriteAll";
    }
  });
  assert.deepEqual(decisions, ["thread-conflict"]);
  assert.match(await fs.readFile(askRollout, "utf8"), /source message/);
});

test("runImportHistory dry-run reports the plan without writing files", async () => {
  const { root, codexHome: sourceHome } = await makeTempCodexHome();
  await writeConfig(sourceHome);
  await writeRollout(sourceHome, "sessions", "19", "thread-dry", "openai", "source");
  await writeStateDb(sourceHome, [
    { id: "thread-dry", model_provider: "openai", first_user_message: "source sqlite" }
  ]);
  const archivePath = path.join(root, "history.tgz");
  await runExportHistory({ codexHome: sourceHome, archivePath });

  const { codexHome: targetHome } = await makeTempCodexHome();
  await writeConfig(targetHome);
  const result = await runImportHistory({
    codexHome: targetHome,
    archivePath,
    conflict: "fail",
    dryRun: true
  });

  assert.equal(result.dryRun, true);
  assert.equal(result.plan.newRolloutFiles, 1);
  await assert.rejects(fs.access(path.join(targetHome, "sessions", "2026", "03", "19", "rollout-thread-dry.jsonl")));
  await assert.rejects(fs.access(stateDbPath(targetHome)));
});
