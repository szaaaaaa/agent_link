import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import type { NativeTurn, ToolEvent, Turn } from "./types.js";
import { normalizeWorkspace } from "../core/workspace.js";

interface CodexMeta { id: string; cwd: string; modelProvider?: string; version?: string; historyMode?: string }
export interface CodexSession extends CodexMeta { path: string; model: string; created: number; ordinal: number }

export function codexHeader(line: string): CodexMeta | null {
  const row = JSON.parse(line);
  const meta = row?.payload;
  if (row?.type !== "session_meta" || typeof meta?.id !== "string" || !meta.id || typeof meta.cwd !== "string" ||
      (meta.session_id != null && meta.session_id !== meta.id) || meta.parent_thread_id || meta.parent_session_id ||
      meta.forked_from_id || [meta.source, meta.thread_source].some((source) => typeof source === "string"
        ? /sub.?agent/i.test(source) : source && typeof source === "object" && Object.keys(source).some((key) => /sub.?agent/i.test(key)))) return null;
  return { id: meta.id, cwd: meta.cwd, modelProvider: meta.model_provider, version: meta.cli_version,
    historyMode: typeof meta.history_mode === "string" ? meta.history_mode : undefined };
}

const own = /<!-- agent-link:tu_[0-9A-Z]+ -->\s*$/;

export function codexReader(parent: () => string | null, receive?: (turnId: string, marker: string) => string | null,
  activity?: (running: boolean) => void) {
  let user: string | undefined;
  let assistant = "";
  let tools: ToolEvent[] = [];
  let turnId: string | undefined;
  let received: string | null = null;
  return (line: string | null): (NativeTurn & { anchor: string; parentTurnId: string | null }) | null | undefined => {
    if (line === null) {
      if (turnId || user !== undefined) tools.push({ kind: "oversized" });
      return turnId || user !== undefined ? undefined : null;
    }
    const row = JSON.parse(line);
    const payload = row?.payload;
    if (receive && turnId && row?.type === "response_item" && payload?.type === "message" &&
        payload.role === "developer" && Array.isArray(payload.content)) {
      for (const entry of payload.content) {
        const marker = typeof entry?.text === "string" && /<!-- agent-link-delivery:([0-9a-f]{32}) -->/.exec(entry.text);
        if (marker) received = receive(turnId, marker[1]) ?? received;
      }
    }
    if (row?.type !== "event_msg" || !payload) return turnId || user !== undefined ? undefined : null;
    if (payload.type === "task_started" && typeof payload.turn_id === "string") {
      turnId = payload.turn_id;
      activity?.(true);
      received = null;
      user = undefined;
      assistant = "";
      tools = [];
    } else if (payload.type === "user_message" && typeof payload.message === "string") {
      user = payload.message;
    } else if (payload.type === "agent_message" && typeof payload.message === "string") {
      assistant = payload.message;
    } else if (payload.type === "item_completed") {
      const item = payload.item;
      if (payload.turn_id === turnId && Array.isArray(item?.content)) {
        const body = item.content.filter((part: { type: string; text?: string }) => part.type.toLowerCase() === "text" &&
          typeof part.text === "string").map((part: { text: string }) => part.text).join("\n");
        if (item.type === "UserMessage") user = body;
        if (item.type === "AgentMessage") assistant = body;
      }
    } else if (payload.type === "exec_command_end" && Array.isArray(payload.command) && Number.isInteger(payload.exit_code)) {
      tools.push({ kind: "command", command: payload.command.join(" "), exitCode: payload.exit_code,
        errorOutput: typeof payload.stderr === "string" ? payload.stderr : undefined });
    } else if (payload.type === "task_complete" || payload.type === "turn_aborted") {
      activity?.(false);
      const anchor = payload.turn_id ?? turnId;
      const result = payload.type === "task_complete" && typeof anchor === "string" && (!turnId || turnId === anchor) &&
        user !== undefined && !own.test(assistant) && !own.test(payload.last_agent_message ?? "")
        ? { anchor, parentTurnId: received ?? parent(), userText: user, assistantText: payload.last_agent_message || assistant, tools } : null;
      user = undefined;
      assistant = "";
      turnId = undefined;
      received = null;
      tools = [];
      return result;
    }
    return turnId || user !== undefined ? undefined : null;
  };
}

export function describeCodexSession(
  home: string, cwd: string, modelProvider: string, model: string, version?: string,
): CodexSession & { header: string } {
  if (!modelProvider || !model) throw new Error("Codex model provider and model are required to create a rollout");
  const id = randomUUID();
  const created = Date.now();
  const timestamp = new Date(created).toISOString();
  const [year, month, day] = timestamp.slice(0, 10).split("-");
  const dir = join(home, "sessions", year, month, day);
  const path = join(dir, `rollout-${timestamp.slice(0, 19).replaceAll(":", "-")}-${id}.jsonl`);
  const payload = { id, session_id: id, cwd, timestamp, runtime_workspace_roots: [cwd], originator: "codex_cli_rs",
    cli_version: version ?? "", source: "cli", thread_source: "user", model_provider: modelProvider, history_mode: "legacy" };
  return { id, cwd, path, modelProvider, model, version, created, ordinal: 0,
    header: JSON.stringify({ timestamp, ordinal: 0, type: "session_meta", payload }) + "\n" };
}

export async function createCodexSession(
  home: string, cwd: string, modelProvider: string, model: string, version?: string,
): Promise<CodexSession> {
  const { header, ...session } = describeCodexSession(home, cwd, modelProvider, model, version);
  await mkdir(dirname(session.path), { recursive: true });
  await writeFile(session.path, header, { flag: "wx", mode: 0o600 });
  return session;
}

export function encodeCodexTurn(turn: Turn, session: Pick<CodexSession, "cwd" | "model"> &
  Partial<Pick<CodexSession, "ordinal" | "id" | "historyMode">>): string {
  const date = new Date(turn.created_at);
  const timestamp = date.toISOString();
  const started_at = Math.floor(turn.created_at / 1000);
  const turn_id = randomUUID();
  let ordinal = session.ordinal;
  const row = (type: string, payload: object) =>
    JSON.stringify({ timestamp, ordinal: ordinal === undefined ? undefined : ++ordinal, type, payload }) + "\n";
  const event = (type: string, payload: object) => row("event_msg", { type, turn_id, ...payload });
  const message = (role: string, type: string, text: string) => row("response_item", {
    type: "message", role, content: [{ type, text }],
  });
  const user = turn.user_text;
  const assistant = turn.assistant_text +
    (turn.tool_digest.length ? "\n\n```text\n" + turn.tool_digest.join("\n") + "\n```" : "") +
    `\n<!-- agent-link:${turn.turn_id} -->`;
  const context = { turn_id, root_turn_id: turn_id, cwd: session.cwd, model: session.model,
    approval_policy: "never", sandbox_policy: { type: "read-only" }, summary: "auto" };
  const started = { root_turn_id: turn_id, started_at, collaboration_mode_kind: "default" };
  const completed = { last_agent_message: assistant, started_at, completed_at: started_at };
  if (session.historyMode === "paginated") {
    if (!session.id || !Number.isSafeInteger(ordinal) || ordinal! < 0 || ordinal! > Number.MAX_SAFE_INTEGER - 7) {
      throw new Error("Paginated Codex append requires a session ID and a valid ordinal");
    }
    const item = (type: "UserMessage" | "AgentMessage", text: string) => event("item_completed", {
      thread_id: session.id, started_at_ms: turn.created_at, completed_at_ms: turn.created_at,
      item: { type, id: randomUUID(), content: type === "UserMessage"
        ? [{ type: "text", text, text_elements: [] }] : [{ type: "Text", text }] },
    });
    return row("turn_context", context) + event("task_started", started) +
      message("user", "input_text", user) + item("UserMessage", user) +
      message("assistant", "output_text", assistant) + item("AgentMessage", assistant) + event("task_complete", completed);
  }
  return row("turn_context", context) + event("task_started", started) +
    message("user", "input_text", user) + event("user_message", { message: user, images: [], text_elements: [] }) +
    message("assistant", "output_text", assistant) + event("agent_message", { message: assistant }) +
    event("task_complete", { last_agent_message: assistant, started_at, completed_at: started_at });
}

export function codexDefaults(home: string, cwd: string) {
  const settings = ["model_provider", "model", "cli_version"];
  let row: Record<string, unknown> = {};
  try {
    const db = new DatabaseSync(join(home, "state_5.sqlite"), { readOnly: true });
    try {
      const columns = db.prepare("PRAGMA table_info(threads)").all().map((column) => column.name);
      const selected = settings.filter((name) => columns.includes(name)).join(",");
      if (selected && columns.includes("cwd") && columns.includes("updated_at")) {
        row = db.prepare(`SELECT ${selected} FROM threads ORDER BY (cwd = ?) DESC, updated_at DESC LIMIT 1`).get(cwd) ?? {};
      }
    } finally { db.close(); }
  } catch { /* Codex has not created its index yet. */ }
  let config = "";
  try {
    // shortcut: recognize plain top-level assignments; the state index covers resolved profile values after first use.
    config = readFileSync(join(home, "config.toml"), "utf8").split(/^\s*\[/m, 1)[0];
  } catch { /* A default Codex install may have no config. */ }
  const value = (name: string) => new RegExp(`^\\s*${name}\\s*=\\s*["']([a-zA-Z0-9_.:/-]+)["']`, "m").exec(config)?.[1] ||
    (typeof row[name] === "string" ? row[name] : undefined);
  return { modelProvider: value("model_provider") || "openai", model: value("model") || "gpt-5",
    version: value("cli_version") };
}

const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';

export function refreshCodexIndex(home: string, id: string, path: string, writtenAt: number): string | null {
  const fallback = `codex resume ${id}`;
  try {
    const indexPath = join(home, "state_5.sqlite");
    if (!lstatSync(indexPath).isFile()) return fallback;
    const db = new DatabaseSync(indexPath);
    try {
      db.exec("PRAGMA busy_timeout = 1000");
      const cols = db.prepare("PRAGMA table_info(threads)").all().map((col) => col.name);
      if (!["id", "rollout_path", "updated_at"].every((name) => cols.includes(name))) return fallback;
      const indexed = db.prepare("SELECT rollout_path FROM threads WHERE id = ?").get(id)?.rollout_path;
      const key = normalizeWorkspace(path);
      if (typeof indexed !== "string" || !key || normalizeWorkspace(indexed) !== key) return fallback;
      const timestamps = ["updated_at", "updated_at_ms", "recency_at", "recency_at_ms"].filter((name) => cols.includes(name));
      const changes = timestamps.map((name) => `${name} = MAX(COALESCE(${name}, 0), ?)`);
      const result = db.prepare(`UPDATE threads SET ${changes.join(", ")} WHERE id = ? AND rollout_path = ?`)
        .run(...timestamps.map((name) => name.endsWith("_ms") ? writtenAt : Math.floor(writtenAt / 1000)), id, indexed);
      return result.changes === 1 ? null : fallback;
    } finally { db.close(); }
  } catch { return fallback; }
}

export function registerCodexSession(home: string, session: CodexSession, title: string): string | null {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(join(home, "state_5.sqlite"), { open: false });
    // Opening with readOnly:false normally creates a database. Require the client's schema to exist first.
    const inspect = new DatabaseSync(join(home, "state_5.sqlite"), { readOnly: true });
    try {
      const cols = inspect.prepare("PRAGMA table_info(threads)").all();
      const schema = new Set(cols.map((col) => col.name));
      for (const name of ["id", "rollout_path", "created_at", "updated_at", "cwd", "title"]) {
        if (!schema.has(name)) throw new Error("Missing Codex threads column: " + name);
      }
      const same = inspect.prepare("SELECT * FROM threads WHERE cwd = ? ORDER BY updated_at DESC LIMIT 1").get(session.cwd);
      const fallback = inspect.prepare("SELECT * FROM threads ORDER BY updated_at DESC LIMIT 1").get();
      const seconds = Math.floor(session.created / 1000);
      const explicit: Record<string, SQLInputValue> = { id: session.id, rollout_path: session.path, created_at: seconds,
        updated_at: seconds, created_at_ms: session.created, updated_at_ms: session.created, recency_at: seconds,
        recency_at_ms: session.created, cwd: session.cwd, title: "[Sync] " + title, source: "cli",
        model_provider: session.modelProvider ?? "", model: session.model, cli_version: session.version ?? "",
        sandbox_policy: '{"type":"read-only"}', approval_mode: "never", has_user_event: 1, history_mode: "legacy",
        thread_source: "user", first_user_message: title, preview: title, originator: "codex_cli_rs" };
      const names: string[] = [];
      const values: SQLInputValue[] = [];
      for (const col of cols) {
        const name = String(col.name);
        const required = col.notnull === 1 && col.dflt_value === null;
        if (!Object.hasOwn(explicit, name) && !required) continue;
        names.push(quote(name));
        const affinity = String(col.type).toUpperCase();
        const zero = affinity.includes("BLOB") ? Buffer.alloc(0) : /INT|REAL|FLOAT|DOUBLE|NUM|BOOL/.test(affinity) ? 0 : "";
        values.push(Object.hasOwn(explicit, name) ? explicit[name] : same?.[name] ?? fallback?.[name] ?? zero);
      }
      db.open();
      db.exec("PRAGMA busy_timeout = 250");
      db.prepare(`INSERT INTO threads (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})
        ON CONFLICT(id) DO NOTHING`).run(...values);
      if (db.prepare("SELECT rollout_path FROM threads WHERE id = ?").get(session.id)?.rollout_path !== session.path) {
        throw new Error("Codex session ID is already registered at another path");
      }
    } finally { inspect.close(); }
    return null;
  } catch {
    return `codex resume ${session.id}`;
  } finally {
    try { db?.close(); } catch { /* The writable database was not opened. */ }
  }
}
