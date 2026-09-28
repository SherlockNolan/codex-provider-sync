// Compatibility adapter. New product transports enter through
// @codex-provider-sync/core; legacy CLI/tests keep their stable root import.
export {
  applyRepair,
  applyRestore,
  applySwitch,
  applySync,
  getStatus,
  prepareRepair,
  prepareRestore,
  prepareSwitch,
  prepareSync,
  pruneBackups,
  runPruneBackups,
  runRepair,
  runRestore,
  runSwitch,
  runSync,
  waitForManualOperationEnd
} from "../packages/core/src/application/service-runtime.js";

export {
  defaultHistoryArchivePath,
  getExportHistoryPreview,
  getExportHistoryTranscript,
  parseExportThreadIds,
  runExportHistory,
  runImportHistory,
  toggleExportHistoryArchived
} from "./history-service.js";
