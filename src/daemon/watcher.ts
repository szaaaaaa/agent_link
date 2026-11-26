import { randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { codexDefaults, codexHeader, codexReader, encodeCodexTurn, refreshCodexIndex } from "../adapters/codex-adapter.js";
import { encodePiTurn, piHeader, piParent, piReader } from "../adapters/pi-adapter.js";
import { projectCodexSession, resolveCodexCli } from "../adapters/codex-projector.js";
import { sourceTurnKey, syncId } from "../core/engine.js";
import type { Binding, Engine, FileAdapter } from "../core/engine.js";
import { readJsonlLines, readJsonlTail, sameSnapshot } from "../core/jsonl.js";
import { describeGitDrift, readGitState } from "../core/git-state.js";
import { withWindowsAppend } from "../core/windows-append.js";
import { renderInjection } from "../core/sanitizer.js";
import { mirrorPublisher } from "./mirrors.js";
import { resolveWorkspace } from "../core/workspace.js";
import { transaction, verifyWrite } from "../core/writer.js";

export const NATIVE_QUIET_MS = 500;
const MAX_HEADER = 2 * 1024 * 1024 + 1;

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

async function* files(dir: string, prefix: string): AsyncGenerator<string> {
  try {
    for await (const entry of await opendir(dir)) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) yield* files(path, prefix);
      else if (entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith(".jsonl")) yield path;
    }
  } catch (error) {
    if (!missing(error)) throw error;
  }
}

async function header<T>(path: string, info: Stats, parse: (line: string) => T | null): Promise<T | null> {
  const file = await open(path, "r");
  try {
    for await (const row of readJsonlLines(file, 0, info, MAX_HEADER)) {
      return row.text ? parse(row.text) : null;
    }
    return null;
  } finally { await file.close(); }
}

export function watchNativeSessions(db: DatabaseSync, warn: (message: string) => void) {
  const piHome = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  const piRoot = resolve(process.env.PI_CODING_AGENT_SESSION_DIR || join(piHome, "sessions"));
  const codexHome = resolve(process.env.CODEX_HOME || join(homedir(), ".codex"));
  const sources = [
    { agent: "pi", root: piRoot, prefix: "", header: piHeader },
    { agent: "codex", root: join(codexHome, "sessions"), prefix: "rollout-", header: codexHeader },
  ] as const;
  const knownPath = db.prepare("SELECT last_byte_offset, native_file_key FROM bindings WHERE native_path = ?");
  const lookup = db.prepare(`SELECT b.thread_id, b.native_path, b.last_byte_offset, b.native_file_key, t.workspace_key
    FROM bindings b JOIN threads t ON t.thread_id = b.thread_id WHERE b.agent = ? AND b.native_session_id = ?`);
  const workspaces = db.prepare("SELECT workspace_key, raw_path FROM workspaces WHERE enabled = 1");
  const insertThread = db.prepare(`INSERT INTO threads (thread_id, workspace_key, title, created_at, updated_at)
    VALUES (?, ?, '', ?, ?)`);
  const insertBinding = db.prepare(`INSERT INTO bindings (thread_id, agent, native_session_id, native_path, native_file_key, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`);
  const rememberPi = db.prepare(`INSERT INTO pi_entries (thread_id, entry_id, parent_id, injected_turn_id) VALUES (?, ?, ?, ?)
    ON CONFLICT(thread_id, entry_id) DO NOTHING`);
  const piEntry = db.prepare("SELECT parent_id, injected_turn_id FROM pi_entries WHERE thread_id = ? AND entry_id = ?");
  const nativeTurn = db.prepare("SELECT turn_id FROM turns WHERE source_turn_key = ? AND thread_id = ?");

  const resumePoint = db.prepare(`SELECT resume_turn_id FROM native_writes WHERE native_path = ? AND turn_id = ? AND status = 'done'`);
  const findParent = (binding: Readonly<Binding>, id: string | null) => piParent(id, (entryId) => {
    const entry = piEntry.get(binding.thread_id, entryId);
    if (!entry) return undefined;
    const turn = nativeTurn.get(sourceTurnKey(binding, entryId), binding.thread_id);
    const turnId = turn?.turn_id ?? entry.injected_turn_id;
    return { parentId: entry.parent_id as string | null, turnId: typeof turnId === "string" ? turnId : undefined };
  }, (turnId) => resumePoint.get(binding.native_path, turnId)?.resume_turn_id as string | null | undefined);
  const knownTurn = db.prepare("SELECT 1 FROM turns WHERE thread_id = ? AND turn_id = ?");
  const acknowledge = db.prepare(`UPDATE bindings SET last_seen_turn_id = ?
    WHERE thread_id = ? AND agent = 'pi'`);
  const driftFor = async (workspace: string, row: { last_git_head?: unknown; last_git_fp?: unknown }) => {
    if (typeof row.last_git_fp !== "string") return "";
    const previous = { head: typeof row.last_git_head === "string" ? row.last_git_head : null, fingerprint: row.last_git_fp };
    try { return await describeGitDrift(workspace, previous, await readGitState(workspace)); }
    catch { return ""; }
  };
  const piContext = db.prepare(`SELECT b.*, t.workspace_key, t.status, w.raw_path FROM bindings b
    JOIN threads t ON t.thread_id = b.thread_id JOIN workspaces w ON w.workspace_key = t.workspace_key AND w.enabled = 1
    WHERE b.agent = 'pi' AND b.native_path = ? AND b.mirror_pending = 0`);
  async function piHistory(engine: Engine, arg: string, includeText: boolean) {
    const input = JSON.parse(arg);
    if (!input || typeof input.path !== "string" || !isAbsolute(input.path) || typeof input.cwd !== "string" ||
        (input.leaf !== null && (typeof input.leaf !== "string" || input.leaf.length > 256))) throw new Error("Invalid Pi session request");
    const path = await realpath(input.path).catch(() => null);
    if (!path) return null;
    const row = piContext.get(path);
    if (typeof row?.workspace_key !== "string" || typeof row.raw_path !== "string" ||
        !resolveWorkspace([input.cwd], new Set([row.workspace_key])) ||
        !resolveWorkspace([row.raw_path], new Set([row.workspace_key]))) return null;
    const binding = row as unknown as Binding;
    const info = await lstat(path);
    if (!info.isFile() || `${info.dev}:${info.ino}` !== row.native_file_key) return null;
    if (row.status === "DIVERGED") return { count: 0, warning: "[fork] 跨端同步暂停，请先解决分叉。" };
    if (row.status !== "SYNCED" || info.size !== binding.last_byte_offset) return null;
    let seen: string | null;
    try { seen = findParent(binding, input.leaf); } catch { return null; }
    const unread = engine.deliveryUnread(binding.thread_id, seen);
    if (!unread) return null;
    const result = { count: unread.length, turnId: unread.at(-1) ?? seen };
    if (!includeText) {
      const count = engine.missingNative(binding)?.length ?? 0;
      return { ...result, count, busy: codexRunning.has(binding.thread_id) };
    }
    const drift = await driftFor(row.raw_path, row);
    if (!result.turnId || (!unread.length && !drift)) return null;
    const { turns, state } = await engine.deliveryContext(binding.thread_id, unread, drift);
    const foreign = turns.filter((turn) => turn.origin_agent !== "pi");
    if (unread.length && foreign.at(-1)?.turn_id !== result.turnId) return null;
    return { ...result, content: renderInjection(binding.thread_id, foreign, state) };
  }
  const codexContext = db.prepare(`SELECT b.*, t.workspace_key, t.status, w.raw_path FROM bindings b
    JOIN threads t ON t.thread_id = b.thread_id JOIN workspaces w ON w.workspace_key = t.workspace_key AND w.enabled = 1
    WHERE b.agent = 'codex' AND b.native_session_id = ? AND b.mirror_pending = 0`);
  const delivery = db.prepare(`SELECT through_turn_id FROM codex_deliveries
    WHERE native_session_id = ? AND native_turn_id = ? AND marker = ?`);
  const send = db.prepare(`INSERT OR IGNORE INTO codex_deliveries
    (native_session_id, native_turn_id, marker, through_turn_id) VALUES (?, ?, ?, ?)`);
  async function codexHistory(engine: Engine, arg: string) {
    const input = JSON.parse(arg);
    if (!input || typeof input.session !== "string" || !input.session || input.session.length > 256 ||
        typeof input.turn !== "string" || !input.turn || input.turn.length > 256 ||
        typeof input.cwd !== "string" || typeof input.path !== "string" || !isAbsolute(input.path) ||
        !Number.isSafeInteger(input.deadline) || input.deadline <= Date.now() || input.deadline > Date.now() + 2500) return null;
    const row = codexContext.get(input.session);
    if (typeof row?.workspace_key !== "string" || typeof row.raw_path !== "string" ||
        typeof row.native_path !== "string" || row.status !== "SYNCED" ||
        !resolveWorkspace([input.cwd], new Set([row.workspace_key])) ||
        !resolveWorkspace([row.raw_path], new Set([row.workspace_key]))) return null;
    const path = await realpath(input.path);
    if (path !== row.native_path) return null;
    const info = await lstat(path);
    if (!info.isFile() || `${info.dev}:${info.ino}` !== row.native_file_key) return null;
    const meta = await header(path, info, codexHeader);
    if (!meta || meta.id !== input.session || !resolveWorkspace([meta.cwd], new Set([row.workspace_key]))) return null;
    // Codex writes task_started before calling the Hook. Ingest completed earlier turns, not the running one.
    await engine.catchUpNative(row as unknown as Binding, info);
    if (!sameSnapshot(info, await lstat(path))) return null;
    const current = codexContext.get(input.session);
    if (current?.status !== "SYNCED" || input.deadline <= Date.now()) return null;
    const binding = current as unknown as Binding;
    if (nativeTurn.get(sourceTurnKey(binding, input.turn), binding.thread_id)) return null;
    const unread = engine.deliveryUnread(binding.thread_id, binding.last_seen_turn_id);
    if (!unread) return null;
    const drift = await driftFor(row.raw_path, current);
    const through = unread.at(-1) ?? binding.last_seen_turn_id;
    if (!through || (!unread.length && !drift)) return null;
    const { turns, state } = await engine.deliveryContext(binding.thread_id, unread, drift);
    const marker = randomBytes(16).toString("hex");
    const text = renderInjection(binding.thread_id, turns, state, `\n<!-- agent-link-delivery:${marker} -->`);
    if (input.deadline <= Date.now() || !send.run(input.session, input.turn, marker, through).changes) return null;
    return text;
  }
  const codexRunning = new Set<string>();
  const adapters: Record<"pi" | "codex", FileAdapter> = {
    pi: {
      trackGit: true,
      reader: (binding) => piReader((id) => findParent(binding, id), (entry) => {
        if (entry.type === "session") return;
        if (typeof entry.id !== "string" || entry.id.length > 256 ||
            (entry.parentId != null && (typeof entry.parentId !== "string" || entry.parentId.length > 256))) {
          throw new Error("Invalid Pi entry ID");
        }
        const turnId = entry.details?.turnId;
        const injected = entry.customType === "agent-link" && typeof turnId === "string" && /^tu_[0-9A-Z]+$/.test(turnId)
          ? turnId : null;
        const valid = injected && knownTurn.get(binding.thread_id, injected) ? injected : null;
        rememberPi.run(binding.thread_id, entry.id, entry.parentId ?? null, valid);
        // A pulled payload is not an acknowledgement; Pi's persisted custom entry is.
        if (valid) acknowledge.run(valid, binding.thread_id);
      }),
    },
    codex: { trackGit: true, reader: (binding) => codexReader(() => {
      const written = binding.last_written_turn_id;
      const resumed = written && resumePoint.get(binding.native_path, written)?.resume_turn_id;
      return binding.projection_pending && typeof resumed === "string" ? resumed : binding.last_seen_turn_id;
    }, (turn, marker) => {
      const received = delivery.get(binding.native_session_id, turn, marker)?.through_turn_id;
      return typeof received === "string" && knownTurn.get(binding.thread_id, received) ? received : null;
    }, (running) => {
      if (running) codexRunning.add(binding.thread_id);
      else codexRunning.delete(binding.thread_id);
    }) },
  };

  async function scan(): Promise<Map<string, Stats>> {
    const ready = new Map<string, Stats>();
    const enabled = new Set<string>();
    for (const { workspace_key: key, raw_path: raw } of workspaces.iterate()) {
      if (typeof key === "string" && typeof raw === "string" && resolveWorkspace([raw], new Set([key]))) enabled.add(key);
    }
    if (!enabled.size) return ready;

    for (const source of sources) {
      try {
        const root = await realpath(source.root);
        for await (const path of files(root, source.prefix)) {
          try {
            const info = await lstat(path);
            const now = Date.now();
            if (!info.isFile() || !info.size || now - Math.max(info.mtimeMs, info.ctimeMs) < NATIVE_QUIET_MS) continue;
            const fileKey = `${info.dev}:${info.ino}`;
            const known = knownPath.get(path);
            if (known && (known.native_file_key !== fileKey || Number(known.last_byte_offset) >= info.size)) continue;
            const actual = await realpath(path);
            const sub = relative(root, actual);
            if (!sub || sub === ".." || sub.startsWith(".." + sep) || isAbsolute(sub) || actual !== path) continue;
            const meta = await header(path, info, source.header);
            if (!meta || meta.id.length > 256 || meta.id.includes("\0")) continue;
            const workspace = resolveWorkspace([meta.cwd], enabled);
            if (!workspace) continue;
            const binding = lookup.get(source.agent, meta.id);
            if (binding) {
              if (binding.native_path !== path || binding.workspace_key !== workspace || binding.native_file_key !== fileKey) continue;
            } else {
              if (known) continue;
              const id = syncId("th", now);
              transaction(db, () => {
                insertThread.run(id, workspace, now, now);
                insertBinding.run(id, source.agent, meta.id, path, fileKey, now);
              });
            }
            ready.set(path, info);
          } catch (error) {
            // A malformed header is not a candidate. Do not log raw transcript text.
            if (!(error instanceof SyntaxError) && !missing(error)) warn(`[discover] ${path}: ${String(error)}`);
          }
        }
      } catch (error) {
        if (!missing(error)) warn(`[discover] ${source.root}: ${String(error)}`);
      }
    }
    return ready;
  }
  async function syncOffline(engine: Engine, threadId: string, agent: "pi" | "codex", cancelled: () => boolean,
    expectedLeaf?: string | null) {
    const row = db.prepare(`SELECT b.*, t.workspace_key, t.status, w.raw_path FROM bindings b
      JOIN threads t ON t.thread_id = b.thread_id JOIN workspaces w ON w.workspace_key = t.workspace_key AND w.enabled = 1
      WHERE b.thread_id = ? AND b.agent = ? AND b.native_path IS NOT NULL AND b.mirror_pending = 0`).get(threadId, agent);
    if (typeof row?.workspace_key !== "string" || typeof row.raw_path !== "string" || typeof row.native_path !== "string") {
      throw new Error("No published binding in an enabled workspace");
    }
    if (row.status !== "SYNCED") throw new Error("Thread is not SYNCED; no bytes were appended");
    const workspace = row.workspace_key;
    const path = row.native_path;
    const source = sources.find((item) => item.agent === agent)!;
    const root = await realpath(source.root);
    const sub = relative(root, path);
    if (!sub || sub === ".." || sub.startsWith(".." + sep) || isAbsolute(sub) || await realpath(path) !== path) {
      throw new Error("Bound native path is no longer in the client session directory");
    }
    if (cancelled()) throw new Error("Offline request disconnected");
    const binding = row as unknown as Binding;
    let projector: string | undefined;
    const written = await withWindowsAppend(path, async (append) => {
      const info = await lstat(path);
      if (!info.isFile() || `${info.dev}:${info.ino}` !== row.native_file_key) throw new Error("Bound native file was replaced");
      const meta = await header(path, info, agent === "codex" ? codexHeader : piHeader).catch((error) => {
        if (error instanceof SyntaxError) throw new Error("Native session header is not valid JSON");
        throw error;
      });
      if (!meta || meta.id !== binding.native_session_id ||
          !resolveWorkspace([meta.cwd], new Set([workspace]))) throw new Error("Native session ID or workspace changed");
      const historyMode = "historyMode" in meta && typeof meta.historyMode === "string" ? meta.historyMode : undefined;
      if (agent === "codex" && historyMode !== undefined && historyMode !== "legacy" && historyMode !== "paginated") {
        throw new Error("Unknown Codex history mode; the backlog was kept");
      }
      if (historyMode === "paginated") projector = await resolveCodexCli();
      // Older Pi bindings with Hook-only delivery can have an unknown timeline baseline. Index existing
      // mirror entries before backfilling, so deterministic al_* IDs are never appended twice.
      if (agent === "pi" && !binding.last_timeline_turn_id && binding.last_written_turn_id) {
        for await (const line of readJsonlLines(path, 0, info)) {
          if (!line.text) continue;
          const entry = JSON.parse(line.text);
          if (typeof entry.id === "string" && /^al_tu_[0-9A-Z]+_a$/.test(entry.id)) {
            rememberPi.run(threadId, entry.id, typeof entry.parentId === "string" ? entry.parentId : null, null);
          }
        }
      }
      return engine.flushExisting(binding, append, async (current) => {
        let tail;
        try { tail = JSON.parse(await readJsonlTail(path)); }
        catch (error) {
          if (error instanceof SyntaxError) throw new Error("Native tail is not valid JSON");
          throw error;
        }
        if (agent === "pi") {
          let parent = tail?.type === "session" ? null : tail?.id;
          if ((expectedLeaf !== undefined && parent !== expectedLeaf) ||
              (parent !== null && typeof parent !== "string") || findParent(current, parent) !== current.last_seen_turn_id) {
            throw new Error("Pi disk leaf does not match the synchronized branch");
          }
          return (turn) => {
            const text = encodePiTurn(turn, parent);
            parent = `al_${turn.turn_id}_a`;
            return text;
          };
        }
        // Codex resumes legacy rollouts with unnumbered events, even when older lines have ordinals.
        const rawOrdinal = tail?.ordinal;
        if ((rawOrdinal !== undefined || historyMode === "paginated") &&
            (!Number.isSafeInteger(rawOrdinal) || rawOrdinal < 0 || rawOrdinal > Number.MAX_SAFE_INTEGER - 7)) {
          throw new Error("Invalid Codex rollout tail ordinal");
        }
        const config = codexDefaults(codexHome, meta.cwd);
        let ordinal: number | undefined = rawOrdinal;
        return (turn) => {
          if (ordinal !== undefined && ordinal > Number.MAX_SAFE_INTEGER - 7) throw new Error("Codex ordinal limit reached");
          const text = encodeCodexTurn(turn, { cwd: meta.cwd, model: config.model, ordinal, historyMode, id: meta.id });
          if (ordinal !== undefined) ordinal += 7;
          return text;
        };
      }, cancelled, historyMode === "paginated");
    });
    if (projector && codexContext.get(binding.native_session_id)?.projection_pending === 1) {
      if (cancelled()) throw new Error("Offline request disconnected; projection is pending");
      const write = db.prepare(`SELECT * FROM native_writes WHERE native_path = ? AND status = 'done'
        AND requires_projection = 1 ORDER BY start_offset DESC LIMIT 1`).get(path) as unknown as Parameters<typeof verifyWrite>[2] | undefined;
      if (write) {
        let expected: string | undefined;
        const file = await open(path, "r");
        try {
          const info = await file.stat();
          if (`${info.dev}:${info.ino}` !== row.native_file_key) throw new Error("Codex file changed before projection");
          await verifyWrite(file, path, write);
          for await (const line of readJsonlLines(file, write.start_offset, info, write.end_offset)) {
            if (!line.text) throw new Error("Missing Codex projection event");
            const row = JSON.parse(line.text);
            if (row.payload?.type === "task_complete" && typeof row.payload.turn_id === "string") expected = row.payload.turn_id;
          }
        } finally { await file.close(); }
        if (!expected) throw new Error("Missing Codex projection turn ID");
        await projectCodexSession(projector, codexHome, row.raw_path, binding.native_session_id, expected);
        const info = await lstat(path);
        if (`${info.dev}:${info.ino}` !== row.native_file_key) throw new Error("Codex file changed during projection");
        const current = codexContext.get(binding.native_session_id) as unknown as Binding;
        await engine.catchUpNative(current, info);
        if (current.last_byte_offset !== info.size || !sameSnapshot(info, await lstat(path))) {
          throw new Error("Codex wrote an unread record during projection; retry after closing the target client");
        }
        db.prepare(`UPDATE bindings SET projection_pending = 0,
          last_seen_turn_id = CASE WHEN last_written_turn_id IS ? THEN ? ELSE last_seen_turn_id END
          WHERE thread_id = ? AND agent = 'codex'`).run(write.turn_id!, write.resume_turn_id!, threadId);
      } else {
        db.prepare("UPDATE bindings SET projection_pending = 0 WHERE thread_id = ? AND agent = 'codex'").run(threadId);
      }
    }
    const latestBinding = db.prepare("SELECT * FROM bindings WHERE thread_id = ? AND agent = ?").get(threadId, agent) as unknown as Binding;
    const head = db.prepare("SELECT head_turn_id FROM threads WHERE thread_id = ? AND status = 'SYNCED'").get(threadId);
    if (head && !latestBinding.projection_pending && engine.missingNative(latestBinding)?.length === 0) {
      db.prepare("UPDATE bindings SET last_timeline_turn_id = ? WHERE thread_id = ? AND agent = ?")
        .run(head.head_turn_id!, threadId, agent);
    }
    let notice = row.native_notice as string | null;
    if (agent === "codex") {
      const latest = db.prepare("SELECT MAX(created_at) AS at FROM native_writes WHERE native_path = ? AND status = 'done'").get(path)?.at;
      if (typeof latest === "number") {
        notice = refreshCodexIndex(codexHome, binding.native_session_id, path, latest);
        db.prepare("UPDATE bindings SET native_notice = ? WHERE thread_id = ? AND agent = ?").run(notice, threadId, agent);
      }
    }
    return { thread_id: threadId, agent, appended_turns: written, notice };
  }
  async function piSync(engine: Engine, arg: string, cancelled: () => boolean) {
    const input = JSON.parse(arg);
    if (!input || typeof input.path !== "string" || !isAbsolute(input.path) || typeof input.cwd !== "string" ||
        (input.leaf !== null && (typeof input.leaf !== "string" || input.leaf.length > 256))) throw new Error("Invalid Pi session request");
    const row = piContext.get(await realpath(input.path));
    if (typeof row?.thread_id !== "string" || typeof row.workspace_key !== "string" ||
        !resolveWorkspace([input.cwd], new Set([row.workspace_key]))) return null;
    return syncOffline(engine, row.thread_id, "pi", cancelled, input.leaf);
  }
  const attempts = new Map<string, number>();
  const codexBacklog = db.prepare(`SELECT b.*, t.head_turn_id FROM bindings b
    JOIN threads t ON t.thread_id = b.thread_id JOIN workspaces w ON w.workspace_key = t.workspace_key AND w.enabled = 1
    WHERE b.agent = 'codex' AND b.mirror_pending = 0 AND t.status = 'SYNCED' AND
      (b.projection_pending = 1 OR b.last_timeline_turn_id IS NOT t.head_turn_id)`);
  async function syncCodexBacklog(engine: Engine, cancelled: () => boolean) {
    if (process.platform !== "win32" || process.env.AGENT_LINK_CODEX_AUTO_SYNC === "0" || cancelled()) return;
    const now = Date.now();
    for (const [id, at] of attempts) if (now - at >= 10_000) attempts.delete(id);
    for (const row of codexBacklog.all()) {
      const id = String(row.thread_id);
      if (attempts.has(id) || codexRunning.has(id)) continue;
      try { await syncOffline(engine, id, "codex", cancelled); }
      catch (error) {
        // An open Codex session is expected to defer the automatic write.
        if (!String(error).includes("Cannot acquire exclusive writer lease")) warn(`[codex sync] ${id}: ${String(error)}`);
      } finally { attempts.set(id, Date.now()); }
      break;
    }
  }
  return { adapters, scan, piHistory, piSync, codexHistory, syncOffline, syncCodexBacklog, project: mirrorPublisher(db, piRoot, codexHome) };
}
