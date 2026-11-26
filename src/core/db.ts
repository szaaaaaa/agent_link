import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function openStateDb(dataDir = join(homedir(), ".agent-link")): DatabaseSync {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(dataDir, "state.sqlite"));

  try {
    db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      BEGIN;

      CREATE TABLE IF NOT EXISTS workspaces (
        workspace_key TEXT PRIMARY KEY,
        raw_path      TEXT NOT NULL,
        enabled       INTEGER NOT NULL DEFAULT 1,
        created_at    INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS threads (
        thread_id     TEXT PRIMARY KEY,
        workspace_key TEXT NOT NULL,
        title         TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'SYNCED',
        head_turn_id  TEXT,
        lca_turn_id   TEXT,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS bindings (
        thread_id            TEXT NOT NULL,
        agent                TEXT NOT NULL,
        native_session_id    TEXT NOT NULL,
        native_path          TEXT,
        last_byte_offset     INTEGER NOT NULL DEFAULT 0,
        last_native_cursor   TEXT,
        last_written_turn_id TEXT,
        last_seen_turn_id    TEXT,
        branch_head_turn_id  TEXT,
        last_git_head        TEXT,
        last_git_fp          TEXT,
        updated_at           INTEGER NOT NULL,
        PRIMARY KEY (thread_id, agent),
        UNIQUE (agent, native_session_id)
      );

      CREATE TABLE IF NOT EXISTS pi_entries (
        thread_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        parent_id TEXT,
        injected_turn_id TEXT,
        PRIMARY KEY (thread_id, entry_id)
      ) WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS agy_sessions (
        conversation_id TEXT PRIMARY KEY,
        workspace_key TEXT NOT NULL,
        transcript_path TEXT NOT NULL,
        file_key TEXT NOT NULL,
        byte_offset INTEGER NOT NULL DEFAULT 0,
        full_offset INTEGER NOT NULL DEFAULT 0,
        invocation_step INTEGER NOT NULL DEFAULT -1
      );

      CREATE TABLE IF NOT EXISTS codex_deliveries (
        native_session_id TEXT NOT NULL,
        native_turn_id TEXT NOT NULL,
        marker TEXT NOT NULL,
        through_turn_id TEXT NOT NULL,
        PRIMARY KEY (native_session_id, native_turn_id)
      ) WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS turns (
        turn_id              TEXT PRIMARY KEY,
        thread_id            TEXT NOT NULL,
        parent_turn_id       TEXT,
        merge_parent_turn_id TEXT,
        origin_agent         TEXT NOT NULL,
        source_turn_key      TEXT NOT NULL UNIQUE,
        state                TEXT NOT NULL DEFAULT 'active',
        byte_pos             INTEGER NOT NULL,
        byte_len             INTEGER NOT NULL,
        git_head             TEXT,
        git_fp               TEXT,
        touched_files        TEXT,
        created_at           INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS native_writes (
        agent        TEXT NOT NULL,
        native_path  TEXT NOT NULL,
        start_offset INTEGER NOT NULL,
        end_offset   INTEGER NOT NULL,
        turn_id      TEXT NOT NULL,
        status       TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        payload_hash TEXT,
        PRIMARY KEY (native_path, start_offset)
      );
    `);
    if (!db.prepare("PRAGMA table_info(native_writes)").all().some((column) => column.name === "payload_hash")) {
      db.exec("ALTER TABLE native_writes ADD COLUMN payload_hash TEXT");
    }
    const writeColumns = db.prepare("PRAGMA table_info(native_writes)").all().map((column) => column.name);
    if (!writeColumns.includes("requires_projection")) {
      db.exec("ALTER TABLE native_writes ADD COLUMN requires_projection INTEGER NOT NULL DEFAULT 0");
    }
    if (!writeColumns.includes("resume_turn_id")) db.exec("ALTER TABLE native_writes ADD COLUMN resume_turn_id TEXT");
    const bindingColumns = db.prepare("PRAGMA table_info(bindings)").all().map((column) => column.name);
    for (const [name, definition] of [["native_file_key", "TEXT"], ["mirror_pending", "INTEGER NOT NULL DEFAULT 0"],
      ["native_notice", "TEXT"], ["last_timeline_turn_id", "TEXT"], ["projection_pending", "INTEGER NOT NULL DEFAULT 0"]]) {
      if (!bindingColumns.includes(name)) db.exec(`ALTER TABLE bindings ADD COLUMN ${name} ${definition}`);
    }
    if (!bindingColumns.includes("last_timeline_turn_id")) {
      // Old versions conflated delivery and timeline. Recover known own/ledger turns, but never claim a Hook-only turn is visible.
      db.exec(`UPDATE bindings AS b SET last_timeline_turn_id = CASE
        WHEN EXISTS (SELECT 1 FROM turns t WHERE t.turn_id = b.last_written_turn_id AND t.origin_agent = b.agent)
          OR EXISTS (SELECT 1 FROM native_writes n WHERE n.native_path = b.native_path AND n.turn_id = b.last_written_turn_id AND n.status = 'done')
          OR (b.last_seen_turn_id IS NULL AND b.mirror_pending = 0) THEN b.last_written_turn_id ELSE NULL END,
        last_seen_turn_id = COALESCE(b.last_seen_turn_id, b.last_written_turn_id)`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS native_writes_path_turn ON native_writes(native_path, turn_id);
      CREATE INDEX IF NOT EXISTS turns_thread_parent ON turns(thread_id, parent_turn_id);
      CREATE INDEX IF NOT EXISTS bindings_native_path ON bindings(native_path); COMMIT;`);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
