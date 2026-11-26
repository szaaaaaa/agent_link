# Agent Link Pi extension

From the repository root:

```sh
npm ci
npm run build
node dist/cli.js install
node dist/cli.js watch /absolute/path/to/project
```

Start Pi in the watched project (restart Pi if the extension was just installed). For a one-off load without installing global extensions, use `pi -e /absolute/path/to/agent_link/integrations/pi-extension/index.ts`. The extension uses the same `AGENT_LINK_HOME`, `PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR`, and `CODEX_HOME` as the Daemon. On Windows, the widget above the input shows pending Codex replies. `/sync` waits for Pi to go idle, appends missing native turns if the file and the current Pi leaf still match, then reloads the same session without sending a model prompt. If the user prompts first, Pi can still include unread Codex history as a custom message. The extension uses local IPC; it has no SQLite imports.

Agent Link publishes a first mirror in the other client. For an existing binding on Windows, exit the target client, then run:

```sh
node dist/cli.js sync-offline <thread_id> <pi|codex> --closed
```

The command checks the native file, drains it under a writer lease, and appends only synced backlog. Reopen the target client once the command returns. The lease protects the file; it cannot detect a session that is open only in memory, so do not use `--closed` while that client is still open. Codex legacy and native paginated sessions are supported; the Daemon retries automatically when Codex releases its write handle. See the [Codex instructions](../codex-hooks/README.md) for configuration and the current migration boundary.

Reproduce the isolated client smoke test with Node 22.13+ and the clients installed:

```sh
PI_CLI=/absolute/path/to/pi CODEX_CLI=/absolute/path/to/codex node scripts/verify-m2.mjs
```

On Windows point these variables to executables or JavaScript launchers, not `.cmd` wrappers. The script uses temporary client homes and a local mock model endpoint; it does not use real accounts or existing session files.
