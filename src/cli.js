#!/usr/bin/env node

import path from "node:path";
import readline from "node:readline";

import { DEFAULT_BACKUP_RETENTION_COUNT } from "./constants.js";
import { installWindowsLauncher } from "./launcher.js";
import { assertSupportedNodeVersion } from "./node-version.js";

async function loadService() {
  assertSupportedNodeVersion();
  return import("./service.js");
}

function printHelp() {
  console.log(`codex-provider

Usage:
  codex-provider status [--codex-home PATH]
  codex-provider sync [--provider ID] [--keep N] [--codex-home PATH]
  codex-provider switch <provider-id> [--keep N] [--codex-home PATH]
  codex-provider export [archive-path] [--overwrite] [--codex-home PATH]
  codex-provider import <archive-path> [--provider ID] [--conflict ask|skip|overwrite|fail] [--dry-run] [--keep N] [--codex-home PATH]
  codex-provider prune-backups [--keep N] [--codex-home PATH]
  codex-provider restore <backup-dir> [--no-config] [--no-db] [--no-sessions] [--codex-home PATH]
  codex-provider install-windows-launcher [--dir PATH] [--codex-home PATH]
`);
}

function parseArgs(argv) {
  const positionals = [];
  const flags = {};

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    const [flagName, inlineValue] = value.split("=", 2);
    const normalizedName = flagName.slice(2);
    if (inlineValue !== undefined) {
      flags[normalizedName] = inlineValue;
      continue;
    }
    const nextValue = argv[index + 1];
    if (nextValue && !nextValue.startsWith("--")) {
      flags[normalizedName] = nextValue;
      index += 1;
    } else {
      flags[normalizedName] = true;
    }
  }

  return { positionals, flags };
}

function summarizeSync(result, label) {
  const lines = [
    `${label} provider: ${result.targetProvider}`,
    `Codex home: ${result.codexHome}`,
    `Backup: ${result.backupDir}`,
    `Backup creation time: ${formatDuration(result.backupDurationMs ?? 0)}`,
    `Updated rollout files: ${result.changedSessionFiles}`,
    `Updated SQLite rows: ${result.sqliteRowsUpdated}${result.sqlitePresent ? "" : " (state_5.sqlite not found)"}`
  ];
  if (result.sqliteUserEventRowsUpdated) {
    lines.push(`Updated SQLite user-event flags: ${result.sqliteUserEventRowsUpdated}`);
  }
  if (result.sqliteCwdRowsUpdated) {
    lines.push(`Updated SQLite cwd paths: ${result.sqliteCwdRowsUpdated}`);
  }
  if (result.updatedWorkspaceRoots) {
    lines.push(`Updated workspace roots: ${result.updatedWorkspaceRoots}`);
  }
  if (result.skippedLockedRolloutFiles?.length) {
    const preview = result.skippedLockedRolloutFiles.slice(0, 5).join(", ");
    const extraCount = result.skippedLockedRolloutFiles.length - Math.min(result.skippedLockedRolloutFiles.length, 5);
    lines.push(`Skipped locked rollout files: ${result.skippedLockedRolloutFiles.length}`);
    lines.push(`Locked file(s): ${preview}${extraCount > 0 ? ` (+${extraCount} more)` : ""}`);
  }
  if (result.encryptedContentWarning) {
    lines.push(result.encryptedContentWarning);
  }
  if (result.autoPruneResult) {
    lines.push(
      `Backup cleanup: deleted ${result.autoPruneResult.deletedCount}, remaining ${result.autoPruneResult.remainingCount}, freed ${formatBytes(result.autoPruneResult.freedBytes)}`
    );
  }
  if (result.autoPruneWarning) {
    lines.push(`Backup cleanup warning: ${result.autoPruneWarning}`);
  }
  return lines.join("\n");
}

function summarizePrune(result) {
  return [
    `Backup root: ${result.backupRoot}`,
    `Deleted backups: ${result.deletedCount}`,
    `Remaining backups: ${result.remainingCount}`,
    `Freed space: ${formatBytes(result.freedBytes)}`
  ].join("\n");
}

function summarizeExport(result) {
  return [
    `Exported history archive: ${result.archivePath}`,
    `Codex home: ${result.codexHome}`,
    `Rollout files: ${result.rolloutFiles}`,
    `SQLite files: ${result.dbFiles}`,
    `Global state files: ${result.globalStateFiles}`,
    `Archive size: ${formatBytes(result.bytes)}`
  ].join("\n");
}

function summarizeImport(result) {
  const lines = [
    `${result.dryRun ? "Planned" : "Imported"} history archive: ${result.archivePath}`,
    `Codex home: ${result.codexHome}`,
    `Target provider: ${result.targetProvider}`,
    `Archive rollout files: ${result.plan.archiveRolloutFiles}`,
    `Archive SQLite rows: ${result.plan.archiveSqliteRows}`,
    `Conflicts: ${result.plan.conflicts}`
  ];
  if (result.dryRun) {
    lines.push(`New rollout files: ${result.plan.newRolloutFiles}`);
    lines.push(`New SQLite rows: ${result.plan.newSqliteRows}`);
    lines.push(`Skipped rollout conflicts: ${result.skippedRolloutFiles}`);
    return lines.join("\n");
  }

  lines.push(`Backup: ${result.backupDir}`);
  lines.push(`Backup creation time: ${formatDuration(result.backupDurationMs ?? 0)}`);
  lines.push(`Imported rollout files: ${result.importedRolloutFiles}`);
  lines.push(`Skipped rollout files: ${result.skippedRolloutFiles}`);
  if (result.removedLocalConflictRolloutFiles) {
    lines.push(`Removed replaced local rollout files: ${result.removedLocalConflictRolloutFiles}`);
  }
  if (result.sqliteDatabaseCopied) {
    lines.push(`Copied SQLite database files: ${result.copiedDbFiles}`);
  }
  lines.push(`Inserted SQLite rows: ${result.sqliteRowsInserted}`);
  lines.push(`Overwritten SQLite rows: ${result.sqliteRowsUpdatedByImport}`);
  lines.push(`Skipped SQLite rows: ${result.sqliteRowsSkipped}`);
  lines.push(`Provider metadata rows updated: ${result.sqliteRowsUpdated}${result.sqlitePresent ? "" : " (state_5.sqlite not found)"}`);
  lines.push(`Rollout metadata files updated: ${result.changedSessionFiles}`);
  if (result.sqliteUserEventRowsUpdated) {
    lines.push(`Updated SQLite user-event flags: ${result.sqliteUserEventRowsUpdated}`);
  }
  if (result.sqliteCwdRowsUpdated) {
    lines.push(`Updated SQLite cwd paths: ${result.sqliteCwdRowsUpdated}`);
  }
  if (result.updatedWorkspaceRoots) {
    lines.push(`Updated workspace roots: ${result.updatedWorkspaceRoots}`);
  }
  if (result.skippedLockedRolloutFiles?.length) {
    const preview = result.skippedLockedRolloutFiles.slice(0, 5).join(", ");
    const extraCount = result.skippedLockedRolloutFiles.length - Math.min(result.skippedLockedRolloutFiles.length, 5);
    lines.push(`Skipped locked rollout files: ${result.skippedLockedRolloutFiles.length}`);
    lines.push(`Locked file(s): ${preview}${extraCount > 0 ? ` (+${extraCount} more)` : ""}`);
  }
  if (result.autoPruneResult) {
    lines.push(
      `Backup cleanup: deleted ${result.autoPruneResult.deletedCount}, remaining ${result.autoPruneResult.remainingCount}, freed ${formatBytes(result.autoPruneResult.freedBytes)}`
    );
  }
  if (result.autoPruneWarning) {
    lines.push(`Backup cleanup warning: ${result.autoPruneWarning}`);
  }
  return lines.join("\n");
}

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return unitIndex === 0 ? `${bytes} B` : `${value.toFixed(value >= 10 ? 1 : 2).replace(/\.0$/, "")} ${units[unitIndex]}`;
}

function formatDuration(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < 1000) {
    return `${Math.max(0, Math.round(durationMs ?? 0))} ms`;
  }

  const seconds = durationMs / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(seconds >= 10 ? 1 : 2).replace(/\.0$/, "")} s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds - (minutes * 60);
  return `${minutes}m ${remainingSeconds.toFixed(remainingSeconds >= 10 ? 0 : 1).replace(/\.0$/, "")}s`;
}

const SYNC_PROGRESS_STAGES = [
  ["scan_rollout_files", "Scanning rollout files..."],
  ["check_locked_rollout_files", "Checking locked rollout files..."],
  ["create_backup", "Creating backup..."],
  ["update_sqlite", "Updating SQLite..."],
  ["rewrite_rollout_files", "Rewriting rollout files..."],
  ["clean_backups", "Cleaning backups..."]
];

const EXPORT_PROGRESS_STAGES = [
  ["create_history_archive", "Creating history archive..."]
];

const IMPORT_PROGRESS_STAGES = [
  ["extract_history_archive", "Extracting history archive..."],
  ["plan_history_import", "Planning history import..."],
  ["check_import_targets", "Checking import targets..."],
  ["create_backup", "Creating backup..."],
  ["copy_history_rollouts", "Copying rollout files..."],
  ["merge_history_sqlite", "Merging SQLite rows..."],
  ["scan_imported_history", "Scanning imported history..."],
  ["sync_imported_metadata", "Synchronizing imported metadata..."],
  ["clean_backups", "Cleaning backups..."]
];

const SYNC_PROGRESS_STAGE_INDEX = new Map(
  SYNC_PROGRESS_STAGES.map(([stage], index) => [stage, index + 1])
);

function createSyncProgressReporter() {
  return (event) => {
    if (event?.stage === "update_config" && event.status === "start") {
      console.log(`Updating config.toml root model_provider to ${event.provider}...`);
      return;
    }

    const stageIndex = SYNC_PROGRESS_STAGE_INDEX.get(event?.stage);
    if (!stageIndex || event.status !== "start") {
      if (event?.stage === "create_backup" && event.status === "complete") {
        console.log(`     Backup created in ${formatDuration(event.durationMs)}: ${event.backupDir}`);
      }
      return;
    }

    console.log(`[${stageIndex}/${SYNC_PROGRESS_STAGES.length}] ${SYNC_PROGRESS_STAGES[stageIndex - 1][1]}`);
  };
}

function createProgressReporter(stages) {
  const stageIndexMap = new Map(stages.map(([stage], index) => [stage, index + 1]));
  return (event) => {
    const stageIndex = stageIndexMap.get(event?.stage);
    if (!stageIndex) {
      return;
    }
    if (event.status === "start") {
      console.log(`[${stageIndex}/${stages.length}] ${stages[stageIndex - 1][1]}`);
      return;
    }
    if (event?.stage === "create_backup" && event.status === "complete") {
      console.log(`     Backup created in ${formatDuration(event.durationMs)}: ${event.backupDir}`);
    }
  };
}

function formatConflictSide(side) {
  const rollout = side?.rollout;
  const sqlite = side?.sqlite;
  const lines = [];
  if (rollout) {
    lines.push(`  rollout: ${rollout.scope}, provider ${rollout.provider}, ${rollout.size} B`);
    lines.push(`  path: ${rollout.relativePath}`);
    if (rollout.cwd) {
      lines.push(`  cwd: ${rollout.cwd}`);
    }
    if (rollout.timestamp) {
      lines.push(`  timestamp: ${rollout.timestamp}`);
    }
  } else {
    lines.push("  rollout: (none)");
  }
  if (sqlite) {
    lines.push(`  sqlite: ${sqlite.scope}, provider ${sqlite.provider}, ${sqlite.columns} column(s)`);
    if (sqlite.firstUserMessage) {
      const preview = String(sqlite.firstUserMessage).replace(/\s+/g, " ").slice(0, 120);
      lines.push(`  first user: ${preview}${String(sqlite.firstUserMessage).length > 120 ? "..." : ""}`);
    }
    if (sqlite.cwd && (!rollout || sqlite.cwd !== rollout.cwd)) {
      lines.push(`  sqlite cwd: ${sqlite.cwd}`);
    }
    if (sqlite.timestamp) {
      lines.push(`  sqlite timestamp: ${sqlite.timestamp}`);
    }
  } else {
    lines.push("  sqlite: (none)");
  }
  return lines.join("\n");
}

function askQuestion(rl, prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

function createConflictResolver() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return null;
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  let closed = false;
  async function close() {
    if (!closed) {
      closed = true;
      rl.close();
    }
  }
  const resolver = async (conflict) => {
    console.log("");
    console.log(`Conflict: ${conflict.threadId ?? conflict.key}`);
    console.log("Local:");
    console.log(formatConflictSide(conflict.local));
    console.log("Imported:");
    console.log(formatConflictSide(conflict.imported));
    while (true) {
      const answer = (await askQuestion(
        rl,
        "Choose [l] keep local, [i] use imported, [la] keep local for all, [ia] use imported for all, [a] abort: "
      )).trim().toLowerCase();
      if (answer === "l") {
        return "skip";
      }
      if (answer === "i") {
        return "overwrite";
      }
      if (answer === "la") {
        return "skipAll";
      }
      if (answer === "ia") {
        return "overwriteAll";
      }
      if (answer === "a" || answer === "q") {
        return "abort";
      }
      console.log("Please enter l, i, la, ia, or a.");
    }
  };
  resolver.close = close;
  return resolver;
}

function parseKeepCount(rawValue, { allowZero = false } = {}) {
  if (rawValue === undefined) {
    return DEFAULT_BACKUP_RETENTION_COUNT;
  }
  const normalized = String(rawValue).trim();
  if (!/^\d+$/.test(normalized)) {
    const minimum = allowZero ? 0 : 1;
    throw new Error(`Invalid --keep value: ${rawValue}. Expected an integer greater than or equal to ${minimum}.`);
  }
  const keepCount = Number.parseInt(normalized, 10);
  const minimum = allowZero ? 0 : 1;
  if (!Number.isInteger(keepCount) || keepCount < minimum) {
    throw new Error(`Invalid --keep value: ${rawValue}. Expected an integer greater than or equal to ${minimum}.`);
  }
  return keepCount;
}

async function main() {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  const command = positionals[0];

  if (!command || command === "help" || flags.help) {
    printHelp();
    return;
  }

  if (command === "status") {
    const { getStatus, renderStatus } = await loadService();
    const status = await getStatus({ codexHome: flags["codex-home"] });
    console.log(renderStatus(status));
    return;
  }

  if (command === "sync") {
    const { runSync } = await loadService();
    const result = await runSync({
      codexHome: flags["codex-home"],
      provider: flags.provider,
      keepCount: parseKeepCount(flags.keep),
      onProgress: createSyncProgressReporter()
    });
    console.log(summarizeSync(result, "Synchronized"));
    return;
  }

  if (command === "switch") {
    const { runSwitch } = await loadService();
    const provider = positionals[1] ?? flags.provider;
    const result = await runSwitch({
      codexHome: flags["codex-home"],
      provider,
      keepCount: parseKeepCount(flags.keep),
      onProgress: createSyncProgressReporter()
    });
    console.log(summarizeSync(result, "Switched to"));
    return;
  }

  if (command === "export") {
    const { runExportHistory } = await loadService();
    const archivePath = positionals[1] ?? flags.output;
    const result = await runExportHistory({
      codexHome: flags["codex-home"],
      archivePath,
      overwrite: Boolean(flags.overwrite),
      onProgress: createProgressReporter(EXPORT_PROGRESS_STAGES)
    });
    console.log(summarizeExport(result));
    return;
  }

  if (command === "import") {
    const { runImportHistory } = await loadService();
    const archivePath = positionals[1] ?? flags.archive;
    const conflictResolver = flags.conflict === undefined || flags.conflict === "ask"
      ? createConflictResolver()
      : null;
    try {
      const result = await runImportHistory({
        codexHome: flags["codex-home"],
        archivePath,
        provider: flags.provider,
        conflict: flags.conflict ?? "ask",
        dryRun: Boolean(flags["dry-run"]),
        keepCount: parseKeepCount(flags.keep),
        onConflict: conflictResolver ?? undefined,
        onProgress: createProgressReporter(IMPORT_PROGRESS_STAGES)
      });
      console.log(summarizeImport(result));
    } finally {
      await conflictResolver?.close?.();
    }
    return;
  }

  if (command === "prune-backups") {
    const { runPruneBackups } = await loadService();
    const result = await runPruneBackups({
      codexHome: flags["codex-home"],
      keepCount: parseKeepCount(flags.keep, { allowZero: true })
    });
    console.log(summarizePrune(result));
    return;
  }

  if (command === "restore") {
    const { runRestore } = await loadService();
    const backupDir = positionals[1] ?? flags.backup;
    const result = await runRestore({
      codexHome: flags["codex-home"],
      backupDir,
      restoreConfig: !flags["no-config"],
      restoreDatabase: !flags["no-db"],
      restoreSessions: !flags["no-sessions"]
    });
    console.log(`Restored backup from ${path.resolve(backupDir)}`);
    console.log(`Codex home: ${result.codexHome}`);
    console.log(`Provider at backup time: ${result.targetProvider}`);
    return;
  }

  if (command === "install-windows-launcher") {
    const result = await installWindowsLauncher({
      dir: flags.dir,
      codexHome: flags["codex-home"]
    });
    console.log("Installed Windows launcher files:");
    console.log(`  Hidden double-click launcher: ${result.vbsPath}`);
    console.log(`  Visible console launcher: ${result.cmdPath}`);
    console.log(`  Target directory: ${result.targetDir}`);
    if (result.codexHome) {
      console.log(`  Fixed CODEX_HOME: ${result.codexHome}`);
    } else {
      console.log("  CODEX_HOME: default current environment / ~/.codex");
    }
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
