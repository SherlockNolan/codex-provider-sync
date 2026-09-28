#!/usr/bin/env node

import { publicSkipSummary } from "../packages/contracts/dist/index.js";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import {
  cliJsonExitCode,
  createCliFailureEnvelope,
  createCliSuccessEnvelope
} from "./cli-json.js";
import { DEFAULT_BACKUP_RETENTION_COUNT } from "./constants.js";
import { formatBytes, renderStatus } from "./cli-presenter.js";
import { installWindowsLauncher } from "./launcher.js";
import { assertSupportedNodeVersion } from "./node-version.js";

async function loadCore() {
  assertSupportedNodeVersion();
  return import("./public-api.js");
}

const HELP_TEXT = `codex-provider

Usage:
  codex-provider status [--json] [--codex-home PATH] [--sqlite-home PATH]
  codex-provider sync [--json] [--keep N] [--codex-home PATH] [--sqlite-home PATH]
  codex-provider switch <provider-id> [--json] [--model NAME] [--keep-root-model] [--keep N] [--codex-home PATH] [--sqlite-home PATH]
  codex-provider diagnostics [--json] [--codex-home PATH] [--sqlite-home PATH]
  codex-provider repair <targets> [--json] [--keep N] [--codex-home PATH] [--sqlite-home PATH]
  codex-provider watch [--codex-home PATH] [--sqlite-home PATH] [--debounce-ms N] [--once] [--no-state-db]
  codex-provider web [--port N] [--no-open] [--reset-access] [--codex-home PATH] [--sqlite-home PATH]
  codex-provider export [archive-path] [--select] [--ids ID[,ID...]] [--overwrite] [--codex-home PATH]
  codex-provider import <archive-path> [--provider ID] [--conflict ask|skip|overwrite|fail] [--dry-run] [--keep N] [--codex-home PATH]
  codex-provider prune-backups [--json] [--keep N] [--codex-home PATH]
  codex-provider restore <backup-dir> [--json] [--no-config] [--no-db] [--no-sessions] [--allow-sqlite-home-relocation] [--codex-home PATH] [--sqlite-home PATH]
  codex-provider install-windows-launcher [--json] [--dir PATH] [--codex-home PATH] [--sqlite-home PATH]

JSON mode:
  --json               emit one schemaVersion 1 envelope on stdout; progress goes to stderr
                       (not supported by long-running watch or web commands)

switch flags:
  --model NAME         override root-level model field with NAME (e.g. "MiniMax-M3")
  --keep-root-model    do not touch the root-level model field; only switch model_provider

repair targets:
  models,cwd,userEvent,workspaceRoots
                       comma-separated; workspaceRoots automatically includes cwd

backup flags:
  --keep N             retain the newest N managed backups (default 2; prune allows 0)

watch flags:
  --codex-home PATH    override CODEX_HOME (default: ~/.codex or $CODEX_HOME)
  --sqlite-home PATH   override sqlite_home and CODEX_SQLITE_HOME
  --debounce-ms N      wait N milliseconds after a change before syncing (default 750)
  --once               exit after the first successful sync
  --no-state-db        only watch config.toml, ignore SQLite state events

web flags:
  --port N             bind the local Web UI to 127.0.0.1:N (default 8791)
  --no-open            do not open the system browser automatically
  --reset-access       invalidate all paired browsers before creating a new pairing
  --codex-home PATH    set the default server-managed storage profile
  --sqlite-home PATH   set the default profile SQLite Home override
`;

function printHelp(writeLine) {
  writeLine(HELP_TEXT);
}

function parseArgs(argv) {
  const positionals = [];
  const flags = Object.create(null);
  const flagCounts = Object.create(null);

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    const separatorIndex = value.indexOf("=");
    const flagName = separatorIndex >= 0 ? value.slice(0, separatorIndex) : value;
    const inlineValue = separatorIndex >= 0 ? value.slice(separatorIndex + 1) : undefined;
    const normalizedName = flagName.slice(2);
    flagCounts[normalizedName] = (flagCounts[normalizedName] ?? 0) + 1;
    if (inlineValue !== undefined) {
      flags[normalizedName] = inlineValue;
      continue;
    }
    if (normalizedName === "json") {
      flags[normalizedName] = true;
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

  return { positionals, flags, flagCounts };
}

const JSON_COMMAND_CONTRACTS = Object.freeze({
  status: {
    flags: ["json", "help", "codex-home", "sqlite-home"],
    valueFlags: ["codex-home", "sqlite-home"],
    booleanFlags: ["json", "help"],
    positionalCount: 1
  },
  sync: {
    flags: ["json", "help", "keep", "codex-home", "sqlite-home"],
    valueFlags: ["keep", "codex-home", "sqlite-home"],
    booleanFlags: ["json", "help"],
    positionalCount: 1
  },
  switch: {
    flags: ["json", "help", "model", "keep-root-model", "keep", "codex-home", "sqlite-home"],
    valueFlags: ["model", "keep", "codex-home", "sqlite-home"],
    booleanFlags: ["json", "help", "keep-root-model"],
    positionalCount: 2
  },
  diagnostics: {
    flags: ["json", "help", "codex-home", "sqlite-home"],
    valueFlags: ["codex-home", "sqlite-home"],
    booleanFlags: ["json", "help"],
    positionalCount: 1
  },
  repair: {
    flags: ["json", "help", "keep", "codex-home", "sqlite-home"],
    valueFlags: ["keep", "codex-home", "sqlite-home"],
    booleanFlags: ["json", "help"],
    positionalCount: 2
  },
  "prune-backups": {
    flags: ["json", "help", "keep", "codex-home"],
    valueFlags: ["keep", "codex-home"],
    booleanFlags: ["json", "help"],
    positionalCount: 1
  },
  restore: {
    flags: [
      "json",
      "help",
      "no-config",
      "no-db",
      "no-sessions",
      "allow-sqlite-home-relocation",
      "codex-home",
      "sqlite-home"
    ],
    valueFlags: ["codex-home", "sqlite-home"],
    booleanFlags: [
      "json",
      "help",
      "no-config",
      "no-db",
      "no-sessions",
      "allow-sqlite-home-relocation"
    ],
    positionalCount: 2
  },
  "install-windows-launcher": {
    flags: ["json", "help", "dir", "codex-home", "sqlite-home"],
    valueFlags: ["dir", "codex-home", "sqlite-home"],
    booleanFlags: ["json", "help"],
    positionalCount: 1
  }
});

const JSON_KNOWN_COMMANDS = new Set([
  ...Object.keys(JSON_COMMAND_CONTRACTS),
  "watch",
  "web",
  "help"
]);

function invalidInputError(message) {
  const error = new Error(message);
  error.code = "INVALID_INPUT";
  return error;
}

function validateJsonFlag(flags) {
  if (Object.hasOwn(flags, "json") && flags.json !== true) {
    throw invalidInputError("--json is a standalone boolean flag and does not accept a value.");
  }
}

function validateJsonCommandArgs(command, parsed) {
  const contract = Object.hasOwn(JSON_COMMAND_CONTRACTS, command)
    ? JSON_COMMAND_CONTRACTS[command]
    : undefined;
  if (!contract) {
    if (command === "watch" || command === "web") {
      throw invalidInputError(
        `${command} does not support --json because it is a long-running command. Use Human mode.`
      );
    }
    throw invalidInputError(`Unknown command: ${command}`);
  }

  const allowedFlags = new Set(contract.flags);
  const valueFlags = new Set(contract.valueFlags);
  const booleanFlags = new Set(contract.booleanFlags);
  for (const [name, count] of Object.entries(parsed.flagCounts)) {
    if (!allowedFlags.has(name)) {
      throw invalidInputError(`Unknown option for ${command}: --${name}`);
    }
    if (count !== 1) {
      throw invalidInputError(`Option --${name} may only be specified once in JSON mode.`);
    }
    if (valueFlags.has(name)
        && (parsed.flags[name] === true || String(parsed.flags[name]).length === 0)) {
      throw invalidInputError(`Option --${name} requires a value.`);
    }
    if (booleanFlags.has(name) && parsed.flags[name] !== true) {
      throw invalidInputError(`Option --${name} is a boolean flag and does not accept a value.`);
    }
  }
  if (parsed.positionals.length !== contract.positionalCount) {
    const expected = contract.positionalCount - 1;
    throw invalidInputError(
      `${command} expects exactly ${expected} positional argument${expected === 1 ? "" : "s"}.`
    );
  }
}

function validateRemovedSyncOptions(command, flags) {
  if (Object.hasOwn(flags, "fast")) {
    throw invalidInputError("--fast was removed; Sync now always uses the Provider-only optimized path.");
  }
  if (command === "sync" && Object.hasOwn(flags, "provider")) {
    throw invalidInputError("sync --provider was removed; Sync always uses config.toml model_provider.");
  }
}

function parseRepairTargets(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw invalidInputError("Repair requires comma-separated targets.");
  }
  const targets = value.split(",").map((target) => target.trim()).filter(Boolean);
  const allowed = new Set(["models", "cwd", "userEvent", "workspaceRoots"]);
  if (targets.length === 0
      || targets.some((target) => !allowed.has(target))
      || new Set(targets).size !== targets.length) {
    throw invalidInputError("Repair targets must be unique values from models,cwd,userEvent,workspaceRoots.");
  }
  return targets;
}

function summarizeSync(result, label) {
  const lines = [
    `${label} provider: ${result.targetProvider}`,
    `Codex home: ${result.codexHome}`,
    `SQLite home: ${result.sqliteHome} (source: ${result.sqliteHomeSource})`,
    `Backup: ${result.backupDir}`,
    `Backup creation time: ${formatDuration(result.backupDurationMs ?? 0)}`,
    `Updated rollout files: ${result.changedSessionFiles}`,
    `In-place rollout updates: ${result.inPlaceSessionFiles ?? 0}`,
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
  if (result.skippedChangedRolloutFiles?.length) {
    const preview = result.skippedChangedRolloutFiles.slice(0, 5).join(", ");
    const extraCount = result.skippedChangedRolloutFiles.length - Math.min(result.skippedChangedRolloutFiles.length, 5);
    lines.push(`Skipped changed rollout files: ${result.skippedChangedRolloutFiles.length}`);
    lines.push(`Changed file(s): ${preview}${extraCount > 0 ? ` (+${extraCount} more)` : ""}`);
  }
  const skipped = publicSkipSummary(result.skipSummary);
  if (skipped?.total) {
    lines.push(`Partial: skipped ${skipped.total} (${skipped.rolloutFiles} files, ${skipped.sqliteRows} rows); unconfirmed ${skipped.unconfirmed}.`);
    for (const item of skipped.items) lines.push(`[${item.kind}/${item.stage}/${item.reason}] ${item.path ?? item.id ?? "unidentified"}`);
    lines.push(`Showing ${skipped.items.length} of ${skipped.total}; omitted ${skipped.omitted}.`);
    if (!skipped.retryRecommended) lines.push("Resolve the listed issues, then prepare again.");
  }
  if (result.configUpdated) lines.push(`Configuration switched; history files updated: ${result.changedSessionFiles}.`);
  if (result.retryRecommended) {
    lines.push(result.partialReason === "locked-session"
      ? "Retry recommendation: after the active session ends, prepare a fresh operation and retry to converge."
      : "Retry recommendation: prepare a fresh operation and retry to converge.");
  }
  if (result.encryptedContentWarning) {
    lines.push(result.encryptedContentWarning);
  }
  if (result.autoPruneResult) {
    lines.push(
      `Backup cleanup: deleted ${result.autoPruneResult.deletedCount}, remaining ${result.autoPruneResult.remainingCount}, freed ${formatBytes(result.autoPruneResult.freedBytes)}`
    );
  }
  if (result.backupScopeWarning) lines.push("Backup warning: restore exclusions could not be confirmed; conservative coverage may remain.");
  if (result.autoPruneWarning) {
    lines.push(`Backup cleanup warning: ${result.autoPruneWarning}`);
  }
  return lines.join("\n");
}

function summarizeDiagnostics(result) {
  const issues = result.issues ?? {};
  return [
    `Current provider: ${result.provider?.current ?? "unknown"}`,
    `Root model available: ${issues.rootModelAvailable ? "yes" : "no"}`,
    `Rollout model files needing repair: ${issues.rolloutModelFilesNeedingRepair ?? 0}`,
    `SQLite model rows needing repair: ${issues.sqliteModelRowsNeedingRepair ?? 0}`,
    `SQLite cwd rows needing repair: ${issues.cwdRowsNeedingRepair ?? 0}`,
    `SQLite user-event rows needing repair: ${issues.userEventRowsNeedingRepair ?? 0}`,
    `Workspace roots needing repair: ${issues.workspaceRootsNeedingRepair ?? 0}`,
    `Files containing encrypted content: ${issues.encryptedContentFiles ?? 0}`,
    ...(result.historyIntegrity ? [
      `History record checks: ${result.historyIntegrity.outcome}`,
      `JSON parse findings: ${result.historyIntegrity.counts.jsonCorruptRecords}`,
      `Duplicate ordinal observations: ${result.historyIntegrity.counts.duplicateOrdinals}`,
      "Codex display index: not verified (unsupported schema); no records or index were modified."
    ] : [])
  ].join("\n");
}

function summarizeRepair(result) {
  return [
    `Repair targets: ${(result.repairTargets ?? []).join(", ")}`,
    `Backup: ${result.backupDir}`,
    `Updated rollout models: ${result.changedSessionFiles ?? 0}`,
    `Updated SQLite model rows: ${result.sqliteModelRowsUpdated ?? 0}`,
    `Updated SQLite cwd rows: ${result.sqliteCwdRowsUpdated ?? 0}`,
    `Updated SQLite user-event rows: ${result.sqliteUserEventRowsUpdated ?? 0}`,
    `Updated workspace roots: ${result.updatedWorkspaceRoots ?? 0}`,
    ...(result.verification ? [
      `Repair verification: ${result.verification.status}`,
      `Remaining rollout files: ${result.verification.remainingRolloutFiles}`,
      `Remaining SQLite field differences: ${result.verification.remainingSqliteRows}`,
      `Remaining workspace settings: ${result.verification.remainingWorkspaceRoots}`,
      `Skipped sessions: ${result.verification.skippedSessions}`
    ] : [])
  ].join("\n");
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
    `Selected export: ${result.selected ? "yes" : "no"}`,
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
  ["rewrite_rollout_files", "Rewriting rollout files..."],
  ["update_sqlite", "Updating SQLite..."],
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

const REPAIR_PROGRESS_STAGES = [
  ...SYNC_PROGRESS_STAGES,
  ["verify_repair", "Verifying selected repair targets..."]
];

function createSyncProgressReporter(writeLine, { includeBackupPath = true, stages = SYNC_PROGRESS_STAGES } = {}) {
  const stageIndexes = new Map(stages.map(([stage], index) => [stage, index + 1]));
  return (event) => {
    if (event?.stage === "update_config" && event.status === "start") {
      writeLine(includeBackupPath
        ? `Updating config.toml root model_provider to ${event.provider}...`
        : "Updating config.toml root model_provider...");
      return;
    }

    const stageIndex = stageIndexes.get(event?.stage);
    if (!stageIndex || event.status !== "start") {
      if (event?.stage === "create_backup" && event.status === "complete") {
        writeLine(includeBackupPath
          ? `     Backup created in ${formatDuration(event.durationMs)}: ${event.backupDir}`
          : `     Backup created in ${formatDuration(event.durationMs)}`);
      }
      return;
    }

    writeLine(`[${stageIndex}/${stages.length}] ${stages[stageIndex - 1][1]}`);
  };
}

function createProgressReporter(stages, writeLine) {
  const stageIndexMap = new Map(stages.map(([stage], index) => [stage, index + 1]));
  return (event) => {
    const stageIndex = stageIndexMap.get(event?.stage);
    if (!stageIndex) {
      return;
    }
    if (event.status === "start") {
      writeLine(`[${stageIndex}/${stages.length}] ${stages[stageIndex - 1][1]}`);
      return;
    }
    if (event?.stage === "create_backup" && event.status === "complete") {
      writeLine(`     Backup created in ${formatDuration(event.durationMs)}: ${event.backupDir}`);
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

function stripControlCharacters(value) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ");
}

function stripAnsi(value) {
  return String(value ?? "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

function isCombiningCodePoint(codePoint) {
  return (codePoint >= 0x0300 && codePoint <= 0x036f)
    || (codePoint >= 0x1ab0 && codePoint <= 0x1aff)
    || (codePoint >= 0x1dc0 && codePoint <= 0x1dff)
    || (codePoint >= 0x20d0 && codePoint <= 0x20ff)
    || (codePoint >= 0xfe20 && codePoint <= 0xfe2f);
}

function isWideCodePoint(codePoint) {
  return (codePoint >= 0x1100 && (
    codePoint <= 0x115f
    || codePoint === 0x2329
    || codePoint === 0x232a
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x1f300 && codePoint <= 0x1faff)
    || (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  ));
}

function stringDisplayWidth(value) {
  let width = 0;
  for (const char of Array.from(stripAnsi(value))) {
    const codePoint = char.codePointAt(0);
    if (!codePoint || isCombiningCodePoint(codePoint)) {
      continue;
    }
    width += isWideCodePoint(codePoint) ? 2 : 1;
  }
  return width;
}

function truncateText(value, maxLength) {
  const normalized = stripControlCharacters(value).replace(/\s+/g, " ").trim();
  if (maxLength <= 0) {
    return "";
  }
  if (stringDisplayWidth(normalized) <= maxLength) {
    return normalized;
  }
  if (maxLength <= 3) {
    let shortText = "";
    let width = 0;
    for (const char of Array.from(normalized)) {
      const nextWidth = stringDisplayWidth(char);
      if (width + nextWidth > maxLength) {
        break;
      }
      shortText += char;
      width += nextWidth;
    }
    return shortText;
  }
  let text = "";
  let width = 0;
  const targetWidth = maxLength - 3;
  for (const char of Array.from(normalized)) {
    const nextWidth = stringDisplayWidth(char);
    if (width + nextWidth > targetWidth) {
      break;
    }
    text += char;
    width += nextWidth;
  }
  return `${text}...`;
}

function visibleLength(value) {
  return stringDisplayWidth(value);
}

function padVisible(value, width) {
  const text = String(value ?? "");
  const length = visibleLength(text);
  if (length >= width) {
    return text;
  }
  return `${text}${" ".repeat(width - length)}`;
}

function normalizeDisplayText(value) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ")
    .trim();
}

function wrapText(value, width, maxLines = Infinity) {
  if (width <= 0 || maxLines <= 0) {
    return [];
  }
  const paragraphs = normalizeDisplayText(value).split("\n");
  const lines = [];
  for (const paragraph of paragraphs) {
    if (lines.length >= maxLines) {
      break;
    }
    const words = paragraph.split(/(\s+)/).filter((part) => part.length > 0);
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    let current = "";
    for (const word of words) {
      if (lines.length >= maxLines) {
        break;
      }
      if (/^\s+$/.test(word)) {
        if (current && !current.endsWith(" ")) {
          current += " ";
        }
        continue;
      }
      const candidate = current ? `${current}${word}` : word;
      if (visibleLength(candidate) <= width) {
        current = candidate;
        continue;
      }
      if (current) {
        lines.push(current.trimEnd());
        current = "";
        if (lines.length >= maxLines) {
          break;
        }
      }
      let chunk = "";
      for (const char of Array.from(word)) {
        const candidateChunk = `${chunk}${char}`;
        if (visibleLength(candidateChunk) > width) {
          if (chunk) {
            lines.push(chunk);
          }
          chunk = char;
          if (lines.length >= maxLines) {
            break;
          }
        } else {
          chunk = candidateChunk;
        }
      }
      current = chunk;
    }
    if (current && lines.length < maxLines) {
      lines.push(current.trimEnd());
    }
  }
  if (lines.length > maxLines) {
    return lines.slice(0, maxLines);
  }
  return lines;
}

const THEME = {
  reset: "\x1b[0m",
  dim: "\x1b[90m",
  text: "\x1b[37m",
  muted: "\x1b[38;5;245m",
  panel: "\x1b[48;5;236m",
  panelAlt: "\x1b[48;5;237m",
  active: "\x1b[48;5;240m",
  accent: "\x1b[38;5;171m",
  selected: "\x1b[38;5;120m",
  warning: "\x1b[38;5;214m",
  header: "\x1b[38;5;250m",
  rule: "\x1b[38;5;242m"
};

function searchableExportText(entry) {
  return [
    entry.threadId,
    entry.scope,
    entry.provider,
    entry.cwd,
    entry.timestamp,
    entry.firstUserMessage,
    entry.relativePath
  ].filter(Boolean).join("\n").toLowerCase();
}

function filterExportPreviewEntries(conversations, query, { includeArchived = true } = {}) {
  const normalizedQuery = query.trim().toLowerCase();
  return conversations.filter((entry) => {
    if (!includeArchived && entry.scope === "archived_sessions") {
      return false;
    }
    return !normalizedQuery || searchableExportText(entry).includes(normalizedQuery);
  });
}

function buildExportBrowserLayout() {
  const width = Math.max(50, process.stdout.columns ?? 100);
  const height = Math.max(12, process.stdout.rows ?? 30);
  const headerRows = 4;
  const footerRows = 3;
  const bodyRows = Math.max(3, height - headerRows - footerRows);
  const gutterWidth = 2;
  const checkWidth = 3;
  const indexWidth = width >= 72 ? 4 : 0;
  const scopeWidth = width >= 66 ? 5 : 0;
  const providerWidth = width >= 78 ? 13 : (width >= 62 ? 9 : 0);
  const timeWidth = width >= 86 ? 20 : (width >= 70 ? 12 : 0);
  const nonTitleWidths = [
    gutterWidth,
    checkWidth,
    indexWidth,
    scopeWidth,
    providerWidth,
    timeWidth
  ].filter((columnWidth) => columnWidth > 0);
  const separatorWidth = nonTitleWidths.length;
  const fixedWidth = nonTitleWidths.reduce((total, columnWidth) => total + columnWidth, 0) + separatorWidth;
  const titleWidth = Math.max(8, width - fixedWidth);
  return {
    width,
    height,
    headerRows,
    footerRows,
    bodyRows,
    gutterWidth,
    checkWidth,
    indexWidth,
    scopeWidth,
    providerWidth,
    timeWidth,
    titleWidth
  };
}

function formatCell(value, width) {
  return width > 0 ? padVisible(truncateText(value, width), width) : "";
}

function joinRowCells(cells) {
  return cells.filter((cell) => cell !== "").join(" ");
}

function colorRow(line, { active, selected, odd }) {
  const background = active ? THEME.active : (odd ? THEME.panelAlt : THEME.panel);
  const foreground = active
    ? THEME.text
    : (selected ? THEME.selected : THEME.muted);
  return `${background}${foreground}${line}${THEME.reset}`;
}

function formatExportBrowserRow(entry, { selected, active, odd, layout }) {
  const marker = selected ? "●" : "○";
  const pointer = active ? "›" : " ";
  const ageOrTime = entry.timestamp ? truncateText(entry.timestamp, layout.timeWidth) : "";
  const title = entry.title || entry.firstUserMessage || entry.threadId || entry.relativePath;
  const plainLine = joinRowCells([
    padVisible(pointer, layout.gutterWidth),
    padVisible(marker, layout.checkWidth),
    layout.indexWidth ? formatCell(String(entry.index), layout.indexWidth) : "",
    layout.scopeWidth ? formatCell(entry.scope === "archived_sessions" ? "arch" : "live", layout.scopeWidth) : "",
    layout.providerWidth ? formatCell(entry.provider, layout.providerWidth) : "",
    layout.timeWidth ? formatCell(ageOrTime, layout.timeWidth) : "",
    formatCell(title, layout.titleWidth)
  ]);
  return colorRow(padVisible(plainLine, layout.width), { active, selected, odd });
}

function roleLabel(role) {
  if (role === "user") {
    return "You";
  }
  if (role === "assistant") {
    return "Codex";
  }
  if (role === "system") {
    return "System";
  }
  return "Msg";
}

function transcriptCacheItem(transcriptCache, key) {
  return transcriptCache instanceof Map ? transcriptCache.get(key) : null;
}

function formatInlinePreviewRows(entry, { layout, transcriptCache, maxRows }) {
  const cached = transcriptCacheItem(transcriptCache, entry.key);
  const prefixWidth = Math.min(9, Math.max(5, Math.floor(layout.width * 0.14)));
  const textWidth = Math.max(8, layout.width - prefixWidth - 3);
  if (!cached) {
    return [`${THEME.panel}${THEME.dim}${padVisible("  Loading preview...", layout.width)}${THEME.reset}`];
  }
  if (cached.error) {
    return [`${THEME.panel}${THEME.warning}${padVisible(truncateText(`  ${cached.error}`, layout.width), layout.width)}${THEME.reset}`];
  }
  const messages = cached.messages ?? [];
  if (messages.length === 0) {
    return [`${THEME.panel}${THEME.dim}${padVisible("  No transcript messages found in rollout.", layout.width)}${THEME.reset}`];
  }

  const rows = [];
  for (const message of messages.slice(0, 4)) {
    if (rows.length >= maxRows) {
      break;
    }
    const label = `${roleLabel(message.role)}:`;
    const wrapped = wrapText(message.text, textWidth, Math.max(1, maxRows - rows.length));
    for (let index = 0; index < wrapped.length && rows.length < maxRows; index += 1) {
      const left = index === 0 ? label : "";
      const line = `  ${formatCell(left, prefixWidth)} ${formatCell(wrapped[index], textWidth)}`;
      rows.push(`${THEME.panel}${THEME.muted}${padVisible(line, layout.width)}${THEME.reset}`);
    }
  }
  if (cached.truncated && rows.length < maxRows) {
    rows.push(`${THEME.panel}${THEME.dim}${padVisible("  ... transcript is truncated", layout.width)}${THEME.reset}`);
  }
  return rows;
}

function formatExportBrowserHeader(layout) {
  const line = joinRowCells([
    "".padEnd(layout.gutterWidth, " "),
    "".padEnd(layout.checkWidth, " "),
    layout.indexWidth ? formatCell("#", layout.indexWidth) : "",
    layout.scopeWidth ? formatCell("Box", layout.scopeWidth) : "",
    layout.providerWidth ? formatCell("Provider", layout.providerWidth) : "",
    layout.timeWidth ? formatCell("Updated", layout.timeWidth) : "",
    formatCell("Conversation", layout.titleWidth)
  ]);
  return `${THEME.header}${padVisible(line, layout.width)}${THEME.reset}`;
}

function formatRule(width) {
  return `${THEME.rule}${"─".repeat(width)}${THEME.reset}`;
}

function renderExportBrowser({
  preview,
  filtered,
  selectedKeys,
  transcriptCache,
  expandedKey,
  cursor,
  scroll,
  query,
  includeArchived,
  message
}) {
  const layout = buildExportBrowserLayout();
  const visible = filtered.slice(scroll);
  const page = filtered.length === 0 ? 0 : Math.floor(scroll / layout.bodyRows) + 1;
  const pageCount = filtered.length === 0 ? 0 : Math.ceil(filtered.length / layout.bodyRows);
  const queryText = query ? `${THEME.accent}${truncateText(query, Math.max(1, layout.width - 18))}${THEME.reset}` : `${THEME.dim}(empty)${THEME.reset}`;
  const archiveText = includeArchived ? "Archives on" : "Archives off";
  const countText = `${THEME.muted}Filtered ${filtered.length}/${preview.conversations.length}  Selected ${selectedKeys.size}  ${archiveText}  Page ${page}/${pageCount}${THEME.reset}`;
  const topLine = `${THEME.header}Type to search:${THEME.reset} ${queryText}`;
  const lines = [
    padVisible(topLine, layout.width),
    padVisible(countText, layout.width),
    formatExportBrowserHeader(layout),
    formatRule(layout.width)
  ];

  let renderedBodyRows = 0;
  for (let offset = 0; renderedBodyRows < layout.bodyRows; offset += 1) {
    const entry = visible[offset];
    if (!entry) {
      const blank = " ".repeat(layout.width);
      lines.push(`${renderedBodyRows % 2 ? THEME.panelAlt : THEME.panel}${blank}${THEME.reset}`);
      renderedBodyRows += 1;
      continue;
    }
    const active = scroll + offset === cursor;
    lines.push(formatExportBrowserRow(entry, {
      selected: selectedKeys.has(entry.key),
      active,
      odd: renderedBodyRows % 2 === 1,
      layout
    }));
    renderedBodyRows += 1;
    if (entry.key === expandedKey && renderedBodyRows < layout.bodyRows) {
      const previewRows = formatInlinePreviewRows(entry, {
        layout,
        transcriptCache,
        maxRows: layout.bodyRows - renderedBodyRows
      });
      for (const previewRow of previewRows) {
        if (renderedBodyRows >= layout.bodyRows) {
          break;
        }
        lines.push(previewRow);
        renderedBodyRows += 1;
      }
    }
  }

  const footer = "↑/↓ browse  ←/→ PgUp/PgDn page  Space select  Ctrl+P preview  Ctrl+T transcript  Tab archives  Delete archive/live  Enter export  Esc exit";
  lines.push(formatRule(layout.width));
  lines.push(`${message ? THEME.warning : THEME.dim}${padVisible(truncateText(message || footer, layout.width), layout.width)}${THEME.reset}`);
  lines.push(`${THEME.dim}${padVisible(truncateText(preview.codexHome, layout.width), layout.width)}${THEME.reset}`);
  return `\x1b[?25l\x1b[H${lines.slice(0, layout.height).join("\n")}`;
}

function buildTranscriptLines(transcript, width) {
  if (transcript?.error) {
    return [transcript.error];
  }
  const messages = transcript?.messages ?? [];
  if (messages.length === 0) {
    return ["No transcript messages found in rollout."];
  }
  const labelWidth = Math.min(10, Math.max(6, Math.floor(width * 0.15)));
  const textWidth = Math.max(12, width - labelWidth - 3);
  const lines = [];
  for (const message of messages) {
    const label = `${roleLabel(message.role)}:`;
    const wrapped = wrapText(message.text, textWidth, Infinity);
    if (wrapped.length === 0) {
      lines.push(`${formatCell(label, labelWidth)} `);
      continue;
    }
    for (let index = 0; index < wrapped.length; index += 1) {
      const left = index === 0 ? label : "";
      lines.push(`${formatCell(left, labelWidth)} ${wrapped[index]}`);
    }
    lines.push("");
  }
  if (transcript.truncated) {
    lines.push("... transcript is truncated");
  }
  return lines;
}

function renderTranscriptBrowser({ entry, transcript, scroll, message }) {
  const layout = buildExportBrowserLayout();
  const title = entry.title || entry.firstUserMessage || entry.threadId || entry.relativePath;
  const meta = [
    entry.scope === "archived_sessions" ? "archived" : "live",
    entry.provider,
    entry.timestamp,
    entry.relativePath
  ].filter(Boolean).join("  ");
  const bodyRows = Math.max(3, layout.height - 5);
  const transcriptLines = buildTranscriptLines(transcript, layout.width);
  const maxScroll = Math.max(0, transcriptLines.length - bodyRows);
  const safeScroll = Math.max(0, Math.min(scroll, maxScroll));
  const lines = [
    `${THEME.header}${padVisible(truncateText(title, layout.width), layout.width)}${THEME.reset}`,
    `${THEME.dim}${padVisible(truncateText(meta, layout.width), layout.width)}${THEME.reset}`,
    formatRule(layout.width)
  ];
  const visible = transcriptLines.slice(safeScroll, safeScroll + bodyRows);
  for (let index = 0; index < bodyRows; index += 1) {
    const text = visible[index] ?? "";
    const color = transcript?.error ? THEME.warning : THEME.muted;
    lines.push(`${index % 2 ? THEME.panelAlt : THEME.panel}${color}${padVisible(truncateText(text, layout.width), layout.width)}${THEME.reset}`);
  }
  const footer = `↑/↓ scroll  PgUp/PgDn page  Home/End  Ctrl+T/Esc back  ${safeScroll + 1}/${Math.max(1, transcriptLines.length)}`;
  lines.push(formatRule(layout.width));
  lines.push(`${message ? THEME.warning : THEME.dim}${padVisible(truncateText(message || footer, layout.width), layout.width)}${THEME.reset}`);
  return {
    text: `\x1b[?25l\x1b[H${lines.slice(0, layout.height).join("\n")}`,
    scroll: safeScroll,
    maxScroll
  };
}

async function chooseExportSelection(preview, { onToggleArchive, onLoadTranscript } = {}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Interactive export selection requires a terminal. Use --ids <thread-id[,thread-id]> for non-interactive exports.");
  }
  if (preview.conversations.length === 0) {
    throw new Error("No exportable Codex conversations found.");
  }

  readline.emitKeypressEvents(process.stdin);
  const previousRawMode = process.stdin.isRaw;
  const selectedKeys = new Set();
  const transcriptCache = new Map();
  let query = "";
  let includeArchived = true;
  let cursor = 0;
  let scroll = 0;
  let expandedKey = null;
  let transcriptView = null;
  let transcriptScroll = 0;
  let message = "";
  let busy = false;

  function filteredEntries() {
    return filterExportPreviewEntries(preview.conversations, query, { includeArchived });
  }

  function bodyHeight() {
    return buildExportBrowserLayout().bodyRows;
  }

  function clampView(filtered) {
    if (filtered.length === 0) {
      cursor = 0;
      scroll = 0;
      return;
    }
    cursor = Math.max(0, Math.min(cursor, filtered.length - 1));
    const pageSize = bodyHeight();
    if (cursor < scroll) {
      scroll = cursor;
    } else if (cursor >= scroll + pageSize) {
      scroll = cursor - pageSize + 1;
    }
    scroll = Math.max(0, Math.min(scroll, Math.max(0, filtered.length - pageSize)));
  }

  function render() {
    if (transcriptView) {
      const rendered = renderTranscriptBrowser({
        entry: transcriptView.entry,
        transcript: transcriptView.transcript,
        scroll: transcriptScroll,
        message
      });
      transcriptScroll = rendered.scroll;
      process.stdout.write(rendered.text);
      message = "";
      return;
    }
    const filtered = filteredEntries();
    clampView(filtered);
    process.stdout.write(renderExportBrowser({
      preview,
      filtered,
      selectedKeys,
      transcriptCache,
      expandedKey,
      cursor,
      scroll,
      query,
      includeArchived,
      message
    }));
    message = "";
  }

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H");
  render();

  return await new Promise((resolve, reject) => {
    let finished = false;
    function finish(error, value) {
      if (finished) {
        return;
      }
      finished = true;
      process.stdin.off("keypress", onKeyPress);
      process.stdout.off("resize", render);
      process.stdin.setRawMode(Boolean(previousRawMode));
      process.stdout.write("\x1b[?25h\x1b[?1049l");
      if (error) {
        reject(error);
        return;
      }
      resolve(value);
    }

    function move(delta) {
      const filtered = filteredEntries();
      if (filtered.length === 0) {
        return;
      }
      cursor = Math.max(0, Math.min(cursor + delta, filtered.length - 1));
    }

    function page(delta) {
      move(delta * bodyHeight());
    }

    async function loadTranscriptForEntry(entry) {
      if (!entry) {
        return { error: "No conversation under cursor.", messages: [] };
      }
      if (transcriptCache.has(entry.key)) {
        return transcriptCache.get(entry.key);
      }
      if (typeof onLoadTranscript !== "function") {
        const unavailable = { error: "Transcript loading is not available.", messages: [] };
        transcriptCache.set(entry.key, unavailable);
        return unavailable;
      }
      try {
        const transcript = await onLoadTranscript(entry);
        transcriptCache.set(entry.key, transcript);
        return transcript;
      } catch (error) {
        const failed = {
          error: error instanceof Error ? error.message : String(error),
          messages: []
        };
        transcriptCache.set(entry.key, failed);
        return failed;
      }
    }

    async function toggleInlinePreview() {
      const entry = filteredEntries()[cursor];
      if (!entry) {
        message = "No conversation under cursor.";
        render();
        return;
      }
      if (expandedKey === entry.key) {
        expandedKey = null;
        render();
        return;
      }
      expandedKey = entry.key;
      if (!transcriptCache.has(entry.key)) {
        busy = true;
        render();
        await loadTranscriptForEntry(entry);
        busy = false;
      }
      render();
    }

    async function openTranscriptForCurrentEntry() {
      const entry = filteredEntries()[cursor];
      if (!entry) {
        message = "No conversation under cursor.";
        render();
        return;
      }
      busy = true;
      message = `Loading transcript for ${entry.threadId ?? entry.relativePath}...`;
      render();
      const transcript = await loadTranscriptForEntry(entry);
      transcriptView = { entry, transcript };
      transcriptScroll = 0;
      busy = false;
      render();
    }

    async function toggleArchiveForCurrentEntry() {
      if (typeof onToggleArchive !== "function") {
        message = "Archive toggle is not available.";
        return;
      }
      const entry = filteredEntries()[cursor];
      if (!entry) {
        message = "No conversation under cursor.";
        return;
      }
      busy = true;
      message = `Toggling ${entry.threadId ?? entry.relativePath}...`;
      render();
      try {
        const updated = await onToggleArchive(entry);
        const index = preview.conversations.findIndex((candidate) => candidate.key === entry.key);
        if (index !== -1) {
          preview.conversations[index] = {
            ...preview.conversations[index],
            ...updated,
            index: preview.conversations[index].index
          };
        }
        if (selectedKeys.has(entry.key) && updated.key !== entry.key) {
          selectedKeys.delete(entry.key);
          selectedKeys.add(updated.key);
        }
        if (transcriptCache.has(entry.key) && updated.key !== entry.key) {
          transcriptCache.set(updated.key, transcriptCache.get(entry.key));
          transcriptCache.delete(entry.key);
        }
        if (expandedKey === entry.key) {
          expandedKey = updated.key;
        }
        message = `${updated.scope === "archived_sessions" ? "Archived" : "Restored"} ${updated.threadId ?? updated.relativePath}.`;
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      } finally {
        busy = false;
        render();
      }
    }

    async function onKeyPress(str, key = {}) {
      if (busy) {
        return;
      }
      if (key.ctrl && key.name === "c") {
        finish(new Error("History export aborted by user."));
        return;
      }
      if (transcriptView) {
        const layout = buildExportBrowserLayout();
        const transcriptLines = buildTranscriptLines(transcriptView.transcript, layout.width);
        const maxScroll = Math.max(0, transcriptLines.length - Math.max(3, layout.height - 5));
        if (key.name === "escape" || (key.ctrl && key.name === "t")) {
          transcriptView = null;
          transcriptScroll = 0;
        } else if (key.name === "up") {
          transcriptScroll = Math.max(0, transcriptScroll - 1);
        } else if (key.name === "down") {
          transcriptScroll = Math.min(maxScroll, transcriptScroll + 1);
        } else if (key.name === "pageup" || key.name === "left") {
          transcriptScroll = Math.max(0, transcriptScroll - Math.max(3, layout.height - 5));
        } else if (key.name === "pagedown" || key.name === "right") {
          transcriptScroll = Math.min(maxScroll, transcriptScroll + Math.max(3, layout.height - 5));
        } else if (key.name === "home") {
          transcriptScroll = 0;
        } else if (key.name === "end") {
          transcriptScroll = maxScroll;
        }
        render();
        return;
      }
      if (key.name === "escape") {
        finish(new Error("History export aborted by user."));
        return;
      }
      if (key.ctrl && key.name === "t") {
        await openTranscriptForCurrentEntry();
        return;
      }
      if (key.ctrl && key.name === "a") {
        for (const entry of filteredEntries()) {
          selectedKeys.add(entry.key);
        }
        render();
        return;
      }
      if (key.ctrl && key.name === "n") {
        selectedKeys.clear();
        render();
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        if (selectedKeys.size === 0) {
          message = "Select at least one conversation before exporting.";
          render();
          return;
        }
        finish(null, preview.conversations
          .filter((entry) => selectedKeys.has(entry.key))
          .map((entry) => entry.key));
        return;
      }
      if (key.name === "up") {
        move(-1);
      } else if (key.name === "down") {
        move(1);
      } else if (key.name === "left" || key.name === "pageup") {
        page(-1);
      } else if (key.name === "right" || key.name === "pagedown") {
        page(1);
      } else if (key.name === "tab") {
        includeArchived = !includeArchived;
        cursor = 0;
        scroll = 0;
        message = includeArchived ? "Archived conversations are visible." : "Archived conversations are hidden.";
      } else if (key.name === "delete") {
        await toggleArchiveForCurrentEntry();
        return;
      } else if (key.ctrl && key.name === "p") {
        await toggleInlinePreview();
        return;
      } else if (key.name === "home") {
        cursor = 0;
      } else if (key.name === "end") {
        cursor = Math.max(0, filteredEntries().length - 1);
      } else if (key.name === "space") {
        const entry = filteredEntries()[cursor];
        if (entry) {
          if (selectedKeys.has(entry.key)) {
            selectedKeys.delete(entry.key);
          } else {
            selectedKeys.add(entry.key);
          }
        }
      } else if (key.name === "backspace") {
        query = query.slice(0, -1);
        cursor = 0;
        scroll = 0;
      } else if (!key.ctrl && !key.meta && str && str >= " " && str !== "\u007f") {
        query += str;
        cursor = 0;
        scroll = 0;
      }
      render();
    }

    process.stdin.on("keypress", onKeyPress);
    process.stdout.on("resize", render);
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
    throw invalidInputError(`Invalid --keep value: ${rawValue}. Expected an integer greater than or equal to ${minimum}.`);
  }
  const keepCount = Number.parseInt(normalized, 10);
  const minimum = allowZero ? 0 : 1;
  if (!Number.isInteger(keepCount) || keepCount < minimum) {
    throw invalidInputError(`Invalid --keep value: ${rawValue}. Expected an integer greater than or equal to ${minimum}.`);
  }
  return keepCount;
}

function createLineWriter(stream) {
  return (value) => stream.write(`${String(value)}\n`);
}

const BEST_EFFORT_STREAMS = new WeakSet();

function createBestEffortLineWriter(stream) {
  if (stream && typeof stream === "object"
      && typeof stream.on === "function"
      && !BEST_EFFORT_STREAMS.has(stream)) {
    stream.on("error", () => {});
    BEST_EFFORT_STREAMS.add(stream);
  }
  return (value) => {
    try {
      stream.write(`${String(value)}\n`, () => {});
    } catch {
      // Progress and diagnostics are observer output and cannot change the operation result.
    }
  };
}

function writeJsonDocument(stream, serialized) {
  const document = `${serialized}\n`;
  if (typeof stream.once !== "function"
      || typeof stream.removeListener !== "function"
      || stream.write.length < 2) {
    stream.write(document);
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const removeErrorListener = () => stream.removeListener("error", onError);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      setImmediate(removeErrorListener);
      if (error) reject(error);
      else resolve();
    };
    const onError = (error) => finish(error);
    stream.once("error", onError);
    try {
      stream.write(document, (error) => finish(error));
    } catch (error) {
      finish(error);
    }
  });
}

function validateJsonHelpArgs(parsed) {
  if (parsed.positionals.length > 1
      || (parsed.positionals[0] && !JSON_KNOWN_COMMANDS.has(parsed.positionals[0]))) {
    throw invalidInputError("Unknown command in JSON help request.");
  }
  for (const [name, count] of Object.entries(parsed.flagCounts)) {
    if (!new Set(["json", "help"]).has(name)) {
      throw invalidInputError(`Unknown option in JSON help request: --${name}`);
    }
    if (count !== 1 || parsed.flags[name] !== true) {
      throw invalidInputError(`Option --${name} must be a standalone flag specified once.`);
    }
  }
}

function fallbackCliErrorDto(error) {
  if (error?.code === "INVALID_INPUT") {
    // Keep structured Core input reasons; the JSON adapter validates plain
    // data and applies its existing whitelist before anything reaches stdout.
    const details = Object.getOwnPropertyDescriptor(error, "details")?.value;
    return {
      code: "INVALID_INPUT",
      message: error instanceof Error ? error.message : "Invalid CLI input.",
      severity: "error",
      retryable: true,
      recoveryRequired: false,
      ...(details === undefined ? {} : { details })
    };
  }
  if (error?.name === "AbortError" && error?.code === "ABORT_ERR") {
    return {
      code: "OPERATION_CANCELLED",
      message: "The operation was cancelled.",
      severity: "info",
      retryable: true,
      recoveryRequired: false
    };
  }
  return {
    code: "INTERNAL_ERROR",
    message: "An internal error occurred.",
    severity: "fatal",
    retryable: false,
    recoveryRequired: false
  };
}

async function cliErrorDto(error, loadCoreImpl) {
  if (error?.code === "INVALID_INPUT"
      || (error?.name === "AbortError" && error?.code === "ABORT_ERR")) {
    return fallbackCliErrorDto(error);
  }
  try {
    const core = await loadCoreImpl();
    if (typeof core.toCoreErrorDto !== "function") {
      return fallbackCliErrorDto(error);
    }
    return core.toCoreErrorDto(error);
  } catch {
    return fallbackCliErrorDto(error);
  }
}

async function executeCommand({ positionals, flags }, context) {
  const {
    command,
    jsonMode,
    stdoutLine,
    stderrLine,
    environment,
    signalTarget,
    loadCoreImpl,
    startWebUiImpl,
    installWindowsLauncherImpl
  } = context;

  if (command === "status") {
    const { getStatus } = await loadCoreImpl();
    const status = await getStatus({
      codexHome: flags["codex-home"],
      sqliteHome: flags["sqlite-home"]
    });
    if (!jsonMode) stdoutLine(renderStatus(status));
    return status;
  }

  if (command === "sync") {
    const { runSync } = await loadCoreImpl();
    const result = await runSync({
      codexHome: flags["codex-home"],
      sqliteHome: flags["sqlite-home"],
      keepCount: parseKeepCount(flags.keep),
      onProgress: createSyncProgressReporter(jsonMode ? stderrLine : stdoutLine, {
        includeBackupPath: !jsonMode
      })
    });
    if (!jsonMode) stdoutLine(summarizeSync(result, "Synchronized"));
    return result;
  }

  if (command === "switch") {
    const { runSwitch } = await loadCoreImpl();
    const provider = positionals[1] ?? flags.provider;
    const result = await runSwitch({
      codexHome: flags["codex-home"],
      sqliteHome: flags["sqlite-home"],
      provider,
      model: flags.model,
      keepRootModel: Boolean(flags["keep-root-model"]),
      keepCount: parseKeepCount(flags.keep),
      onProgress: createSyncProgressReporter(jsonMode ? stderrLine : stdoutLine, {
        includeBackupPath: !jsonMode
      })
    });
    if (!jsonMode) {
      stdoutLine(summarizeSync(result, "Switched to"));
      if (result.modelSync) {
        const { applied, source, model, warning } = result.modelSync;
        if (applied) {
          stdoutLine(`Root-level model: ${model} (source: ${source})`);
        } else if (warning) {
          stdoutLine(`Root-level model: unchanged (${warning})`);
        } else {
          stdoutLine("Root-level model: unchanged (keep-root-model flag set)");
        }
      }
    }
    return result;
  }

  if (command === "diagnostics") {
    const { getDiagnostics } = await loadCoreImpl();
    const result = await getDiagnostics({
      codexHome: flags["codex-home"],
      sqliteHome: flags["sqlite-home"]
    });
    if (!jsonMode) stdoutLine(summarizeDiagnostics(result));
    return result;
  }

  if (command === "repair") {
    const { runRepair } = await loadCoreImpl();
    const result = await runRepair({
      codexHome: flags["codex-home"],
      sqliteHome: flags["sqlite-home"],
      targets: parseRepairTargets(positionals[1]),
      keepCount: parseKeepCount(flags.keep),
      onProgress: createSyncProgressReporter(jsonMode ? stderrLine : stdoutLine, {
        includeBackupPath: !jsonMode,
        stages: REPAIR_PROGRESS_STAGES
      })
    });
    if (!jsonMode) stdoutLine(summarizeRepair(result));
    return result;
  }

  if (command === "export") {
    const {
      getExportHistoryPreview,
      getExportHistoryTranscript,
      parseExportThreadIds,
      runExportHistory,
      toggleExportHistoryArchived
    } = await import("./history-service.js");
    const archivePath = positionals[1] ?? flags.output;
    if (flags.select && flags.ids) {
      throw new Error("Use either --select or --ids, not both.");
    }
    const selectionKeys = flags.select
      ? await chooseExportSelection(
          await getExportHistoryPreview({ codexHome: flags["codex-home"] }),
          {
            onToggleArchive(entry) {
              return toggleExportHistoryArchived({
                codexHome: flags["codex-home"],
                entry
              });
            },
            onLoadTranscript(entry) {
              return getExportHistoryTranscript({
                codexHome: flags["codex-home"],
                entry
              });
            }
          }
        )
      : null;
    const result = await runExportHistory({
      codexHome: flags["codex-home"],
      archivePath,
      selectionKeys,
      threadIds: parseExportThreadIds(flags.ids),
      overwrite: Boolean(flags.overwrite),
      onProgress: createProgressReporter(EXPORT_PROGRESS_STAGES, stdoutLine)
    });
    stdoutLine(summarizeExport(result));
    return result;
  }

  if (command === "import") {
    const { runImportHistory } = await import("./history-service.js");
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
        onProgress: createProgressReporter(IMPORT_PROGRESS_STAGES, stdoutLine)
      });
      stdoutLine(summarizeImport(result));
      return result;
    } finally {
      await conflictResolver?.close?.();
    }
  }

  if (command === "prune-backups") {
    const { runPruneBackups } = await loadCoreImpl();
    const result = await runPruneBackups({
      codexHome: flags["codex-home"],
      keepCount: parseKeepCount(flags.keep, { allowZero: true })
    });
    if (!jsonMode) stdoutLine(summarizePrune(result));
    return result;
  }

  if (command === "watch") {
    const { runWatch } = await loadCoreImpl();
    const debounceMs = flags["debounce-ms"] !== undefined
      ? parseKeepCount(flags["debounce-ms"], { allowZero: true })
      : undefined;
    const handle = await runWatch({
      codexHome: flags["codex-home"],
      sqliteHome: flags["sqlite-home"],
      debounceMs,
      includeStateDb: !flags["no-state-db"],
      once: Boolean(flags.once)
    });
    await new Promise((resolve) => {
      let settled = false;
      const finish = async (source) => {
        if (settled) return;
        settled = true;
        try {
          await handle.stop();
        } catch {
          // Best effort: stop() may already be in flight.
        }
        resolve(source);
      };
      handle.done.then(() => finish("done"), () => finish("done-rejected"));
      if (handle.signalPromise) {
        handle.signalPromise.then(() => finish("signal"), () => finish("signal-rejected"));
      }
      signalTarget.once("SIGINT", () => finish("SIGINT"));
      signalTarget.once("SIGTERM", () => finish("SIGTERM"));
    });
    return {};
  }

  if (command === "web") {
    const startWebUi = startWebUiImpl ?? (await import("./web-server.js")).startWebUi;
    const port = flags.port === undefined ? 8791 : parseKeepCount(flags.port, { allowZero: true });
    const handle = await startWebUi({
      port,
      openBrowser: !flags["no-open"],
      resetAccess: Boolean(flags["reset-access"]),
      codexHome: flags["codex-home"],
      sqliteHome: flags["sqlite-home"]
    });
    stdoutLine(`Codex Provider Sync Web UI: ${handle.url}`);
    if (flags["no-open"] || !handle.browserOpened) {
      stdoutLine(`One-time pairing link: ${handle.pairingUrl}`);
    }
    if (handle.reused) {
      stdoutLine("Opened the existing Codex Provider Sync Web UI instance.");
      return {};
    }
    stdoutLine("The server only listens on 127.0.0.1. Press Ctrl+C to stop it.");
    await new Promise((resolve) => {
      let closing = false;
      const close = async () => {
        if (closing) return;
        closing = true;
        await handle.close().catch(() => {});
        resolve();
      };
      signalTarget.once("SIGINT", close);
      signalTarget.once("SIGTERM", close);
    });
    return {};
  }

  if (command === "restore") {
    const { runRestore } = await loadCoreImpl();
    const backupDir = positionals[1] ?? flags.backup;
    const result = await runRestore({
      codexHome: flags["codex-home"],
      sqliteHome: flags["sqlite-home"],
      backupDir,
      restoreConfig: !flags["no-config"],
      restoreDatabase: !flags["no-db"],
      restoreSessions: !flags["no-sessions"],
      allowSqliteHomeRelocation: Boolean(flags["allow-sqlite-home-relocation"])
    });
    const jsonResult = { ...result, backupDir: path.resolve(backupDir) };
    if (!jsonMode) {
      stdoutLine(`Restored backup from ${path.resolve(backupDir)}`);
      stdoutLine(`Codex home: ${result.codexHome}`);
      stdoutLine(`Provider at backup time: ${result.targetProvider}`);
      if (result.backupInventoryWarning) {
        stdoutLine(`Backup inventory warning: ${result.backupInventoryWarning}`);
      }
    }
    return jsonResult;
  }

  if (command === "install-windows-launcher") {
    const result = await installWindowsLauncherImpl({
      dir: flags.dir,
      codexHome: flags["codex-home"],
      sqliteHome: flags["sqlite-home"]
    });
    if (!jsonMode) {
      stdoutLine("Installed Windows launcher files:");
      stdoutLine(`  Hidden double-click launcher: ${result.vbsPath}`);
      stdoutLine(`  Visible console launcher: ${result.cmdPath}`);
      stdoutLine(`  Target directory: ${result.targetDir}`);
      if (result.codexHome) {
        stdoutLine(`  Fixed CODEX_HOME: ${result.codexHome}`);
      } else {
        stdoutLine("  CODEX_HOME: default current environment / ~/.codex");
      }
      if (result.sqliteHome) {
        stdoutLine(`  Fixed SQLite home: ${result.sqliteHome}`);
      } else {
        stdoutLine("  SQLite home: config / environment / Codex default");
      }
    }
    return result;
  }

  throw invalidInputError(`Unknown command: ${command}`);
}

export async function runCli(argv, options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const parsed = parseArgs(argv);
  const jsonMode = Object.hasOwn(parsed.flags, "json");
  const stdoutLine = createLineWriter(stdout);
  const stderrLine = jsonMode
    ? createBestEffortLineWriter(stderr)
    : createLineWriter(stderr);
  const requestedCommand = parsed.positionals[0];
  let command = requestedCommand ?? "help";
  if (jsonMode && !JSON_KNOWN_COMMANDS.has(command)) command = "unknown";
  let terminalWritten = false;
  const loadCoreImpl = options.loadCoreImpl ?? loadCore;

  const writeEnvelope = async (envelope) => {
    const serialized = JSON.stringify(envelope);
    if (terminalWritten) {
      throw new Error("CLI JSON terminal envelope was already written.");
    }
    terminalWritten = true;
    await writeJsonDocument(stdout, serialized);
  };

  try {
    validateJsonFlag(parsed.flags);
    if (!requestedCommand || requestedCommand === "help" || parsed.flags.help) {
      command = "help";
      if (jsonMode) {
        validateJsonHelpArgs(parsed);
        const envelope = createCliSuccessEnvelope("help", {
          text: HELP_TEXT.trimEnd(),
          requestedCommand: requestedCommand && requestedCommand !== "help"
            ? requestedCommand
            : null
        });
        await writeEnvelope(envelope);
        return cliJsonExitCode(envelope);
      }
      printHelp(stdoutLine);
      return 0;
    }

    assertSupportedNodeVersion();
    validateRemovedSyncOptions(command, parsed.flags);
    if (jsonMode) validateJsonCommandArgs(command, parsed);
    const result = await executeCommand(parsed, {
      command,
      jsonMode,
      stdoutLine,
      stderrLine,
      environment: options.environment ?? process.env,
      signalTarget: options.signalTarget ?? process,
      loadCoreImpl,
      startWebUiImpl: options.startWebUiImpl,
      installWindowsLauncherImpl: options.installWindowsLauncherImpl ?? installWindowsLauncher
    });
    if (jsonMode) {
      const envelope = createCliSuccessEnvelope(command, result);
      await writeEnvelope(envelope);
      return cliJsonExitCode(envelope);
    }
    return 0;
  } catch (error) {
    if (!jsonMode) {
      stderrLine(error instanceof Error ? error.message : String(error));
      return 1;
    }
    const envelope = createCliFailureEnvelope(command, await cliErrorDto(error, loadCoreImpl));
    // Only the sanitized DTO reaches diagnostics; never print raw exception text.
    if (envelope.error.details?.failureStage) stderrLine(`Failure stage: ${envelope.error.details.failureStage}`);
    if (envelope.error.details?.causeCode) stderrLine(`Cause code: ${envelope.error.details.causeCode}`);
    if (!terminalWritten) await writeEnvelope(envelope);
    return cliJsonExitCode(envelope);
  }
}

async function isDirectExecution() {
  if (!process.argv[1]) return false;
  const canonicalPath = async (value) => {
    try {
      return await fs.realpath(value);
    } catch {
      return path.resolve(value);
    }
  };
  const [executedPath, modulePath] = await Promise.all([
    canonicalPath(process.argv[1]),
    canonicalPath(fileURLToPath(import.meta.url))
  ]);
  return process.platform === "win32"
    ? executedPath.toLowerCase() === modulePath.toLowerCase()
    : executedPath === modulePath;
}

if (await isDirectExecution()) {
  try {
    process.exitCode = await runCli(process.argv.slice(2));
  } catch {
    process.exitCode = 1;
  }
}
