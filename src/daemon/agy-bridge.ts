import { lstat, readdir, readFile, realpath, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { agyInjection, agyTranscriptSnapshot, agyUserBoundary, parseAgyHook, readAgyTranscript } from "../adapters/agy-adapter.js";
import { agyInbox } from "../agy-hook.js";
import type { AgyStopJob } from "../agy-hook.js";
import { syncId } from "../core/engine.js";
import type { Binding, Engine } from "../core/engine.js";
import { describeGitDrift, readGitState } from "../core/git-state.js";
import { renderInjection } from "../core/sanitizer.js";
import { resolveWorkspace } from "../core/workspace.js";
import { transaction } from "../core/writer.js";

interface Session {
  workspace_key: string;
  transcript_path: string;
  file_key: string;
  byte_offset: number;
  full_offset: number;
  invocation_step: number;
}

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const literal = (text: string) => text.replace(/[\r\n]/g, " ").replace(/[\\`*_{}[\]()#+.!<>|~&]/g, "\\$&");
const within = (root: string, path: string) => {
  const sub = relative(root, path);
  return !!sub && sub !== ".." && !sub.startsWith(".." + sep) && !isAbsolute(sub) ? sub : null;
};

async function allowedTranscript(path: string, workspace: string, conversation: string) {
  const canonical = await realpath(path);
  const project = await realpath(workspace);
  if (within(project, canonical)) return canonical;
  for (const product of ["antigravity", "antigravity-cli", "antigravity-ide"]) {
    const base = join(homedir(), ".gemini", product, "brain");
    const root = await realpath(base).catch((error) => { if (!missing(error)) throw error; return null; });
    const inside = root && within(root, canonical);
    if (inside && inside.split(sep)[0] === conversation) return canonical;
  }
  return null;
}

export function agyBridge(db: DatabaseSync, dir: string, warn: (message: string) => void) {
  const first = process.env.AGENT_LINK_AGY_FIRST_INVOCATION;
  const firstInvocation = first && /^\d+$/.test(first) && Number.isSafeInteger(Number(first)) ? Number(first) : undefined;
  const findSession = db.prepare("SELECT * FROM agy_sessions WHERE conversation_id = ?");
  const addSession = db.prepare(`INSERT OR IGNORE INTO agy_sessions (conversation_id, workspace_key, transcript_path, file_key)
    VALUES (?, ?, ?, ?)`);
  const saveCursor = db.prepare("UPDATE agy_sessions SET byte_offset = ?, full_offset = ? WHERE conversation_id = ?");
  const saveInvocation = db.prepare("UPDATE agy_sessions SET invocation_step = ? WHERE conversation_id = ?");
  const findBinding = db.prepare(`SELECT b.*, t.status, t.workspace_key FROM bindings b JOIN threads t ON b.thread_id = t.thread_id
    WHERE agent = 'antigravity' AND native_session_id = ?`);
  const addBinding = db.prepare(`INSERT INTO bindings (thread_id, agent, native_session_id, native_path, native_file_key,
    last_byte_offset, last_native_cursor, last_written_turn_id, last_seen_turn_id, last_git_head, last_git_fp, updated_at)
    VALUES (?, 'antigravity', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const enabled = db.prepare("SELECT workspace_key, raw_path FROM workspaces WHERE enabled = 1");
  const git = async (workspace: string) => {
    try { return await readGitState(workspace); }
    catch { warn("[agy] Git baseline unavailable"); return null; }
  };

  function selectWorkspace(candidates: string[]) {
    const paths = new Map<string, string>();
    for (const row of enabled.iterate()) {
      if (typeof row.workspace_key === "string" && typeof row.raw_path === "string" &&
          resolveWorkspace([row.raw_path], new Set([row.workspace_key]))) paths.set(row.workspace_key, row.raw_path);
    }
    const key = resolveWorkspace(candidates, new Set(paths.keys()));
    return key ? { key, raw: paths.get(key)! } : null;
  }

  async function context(conversation: string, path: string, workspace: { key: string; raw: string }) {
    // Validate the supplied name before resolving it, and validate the resolved path before reading its contents.
    const info = await agyTranscriptSnapshot(path);
    const canonical = await allowedTranscript(path, workspace.raw, conversation);
    if (!canonical) return null;
    const session = findSession.get(conversation) as unknown as Session | undefined;
    const row = findBinding.get(conversation);
    if (session && (session.workspace_key !== workspace.key || session.transcript_path !== canonical ||
        session.file_key !== info.key || session.byte_offset > info.bytes)) return null;
    if (row && (!session || row.workspace_key !== workspace.key || row.native_path !== canonical)) return null;
    return { canonical, info, session, row };
  }

  async function ingest(engine: Engine, job: AgyStopJob): Promise<boolean> {
    const workspace = selectWorkspace([job.workspace]);
    if (!workspace || workspace.key !== job.workspace) return true;
    const ctx = await context(job.conversationId, job.path, workspace);
    if (!ctx || ctx.info.key !== job.snapshot.key || job.snapshot.bytes > ctx.info.bytes) return true;
    let byteOffset = ctx.session?.byte_offset ?? 0;
    if (byteOffset >= job.snapshot.bytes) return true;
    let binding = ctx.row as unknown as Binding | undefined;
    let state: Awaited<ReturnType<typeof git>> | undefined;
    for await (const turn of readAgyTranscript(ctx.canonical,
      { byteOffset, fullByteOffset: ctx.session?.full_offset ?? 0 }, job.snapshot)) {
      if (state === undefined) state = await git(workspace.raw);
      if (!binding) {
        const now = Date.now();
        const id = syncId("th", now);
        transaction(db, () => {
          addSession.run(job.conversationId, workspace.key, ctx.canonical, ctx.info.key);
          db.prepare(`INSERT INTO threads (thread_id, workspace_key, title, created_at, updated_at) VALUES (?, ?, '', ?, ?)`)
            .run(id, workspace.key, now, now);
          addBinding.run(id, job.conversationId, ctx.canonical, ctx.info.key, byteOffset, null, null, null, null, null, now);
        });
        binding = findBinding.get(job.conversationId) as unknown as Binding;
      }
      await engine.record(binding, workspace.key, { ...turn, parentTurnId: binding.last_seen_turn_id }, turn.cursor.byteOffset,
        { nativeCursor: String(turn.lastStep), git: state ?? undefined, commit: () => {
          saveCursor.run(turn.cursor.byteOffset, turn.cursor.fullByteOffset, job.conversationId);
        } });
      byteOffset = turn.cursor.byteOffset;
    }
    return byteOffset >= job.snapshot.bytes;
  }

  async function drain(engine: Engine): Promise<void> {
    const inbox = agyInbox(dir);
    const names = await readdir(inbox).catch((error) => { if (missing(error)) return []; throw error; });
    for (const name of names.sort()) {
      if (!/^\d+-[0-9a-f-]+\.json$/.test(name)) continue;
      const path = join(inbox, name);
      try {
        const info = await lstat(path);
        if (!info.isFile() || info.size > 32_768) continue;
        const job: AgyStopJob = JSON.parse(await readFile(path, "utf8"));
        if (!job || typeof job.conversationId !== "string" || !job.conversationId || job.conversationId.length > 256 ||
            typeof job.path !== "string" || typeof job.workspace !== "string" || typeof job.snapshot?.key !== "string" ||
            !Number.isSafeInteger(job.snapshot?.bytes) || job.snapshot.bytes < 0) throw new Error("Invalid queued Antigravity Stop");
        if (await ingest(engine, job)) await unlink(path);
      } catch (error) { if (!missing(error)) warn(`[agy] Stop job ${name} was not processed`); }
    }
  }

  async function dispatch(engine: Engine, event: "SessionStart" | "PreInvocation", arg: string) {
    const { input, deadline } = JSON.parse(arg);
    if (!Number.isSafeInteger(deadline) || deadline <= Date.now() || deadline > Date.now() + 3000) return {};
    const hook = parseAgyHook(event, input);
    if (!hook) return {};
    // CLI 1.5.16 rejects metadata.user_markdown and drops the entire step. Use `status` for CLI hints.
    const canShowHint = !/[\\/]\.gemini[\\/]antigravity-cli[\\/]brain[\\/]/i.test(hook.transcriptPath ?? "");
    const hint = (message: string) => canShowHint ? agyInjection("", message) : {};
    const workspace = selectWorkspace(hook.candidates);
    if (!workspace) return {};
    if (event === "SessionStart") {
      if (!canShowHint) return {};
      const threads = db.prepare(`SELECT t.thread_id, t.title, (SELECT group_concat(agent, ', ') FROM bindings b WHERE
        b.thread_id = t.thread_id) AS agents FROM threads t WHERE workspace_key = ? AND head_turn_id IS NOT NULL
        AND status = 'SYNCED' ORDER BY updated_at DESC, thread_id DESC LIMIT 3`).all(workspace.key);
      return threads.length ? agyInjection("", "可接续会话：\n" + threads.map((t) =>
        `- \`${String(t.thread_id).slice(-8)}\` ${literal(String(t.title))}（${literal(String(t.agents ?? ""))}）`).join("\n") +
        "\n发送 `#link <短号>` 或 `#link latest` 接续。") : {};
    }
    if (firstInvocation === undefined || hook.invocationNum !== firstInvocation ||
        !hook.transcriptPath || hook.lastUserInput === undefined) return {};

    const selector = /(?<!\S)#link[ \t]+([a-z0-9_-]+)(?=$|[\s.,!?;，。！？；])/i.exec(hook.lastUserInput)?.[1];
    if (!selector && !findBinding.get(hook.conversationId)) return {};
    // Older Stop jobs must be accounted for before a new window step can change the binding.
    await drain(engine);
    if (deadline <= Date.now()) return {};
    const ctx = await context(hook.conversationId, hook.transcriptPath, workspace);
    if (!ctx) return {};
    const boundary = await agyUserBoundary(ctx.canonical, hook.lastUserInput, ctx.session?.byte_offset ?? 0, ctx.info.key);
    if (!boundary || boundary.step <= (ctx.session?.invocation_step ?? -1)) return {};
    const rows = selector ? db.prepare(`SELECT thread_id, head_turn_id, status FROM threads WHERE workspace_key = ?
      AND head_turn_id IS NOT NULL ORDER BY updated_at DESC, thread_id DESC`).all(workspace.key) : [];
    const key = selector?.toLowerCase();
    const matches = key && key !== "latest" ? rows.filter(({ thread_id }) => {
      const id = String(thread_id).toLowerCase();
      return id.startsWith(key) || id.slice(-8) === key;
    }) : [];
    const target = selector ? key === "latest" ? rows[0] : rows.find((t) => String(t.thread_id).toLowerCase() === key) ??
      (matches.length === 1 ? matches[0] : undefined) : ctx.row;
    if (!target) return selector ? hint("当前工作区没有唯一匹配的会话。") : {};
    if (target.status !== "SYNCED") return hint(target.status === "DIVERGED" ? "[fork] 跨端同步暂停。" : "跨端同步已熔断。");
    const id = String(target.thread_id);
    const seen = selector ? null : (ctx.row?.last_seen_turn_id ?? null) as string | null;
    const unread = engine.deliveryUnread(id, seen);
    if (!unread) return {};
    const state = await git(workspace.raw);
    const previous = typeof ctx.row?.last_git_fp === "string"
      ? { head: ctx.row.last_git_head as string | null, fingerprint: ctx.row.last_git_fp } : null;
    const drift = await describeGitDrift(workspace.raw, previous, state).catch(() => "");
    const delivery = await engine.deliveryContext(id, unread, drift);
    const content = renderInjection(id, delivery.turns, delivery.state);
    const snapshot = await agyTranscriptSnapshot(ctx.canonical);
    if (snapshot.key !== ctx.info.key || snapshot.bytes !== boundary.size || deadline <= Date.now()) return {};
    const head = unread.at(-1) ?? seen;
    transaction(db, () => {
      if (selector) {
        addSession.run(hook.conversationId, workspace.key, ctx.canonical, ctx.info.key);
        saveCursor.run(boundary.offset, ctx.session?.full_offset ?? 0, hook.conversationId);
        db.prepare(`DELETE FROM bindings WHERE agent = 'antigravity' AND (native_session_id = ? OR thread_id = ?)`)
          .run(hook.conversationId, id);
        addBinding.run(id, hook.conversationId, ctx.canonical, ctx.info.key, boundary.offset, String(boundary.step - 1),
          head, head, state?.head ?? null, state?.fingerprint ?? null, Date.now());
      } else if (content) {
        db.prepare(`UPDATE bindings SET last_seen_turn_id = ?, last_git_head = ?, last_git_fp = ?,
          updated_at = ? WHERE thread_id = ? AND agent = 'antigravity'`)
          .run(head, state?.head ?? previous?.head ?? null, state?.fingerprint ?? previous?.fingerprint ?? null, Date.now(), id);
      }
      saveInvocation.run(boundary.step, hook.conversationId);
    });
    return content ? agyInjection(content, selector && canShowHint ? `已接续 ${id}。` : undefined) : {};
  }
  return { dispatch, drain };
}
