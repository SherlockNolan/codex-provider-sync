<div align="center">

# codex-provider-sync

### Keep Codex history visible after switching Providers

[![CI](https://github.com/Dailin521/codex-provider-sync/actions/workflows/ci.yml/badge.svg)](https://github.com/Dailin521/codex-provider-sync/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Dailin521/codex-provider-sync)](https://github.com/Dailin521/codex-provider-sync/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](../LICENSE)
[![Community](https://img.shields.io/badge/community-LINUX%20DO-2ea043.svg)](https://linux.do/)

[Download Windows GUI](https://github.com/Dailin521/codex-provider-sync/releases/latest) · [Build macOS GUI](README_MAC_GUI_EN.md) · [中文](../README.md) · English

</div>

## When You Need It

After switching `model_provider`, older Codex sessions may disappear from Desktop or `/resume`. The sessions are usually still present, but their rollout, SQLite, or project-visibility metadata still points to the previous Provider.

Use this tool when:

- switching between an official subscription (whose internal Provider is `openai`) and a custom relay;
- switching configurations that must use different `model_provider` IDs;
- rollout and SQLite Provider or model metadata has become inconsistent; or
- you want changes to `config.toml`, SQLite, or its WAL to trigger synchronization automatically.

If all of your relays can reliably reuse one `model_provider` ID and history remains visible, using that shared ID is simpler and no synchronization is needed. This project is mainly useful when Provider IDs cannot be unified or when switching between official and custom Providers.

The tool does not sign in, manage accounts, or switch authentication. Switch Provider using your normal workflow first, then synchronize history.

## Relationship to Provider Switchers

Provider managers, including cc-switch, primarily switch accounts, API keys, `auth.json`, or `config.toml`; some also provide their own history handling. codex-provider-sync deliberately leaves authentication alone and focuses on post-switch visibility metadata, rollout files, SQLite state, managed backups, and restoration.

If your current switcher already keeps all history visible, you do not need to run another synchronization. This project remains useful when several switching workflows have split existing history, rollout and SQLite need to be reconciled together, SQLite Home is separate from Codex Home, or backup-backed transactional repair is required.

## What It Updates

- Rollout metadata under `~/.codex/sessions` and `~/.codex/archived_sessions`.
- Codex SQLite thread records, including layouts where SQLite is stored outside Codex Home.
- Project-visibility path information and related model metadata when required.
- Managed backups before each synchronization, with restore and pruning support.
- Large rollout files in place when safe, with automatic fallback to a full safe rewrite.
- Automatic CLI synchronization after `config.toml`, SQLite, or WAL changes.

## Quick Start

### Windows GUI

For normal Windows use, download the standalone GUI from [Releases](https://github.com/Dailin521/codex-provider-sync/releases/latest):

If you already switched auth/provider using your usual method:

```bash
codex-provider sync
```

If you want to change the root `model_provider` and sync history in one step:

```bash
codex-provider switch openai
codex-provider switch apigather
```

If you want a different automatic backup retention count for one run:

```bash
codex-provider sync --keep 5
codex-provider switch apigather --keep 10
```

Check current state first:

```bash
codex-provider status
```

Install a Windows double-click launcher (placed on your Desktop by default):

```bash
codex-provider install-windows-launcher
```

Rollback from a backup:

```bash
codex-provider restore C:\Users\you\.codex\backups_state\provider-sync\<timestamp>
```

Clean old managed backups manually:

```bash
codex-provider prune-backups --keep 5
```

Export history from one device:

```bash
codex-provider export
```

Without an explicit path, export writes `codex-history_YYYYMMDD_HHMMSS.tgz` in the current terminal directory. You can still choose a file name explicitly:

```bash
codex-provider export codex-history.tgz
```

To migrate only selected conversations, preview first and choose by number:

```bash
codex-provider export --select
```

The browser shows thread id, active/archived state, provider, timestamp, renamed title or first user message preview, cwd, and rollout path. Type to search, use `Up/Down` to browse, `Space` to toggle selection, `Left/Right` or `PageUp/PageDown` to page, `Ctrl+P` to expand an inline preview, `Ctrl+T` to open the transcript view, `Tab` to show/hide archived items, `Delete` to toggle the current item between active/archived, `Enter` to export, and `Esc` to exit.

For automation, pass thread ids directly:

```bash
codex-provider export selected-history.tgz --ids thread-a,thread-b
```

Import that archive on another device:

```bash
codex-provider import codex-history.tgz
```

Common import options:

```bash
codex-provider import codex-history.tgz --provider openai --conflict ask
codex-provider import codex-history.tgz --conflict skip
codex-provider import codex-history.tgz --dry-run
```

## AI Quick Run

If you want an AI assistant to handle this in one shot, copy this prompt:

```text
Help me fix Codex session visibility with codex-provider-sync.

Steps:
1. Run `codex-provider status`.
2. If my current provider is already correct, run `codex-provider sync`.
3. If I explicitly want to switch provider, run `codex-provider switch <provider-id>` instead.
4. If `state_5.sqlite` is currently in use, tell me to close Codex / Codex App / app-server and retry.
5. If sync skips locked rollout files, tell me which files were skipped and remind me to rerun `codex-provider sync` later.
6. Summarize the final provider counts in rollout files and SQLite.
```

If the user prefers the GUI, the AI can instead guide these steps:

1. Open `CodexProviderSync.exe`
2. Confirm the `.codex` path
3. Click `Refresh`
4. Pick the target provider from the list
5. Enable the config checkbox only if root `model_provider` should also change
6. Click `Execute`
7. Read the log panel for backup path, updated rollout files, SQLite rows, and skipped locked files

Quick mapping:

- inspect only: `codex-provider status`
- fix visibility under current provider: `codex-provider sync`
- switch provider and sync: `codex-provider switch openai`
- install a desktop double-click launcher: `codex-provider install-windows-launcher`
- roll back a mistake: `codex-provider restore <backup-dir>`

## Commands

- `codex-provider status`
  - shows current provider, the detected SQLite database path, and provider distribution in rollout files and SQLite
- `codex-provider sync`
  - syncs history to the current provider
  - `--provider <id>` overrides the target provider
  - if root `model_provider` is missing, it falls back to `openai`
- `codex-provider switch <provider-id>`
  - updates root `model_provider` in `config.toml`
  - immediately runs a sync
  - `--keep <n>` overrides how many managed backups are retained after the run
- `codex-provider export [archive-path]`
  - exports `sessions`, `archived_sessions`, and detected SQLite thread metadata to a `.tgz` archive
  - defaults to `codex-history_YYYYMMDD_HHMMSS.tgz` in the current terminal directory
  - `--select` previews conversations and interactively chooses what to export
  - `--ids <id[,id]>` exports only specific thread ids
  - use `--overwrite` to replace an existing archive file
- `codex-provider import <archive-path>`
  - imports a history archive on another device
  - incrementally merges only the records present in the archive
  - defaults imported records to the destination current provider
  - `--provider <id>` overrides the import provider
  - `--conflict ask|skip|overwrite|fail` controls same-thread conflicts
  - `--dry-run` reports the plan without writing
- `codex-provider prune-backups`
  - manually removes older managed backups and keeps the newest `n`
- `codex-provider restore <backup-dir>`
  - restores a previous backup
  - use `--no-config`, `--no-db`, or `--no-sessions` to skip a restore target
- `codex-provider install-windows-launcher`
  - creates two files on the Desktop by default
  - `Codex Provider Sync.vbs`: hidden double-click launcher with a result popup
  - `Codex Provider Sync.cmd`: visible console version for troubleshooting
  - use `--dir <path>` to choose another install directory
  - use `--codex-home <path>` to bake a fixed `CODEX_HOME` into the launcher
| Use case | Release asset | Update method |
| --- | --- | --- |
| Windows GUI only | `CodexProviderSync.exe` | Built-in updates supported |
| Scripts, CI, or AI agents | `codex-provider-sync-v<version>-automation-win-x64.zip` | Manual update |
| GUI and Automation together | `codex-provider-sync-v<version>-win-x64.zip` | Manual update |

1. Open `CodexProviderSync.exe`.
2. Click `刷新` (Refresh).
3. Select the target Provider.
4. Click `立即同步` (Sync Now).

The GUI keeps backups and displays the synchronization result. It checks for a stable release in the background on the first launch of each local day, with a 10-second lookup deadline. Manual update checks remain available. Execution logs are stored under `%AppData%\codex-provider-sync\logs`.

The Windows GUI supports a separate SQLite Home on the Windows filesystem for each Codex Home. WSL UNC paths such as `\\wsl.localhost\...` and `\\wsl$\...` are diagnostic-only; the GUI reports the safety boundary and disables synchronization and restore. Run the CLI inside WSL for a Windows Codex Home plus WSL SQLite Home layout.

The Windows executable is currently unsigned, so browser downloads may trigger a SmartScreen warning. Download it only from this project's Releases and verify the matching SHA-256 when needed.

See [README_GUI_ZH.md](README_GUI_ZH.md) for the full Windows guide. A self-built Avalonia macOS app is also available; see the [English macOS GUI guide](README_MAC_GUI_EN.md).

### CLI

The CLI requires Node.js `16+`:

```bash
npm install -g git+https://github.com/Dailin521/codex-provider-sync.git
codex-provider status
codex-provider sync
codex-provider sync --keep 5
codex-provider sync --provider openai
codex-provider switch openai
codex-provider switch apigather
codex-provider export
codex-provider export --select
codex-provider export selected-history.tgz --ids thread-a,thread-b
codex-provider import codex-history.tgz
codex-provider import codex-history.tgz --provider openai --conflict ask
codex-provider prune-backups --keep 5
codex-provider install-windows-launcher
codex-provider install-windows-launcher --dir D:\Tools
codex-provider install-windows-launcher --codex-home C:\Users\you\.codex
codex-provider restore C:\Users\you\.codex\backups_state\provider-sync\20260319T042708906Z
codex-provider status --codex-home C:\Users\you\.codex
codex-provider sync --codex-home C:\Users\you\.codex
codex-provider switch apigather --codex-home C:\Users\you\.codex
codex-provider restore C:\Users\you\.codex\backups_state\provider-sync\20260319T042708906Z
```

Common commands:

Before each sync/import, the tool creates a backup under:
| Command | Purpose |
| --- | --- |
| `codex-provider status` | Inspect the current Provider, rollout files, SQLite, and project visibility |
| `codex-provider sync` | Synchronize history to the current Provider without changing authentication |
| `codex-provider switch <provider-id>` | Change the root `model_provider`, then synchronize |
| `codex-provider restore <backup-dir>` | Restore a selected backup |
| `codex-provider prune-backups --keep 5` | Keep only the five newest managed backups |
| `codex-provider watch` | Watch config, SQLite, and WAL changes and synchronize automatically |
| `codex-provider watch --once` | Exit after the first change is synchronized successfully |

`switch` accepts `--model <NAME>` to set the root model explicitly, or `--keep-root-model` to change only the Provider. All main commands accept `--codex-home <PATH>` and `--sqlite-home <PATH>`.

SQLite Home precedence is: CLI override, root-level `sqlite_home` in `config.toml`, `CODEX_SQLITE_HOME`, then `<Codex Home>/sqlite`. The legacy `<Codex Home>/state_5.sqlite` fallback is enabled only for the default layout. An explicit SQLite Home never falls back to a stale database under Codex Home.

For a Windows Codex Home with app-server and SQLite running in WSL, invoke the CLI from WSL:

```bash
codex-provider status --codex-home /mnt/c/Users/you/.codex --sqlite-home /home/you/.codex/sqlite
codex-provider sync --codex-home /mnt/c/Users/you/.codex --sqlite-home /home/you/.codex/sqlite
```

`status` reports the effective SQLite Home and its source. If an explicit location has no `state_5.sqlite`, read-only status reports the diagnostic while write operations fail. If a database is deleted from the default layout, `restore` can rebuild it at its original default location from backup metadata. New metadata v2 backups record the separate SQLite Home. Restoring a v2 backup to a different SQLite Home is rejected unless relocation is explicitly confirmed; the CLI requires `--sqlite-home`, `--allow-sqlite-home-relocation`, and `--no-config` so the restored config cannot point Codex back to the source SQLite Home.

Node.js 24+ uses the built-in `node:sqlite` module. Older supported Node.js releases use the optional `better-sqlite3` dependency.

### Automation API (experimental v0.4)

Releases provide a separate Windows Automation package containing `CodexProviderSync.Automation.exe`, `automation-protocol-v0.4.schema.json`, and a Chinese quick start. The complete Windows package contains the same files. This one-shot process interface uses the same Application use cases as the Windows GUI. Each invocation emits exactly one protocol `0.4` JSON document on stdout and sends diagnostics to stderr. Normal desktop users do not need the Automation package.

| Command | Purpose |
| --- | --- |
| `describe` | Describe protocol capabilities and safety requirements |
| `status` | Read status and diagnostics |
| `plan --operation sync\|switch\|restore\|prune` | Create a plan for a selected write operation |
| `sync` | Plan or explicitly apply synchronization |
| `switch` | Plan or explicitly apply a Provider/model switch and synchronization |
| `restore` | Plan or explicitly apply backup restoration |
| `prune` | Plan or explicitly prune managed backups |

Every write command is dry-run by default and returns a plan without modifying a target. Mutation requires `--apply`, a plan file containing only the `data` object from the `plan` response, and that object's exact lowercase SHA-256 `digest`:

```powershell
.\CodexProviderSync.Automation.exe describe
.\CodexProviderSync.Automation.exe status --codex-home C:\isolated\.codex
.\CodexProviderSync.Automation.exe sync --codex-home C:\isolated\.codex --provider openai
$planResponse = .\CodexProviderSync.Automation.exe plan --operation sync --codex-home C:\isolated\.codex --provider openai | ConvertFrom-Json
$planResponse.data | ConvertTo-Json -Depth 100 -Compress | Set-Content -LiteralPath C:\isolated\sync-plan.json -Encoding utf8NoBOM
$planDigest = $planResponse.data.digest
.\CodexProviderSync.Automation.exe sync --codex-home C:\isolated\.codex --provider openai --apply --plan C:\isolated\sync-plan.json --plan-digest $planDigest
```

Plans expire, bind normalized inputs and target state, and are single-use through a durable ledger. The default ledger is `<Codex Home>\tmp\provider-sync-automation-ledger`. Every path argument must be absolute and may not traverse a symbolic link or reparse point. Automation also rejects direct access to `auth.json`. The protocol remains experimental before 1.0; compatibility is not promised outside protocol family `0.4`.

## Safety and Limitations

Before each `sync` or `switch`, the tool creates a backup under:

```text
~/.codex/backups_state/provider-sync/<timestamp>
```

- It does not modify messages, session titles, authentication, `auth.json`, or `updated_at`.
- It does not copy configuration or session files between devices; it only repairs metadata in the current Codex Home.
- If SQLite is in use, close Codex, Codex App, and app-server before retrying.
- A Windows process that resolves SQLite Home through a WSL UNC path reports a dedicated safety diagnostic and stops immediately. Continue inside that WSL distribution with the Linux `/home/...` path.
- If a live session locks a rollout file, the tool skips that file and continues. Run sync again after the session ends for a complete update.
- Sessions containing `encrypted_content` may become visible across Providers/accounts but still fail to continue or compact with `invalid_encrypted_content`.
- Codex Desktop currently shows only the latest 50 sessions on its first page. If `/resume` can see a session but the project view cannot, inspect the `first page` / `ranks` diagnostics. This tool does not alter timestamps to bypass that upstream limit.

## Documentation

- It does not replace official `codex`.
- It does not manage `auth.json` or third-party login tools.
- History archives do not include `auth.json`, `config.toml`, logs, caches, or old backups.
- Import does not log you in or configure providers on the new device.
- It does not rewrite message history, titles, cwd, or timestamps.
- It keeps the newest 5 managed backups by default; GUI retention settings or CLI `--keep <n>` can override that.
- Manual cleanup and auto-prune only touch backups created by this tool inside `backups_state/provider-sync`.
- `Codex Provider Sync.vbs` assumes the `codex-provider` command is already available.
- If `state_5.sqlite` is in use, close Codex / Codex App / app-server and retry.
- If `state_5.sqlite` is malformed, the tool reports it as malformed/unreadable and blocks sync; back up, repair, or remove the damaged database before retrying.
- If a live session keeps one rollout file open, `sync` skips that file and reports it. Rerun later.
- If history contains `encrypted_content`, switching across providers/accounts may restore visibility only; continuing or compacting those sessions can still fail with `invalid_encrypted_content` because this tool cannot re-encrypt Codex history.

## EXE double-click troubleshooting

1. Fully extract the release archive before running `CodexProviderSync.exe`.
2. If no window appears, open PowerShell in the EXE directory and run `./CodexProviderSync.exe`.
3. Check Windows SmartScreen, Defender, or third-party antivirus blocks.
4. Check `%AppData%\codex-provider-sync\startup-error.log`; startup exceptions are written there.

## For AI Agents

For a fuller machine-oriented version, see [AGENTS.md](../AGENTS.md).
- [Windows GUI guide](README_GUI_ZH.md)
- [macOS GUI guide](README_MAC_GUI_EN.md)
- [v0.4.1 Chinese release announcement](release-notes/v0.4.1-zh.md)
- [v0.4.0 Chinese release announcement](release-notes/v0.4.0-zh.md)
- [v0.4.0 technical release notes](RELEASE_NOTES_V0.4.0.md)
- [Changelog](../CHANGELOG.md)
- [Chinese Automation quick start](AUTOMATION_QUICKSTART_ZH.md)
- [v0.4 Automation execution plan](V0.4_AUTOMATION_PLAN.md)
- [中文说明](../README.md)
- [AI / Agent guide](../AGENTS.md)
- [Contributing guide](../CONTRIBUTING.md#english-quick-guide)

## Development

```bash
git clone https://github.com/Dailin521/codex-provider-sync.git
cd codex-provider-sync
npm test
dotnet test desktop/CodexProviderSync.Core.Tests/CodexProviderSync.Core.Tests.csproj
./scripts/test-wsl-unc-safety.sh
pwsh ./scripts/publish-gui.ps1
pwsh ./scripts/run-windows-gui-e2e.ps1
./scripts/publish-gui-macos.sh
```

Run `test-wsl-unc-safety.sh` from WSL. It invokes Windows `dotnet.exe` to verify the safety guard against a real SQLite database on WSL ext4. Run `run-windows-gui-e2e.ps1` only on a visible, interactive Windows desktop. The v0.4 implementation commit `7545b5d` passed this gate with 40/40 manifest entries covered, 53/53 required scenarios passed, and zero errors or blockers; the evidence gate also verified the published EXE hash, real control events, native dialogs, file/SQLite effects, restart persistence, and GUI-to-Application traces. Relevant later implementation changes require another run. Hidden, skipped, or direct-Application runs are not substitutes.

## License

MIT
