import { createHash, randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, open, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Agent, NativeTurn, Turn } from "../adapters/types.js";
import { readJsonlLines, sameSnapshot } from "./jsonl.js";
import { readGitState } from "./git-state.js";
import type { GitState } from "./git-state.js";
import { sanitizeTurn } from "./sanitizer.js";
import { resolveWorkspace } from "./workspace.js";
import { appendNative, recoverNativeWrite, transaction, verifyWrite } from "./writer.js";
import type { AppendPayload } from "./writer.js";

export interface Binding {
  thread_id: string;
  agent: Agent;
  native_session_id: string;
  native_path: string;
  last_byte_offset: number;
  last_native_cursor: string | null;
  last_written_turn_id: string | null;
  last_seen_turn_id: string | null;
  last_timeline_turn_id: string | null;
  projection_pending: number;
  branch_head_turn_id: string | null;
  native_file_key?: string | null;
  mirror_pending?: number;
}

interface Thread {
  thread_id: string;
  workspace_key: string;
  status: "SYNCED" | "DIVERGED" | "CIRCUIT_OPEN";
  head_turn_id: string | null;
  lca_turn_id: string | null;
}

interface ClosedTurn extends NativeTurn {
  anchor: string;
  parentTurnId: string | null;
}

export interface FileAdapter {
  trackGit?: boolean;
  // undefined = unfinished turn, null = consumed without a turn, object = closed turn.
  reader(binding: Readonly<Binding>): (line: string | null) => ClosedTurn | null | undefined;
  // Invoke run only while the file may be written exclusively; return without invoking for an open session.
  withWritable?(binding: Readonly<Binding>, run: () => Promise<void>): Promise<void>;
  encode?(turn: Turn, binding: Readonly<Binding>): string;
}

const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function syncId(prefix: "th" | "tu", now: number): string {
  let value = (BigInt(now) << 80n) | BigInt("0x" + randomBytes(10).toString("hex"));
  let id = "";
  for (let i = 0; i < 26; i++, value >>= 5n) id = alphabet[Number(value & 31n)] + id;
  return prefix + "_" + id;
}

export function sourceTurnKey(binding: Readonly<Binding>, anchor: string): string {
  return createHash("sha256").update(`${binding.agent}:${binding.native_session_id}:${anchor}`).digest("hex");
}

export class Engine {
  private queue: Promise<void> = Promise.resolve();
  private readonly fanouts = new Map<string, number[]>();

  constructor(
    private db: DatabaseSync,
    private dataDir: string,
    private adapters: Partial<Record<Agent, FileAdapter>>,
    private now = Date.now,
    private warn: (message: string) => void = console.error,
    private scan?: () => Promise<ReadonlyMap<string, Stats>>,
    private project?: (engine: Engine, threadId: string, allow: () => boolean) => Promise<void>,
    private collect?: (engine: Engine) => Promise<void>,
  ) {}

  serial<T>(run: () => T | Promise<T>): Promise<T> {
    const next = this.queue.then(run);
    this.queue = next.then(() => {}, () => {});
    return next;
  }

  sync(): Promise<void> { return this.serial(() => this.syncAll()); }

  resume(threadId: string): Promise<void> {
    return this.serial(async () => {
      if (this.thread(threadId).status !== "CIRCUIT_OPEN") throw new Error("Thread is not circuit-open");
      this.db.prepare(`UPDATE threads SET status = CASE WHEN EXISTS (
        SELECT 1 FROM bindings WHERE thread_id = ? AND branch_head_turn_id IS NOT NULL
      ) THEN 'DIVERGED' ELSE 'SYNCED' END WHERE thread_id = ?`).run(threadId, threadId);
      this.fanouts.delete(threadId);
      await this.syncAll();
    });
  }

  resolveFork(threadId: string, agent: Agent, conclusion?: string) {
    return this.serial(async () => {
      await this.collect?.(this);
      let thread = this.thread(threadId);
      const workspace = this.workspace(thread);
      if (!workspace || thread.status !== "DIVERGED") throw new Error("Thread is not DIVERGED in an enabled workspace");
      for (const binding of this.bindings(threadId)) {
        const adapter = this.adapters[binding.agent];
        if (!adapter || binding.mirror_pending) continue;
        const snapshot = await lstat(binding.native_path);
        if (!snapshot.isFile() || (binding.native_file_key && binding.native_file_key !== `${snapshot.dev}:${snapshot.ino}`)) {
          throw new Error("Native file was replaced; cannot resolve the fork");
        }
        await this.drain(binding, workspace, adapter, snapshot);
        if (binding.last_byte_offset !== snapshot.size || !sameSnapshot(snapshot, await lstat(binding.native_path))) {
          throw new Error("Native file is still changing or has an open turn; wait for it to close before resolving");
        }
      }
      thread = this.thread(threadId);
      const chosen = this.bindings(threadId).find((binding) => binding.agent === agent)?.branch_head_turn_id;
      if (!chosen) throw new Error("Selected agent has no branch head");
      const heads = [...new Set([thread.head_turn_id, ...this.bindings(threadId).map((b) => b.branch_head_turn_id)]
        .filter((id): id is string => !!id && id !== chosen))];
      const otherHeads = heads.filter((id) => this.lca(threadId, chosen, id) !== id &&
        !heads.some((other) => other !== id && this.lca(threadId, other, id) === id));
      if (!otherHeads.length) throw new Error("There is no opposing branch to resolve");
      if (conclusion !== undefined && otherHeads.length !== 1) throw new Error("Merge requires exactly one opposing branch; use select to resolve multiple branches");
      const losing = new Set<string>();
      for (const tip of otherHeads) {
        const base = this.lca(threadId, chosen, tip);
        for (let id: string | null = tip; id !== base && id !== null; id = this.parent(threadId, id)) losing.add(id);
      }
      const summarize = async (ids: string[]) => (await Promise.all(ids.map(async (id) => {
        const turn = await this.readTurn(threadId, id);
        return `- ${id} [${turn.origin_agent}] ${turn.user_text.split(/\r?\n/, 1)[0].slice(0, 160)} → ${turn.assistant_text.slice(0, 400).replace(/\s+/g, " ")}`;
      }))).join("\n");
      const winnerText = await summarize([chosen]);
      const loserText = await summarize([...losing].slice(0, 5));
      const created = this.now();
      const turn: Turn = {
        turn_id: syncId("tu", created), parent_turn_id: chosen, origin_agent: "agent-link", created_at: created,
        git_head: null, git_fp: null, touched_files: [], tool_digest: [],
        ...(conclusion !== undefined ? { merge_parent_turn_id: otherHeads[0] } : {}),
        user_text: `[Agent Link ${conclusion === undefined ? "select" : "merge"}] 分支裁决：以 ${agent} 的分支 ${chosen} 为主。落选分支不再是当前依据。\n` +
          `保留的分支头：\n${winnerText}\n落选轮次（最多五轮）：\n${loserText}`,
        assistant_text: (conclusion === undefined ? "已记录分支选择。" : "合并结论：" + conclusion) +
          "\n工作区状态已失效：落选分支的结论及旧工具输出可能过时；继续前请重新读取相关文件并核对 Git 状态。",
      };
      const { pos, length } = await this.storeTurn(threadId, turn);
      transaction(this.db, () => {
        const abandon = this.db.prepare("UPDATE turns SET state = 'abandoned' WHERE thread_id = ? AND turn_id = ?");
        for (const id of losing) abandon.run(threadId, id);
        const revive = this.db.prepare("UPDATE turns SET state = 'active' WHERE thread_id = ? AND turn_id = ? AND state = 'abandoned'");
        for (let id: string | null = chosen; id !== null; id = this.parent(threadId, id)) revive.run(threadId, id);
        this.db.prepare(`INSERT INTO turns (turn_id, thread_id, parent_turn_id, merge_parent_turn_id, origin_agent, source_turn_key,
          byte_pos, byte_len, touched_files, created_at) VALUES (?, ?, ?, ?, 'agent-link', ?, ?, ?, '[]', ?)`)
          .run(turn.turn_id, threadId, chosen, turn.merge_parent_turn_id ?? null, turn.turn_id, pos, length, created);
        this.db.prepare("UPDATE bindings SET branch_head_turn_id = NULL WHERE thread_id = ?").run(threadId);
        this.db.prepare("UPDATE threads SET status = 'SYNCED', lca_turn_id = NULL, head_turn_id = ?, updated_at = ? WHERE thread_id = ?")
          .run(turn.turn_id, created, threadId);
      });
      return { thread_id: threadId, selected_turn_id: chosen, head_turn_id: turn.turn_id,
        merge_parent_turn_id: turn.merge_parent_turn_id ?? null, abandoned_turn_ids: [...losing] };
    });
  }

  private thread(id: string): Thread {
    const row = this.db.prepare("SELECT * FROM threads WHERE thread_id = ?").get(id);
    if (!row) throw new Error("Unknown thread: " + id);
    return row as unknown as Thread;
  }

  private bindings(id: string): Binding[] {
    return this.db.prepare("SELECT * FROM bindings WHERE thread_id = ? AND native_path IS NOT NULL ORDER BY agent")
      .all(id) as unknown as Binding[];
  }

  private workspace(thread: Thread): string | null {
    const row = this.db.prepare("SELECT raw_path FROM workspaces WHERE workspace_key = ? AND enabled = 1")
      .get(thread.workspace_key);
    return typeof row?.raw_path === "string" && resolveWorkspace([row.raw_path], new Set([thread.workspace_key]))
      ? thread.workspace_key : null;
  }

  private parent(threadId: string, id: string): string | null {
    const row = this.db.prepare("SELECT parent_turn_id FROM turns WHERE thread_id = ? AND turn_id = ?").get(threadId, id);
    if (!row) throw new Error("Unknown parent turn: " + id);
    return row.parent_turn_id as string | null;
  }

  private lca(threadId: string, a: string | null, b: string | null): string | null {
    const ancestors = new Set<string>();
    for (; a !== null; a = this.parent(threadId, a)) ancestors.add(a);
    for (; b !== null; b = this.parent(threadId, b)) if (ancestors.has(b)) return b;
    return null;
  }

  private advance(binding: Binding, offset: number): void {
    this.db.prepare("UPDATE bindings SET last_byte_offset = ? WHERE thread_id = ? AND agent = ?")
      .run(offset, binding.thread_id, binding.agent);
    binding.last_byte_offset = offset;
  }

  async record(binding: Binding, workspace: string, turn: ClosedTurn, offset: number,
    progress?: { nativeCursor?: string; git?: GitState | null; commit?: () => void },
  ): Promise<void> {
    const key = sourceTurnKey(binding, turn.anchor);
    const finishDelivery = () => {
      if (binding.agent === "codex") this.db.prepare(`DELETE FROM codex_deliveries
        WHERE native_session_id = ? AND native_turn_id = ?`).run(binding.native_session_id, turn.anchor);
      progress?.commit?.();
    };
    if (this.db.prepare("SELECT 1 FROM turns WHERE source_turn_key = ?").get(key)) {
      transaction(this.db, () => { this.advance(binding, offset); finishDelivery(); });
      return;
    }
    const nativeCursor = progress?.nativeCursor ?? turn.anchor;
    const thread = this.thread(binding.thread_id);
    const parent = turn.parentTurnId;
    if (parent !== null) this.parent(thread.thread_id, parent);
    const created = this.now();
    const stored: Turn = { ...sanitizeTurn(turn, workspace), turn_id: syncId("tu", created), parent_turn_id: parent,
      origin_agent: binding.agent, git_head: progress?.git?.head ?? null, git_fp: progress?.git?.fingerprint ?? null, created_at: created };
    const { pos, length } = await this.storeTurn(thread.thread_id, stored);

    const divided = this.db.prepare("SELECT 1 FROM bindings WHERE thread_id = ? AND branch_head_turn_id IS NOT NULL")
      .get(thread.thread_id) !== undefined;
    const fork = divided || parent !== thread.head_turn_id;
    const common = divided ? this.lca(thread.thread_id, parent, thread.lca_turn_id)
      : fork ? this.lca(thread.thread_id, parent, thread.head_turn_id) : null;
    transaction(this.db, () => {
      this.db.prepare(`INSERT INTO turns (turn_id, thread_id, parent_turn_id, origin_agent, source_turn_key,
        byte_pos, byte_len, touched_files, created_at, git_head, git_fp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(stored.turn_id, thread.thread_id, parent, binding.agent, key, pos, length,
          JSON.stringify(stored.touched_files), created, stored.git_head, stored.git_fp);
      if (fork && !divided) {
        this.db.prepare(`UPDATE bindings SET branch_head_turn_id = COALESCE(last_seen_turn_id, last_written_turn_id)
          WHERE thread_id = ?`).run(thread.thread_id);
      }
      const title = stored.user_text.trim().split(/\r?\n/, 1)[0].slice(0, 100) || "Untitled";
      this.db.prepare(`UPDATE threads SET head_turn_id = ?, lca_turn_id = ?, status = ?, updated_at = ?,
        title = CASE WHEN title = '' THEN ? ELSE title END WHERE thread_id = ?`)
        .run(fork ? thread.head_turn_id : stored.turn_id, common,
          thread.status === "CIRCUIT_OPEN" ? "CIRCUIT_OPEN" : fork ? "DIVERGED" : "SYNCED", created, title, thread.thread_id);
      this.db.prepare(`UPDATE bindings SET last_byte_offset = ?, last_native_cursor = ?, last_seen_turn_id = ?,
        last_written_turn_id = ?, last_timeline_turn_id = CASE WHEN projection_pending = 0 AND last_timeline_turn_id IS ?
          THEN ? ELSE last_timeline_turn_id END, branch_head_turn_id = ?, updated_at = ? WHERE thread_id = ? AND agent = ?`)
        .run(offset, nativeCursor, stored.turn_id, stored.turn_id, parent, stored.turn_id, fork ? stored.turn_id : null,
          created, thread.thread_id, binding.agent);
      if (progress?.git !== undefined) this.db.prepare(`UPDATE bindings SET last_git_head = ?, last_git_fp = ?
        WHERE thread_id = ? AND agent = ?`).run(stored.git_head, stored.git_fp, thread.thread_id, binding.agent);
      finishDelivery();
    });
    Object.assign(binding, { last_byte_offset: offset, last_native_cursor: nativeCursor, last_seen_turn_id: stored.turn_id,
      last_written_turn_id: stored.turn_id, branch_head_turn_id: fork ? stored.turn_id : null });
  }

  private async storeTurn(threadId: string, turn: Turn) {
    const body = Buffer.from(JSON.stringify(turn) + "\n");
    const file = await open(await this.turnFile(threadId), "a", 0o600);
    try {
      const pos = (await file.stat()).size;
      await file.writeFile(body);
      await file.sync();
      return { pos, length: body.length };
    } finally { await file.close(); }
  }

  private async turnFile(id: string): Promise<string> {
    if (!/^th_[a-z0-9_-]+$/i.test(id)) throw new Error("Invalid thread ID");
    const dir = join(this.dataDir, "turns");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return join(dir, id + ".jsonl");
  }

  unread(threadId: string, seen: string | null): string[] | null {
    const ids: string[] = [];
    let id = this.thread(threadId).head_turn_id;
    for (; id !== null && id !== seen; id = this.parent(threadId, id)) ids.push(id);
    return id === seen ? ids.reverse() : null;
  }

  deliveryUnread(threadId: string, seen: string | null): string[] | null {
    const direct = this.unread(threadId, seen);
    if (direct || !seen) return direct;
    const row = this.db.prepare("SELECT state FROM turns WHERE thread_id = ? AND turn_id = ?").get(threadId, seen);
    if (row?.state !== "abandoned") return null;
    // Replay from the fork point for delivery only; the old causal parent stays until acknowledged.
    return this.unread(threadId, this.lca(threadId, seen, this.thread(threadId).head_turn_id));
  }

  async deliveryContext(threadId: string, unread: string[], drift: string) {
    const resolution = this.db.prepare("SELECT origin_agent FROM turns WHERE turn_id = ?");
    let latest: string | undefined;
    for (let i = unread.length - 1; i >= 0; i--) {
      if (resolution.get(unread[i])?.origin_agent === "agent-link") { latest = unread[i]; break; }
    }
    // shortcut: load at most 25 bodies for the renderer; carry a missed resolution separately.
    const turns = [];
    for (const id of unread.slice(-25)) turns.push(await this.readTurn(threadId, id));
    const decision = latest ? turns.find((t) => t.turn_id === latest) ?? await this.readTurn(threadId, latest) : null;
    const state = decision ? `${decision.user_text.split("\n", 1)[0]}\n旧结论与工具输出可能已失效，请重新读取相关文件。\n${drift}\n${decision.assistant_text}` : drift;
    return { turns, state };
  }

  async readTurn(threadId: string, id: string): Promise<Turn> {
    const row = this.db.prepare("SELECT byte_pos, byte_len FROM turns WHERE thread_id = ? AND turn_id = ?").get(threadId, id);
    if (!row) throw new Error("Unknown turn: " + id);
    const file = await open(await this.turnFile(threadId), "r");
    try {
      const body = Buffer.allocUnsafe(Number(row.byte_len));
      for (let i = 0; i < body.length;) {
        const { bytesRead } = await file.read(body, i, body.length - i, Number(row.byte_pos) + i);
        if (!bytesRead) throw new Error("Turn store ended before " + id);
        i += bytesRead;
      }
      const turn: Turn = JSON.parse(body.toString("utf8"));
      if (turn.turn_id !== id) throw new Error("Turn store mismatch: " + id);
      return turn;
    } finally {
      await file.close();
    }
  }

  private async drain(binding: Binding, workspace: string, adapter: FileAdapter, snapshot?: Stats): Promise<void> {
    if (!isAbsolute(binding.native_path)) throw new Error("Native file path must be absolute");
    await recoverNativeWrite(this.db, binding);
    const read = adapter.reader(binding);
    let safe = binding.last_byte_offset;
    let verifiedEnd = -1;
    let git: Promise<GitState | null | undefined> | undefined;
    const owned = this.db.prepare(`SELECT start_offset, end_offset, turn_id, payload_hash FROM native_writes
      WHERE native_path = ? AND status = 'done' AND start_offset < ? AND end_offset > ? ORDER BY start_offset DESC LIMIT 1`);
    for await (const line of readJsonlLines(binding.native_path, safe, snapshot)) {
      const write = owned.get(binding.native_path, line.endOffset, line.startOffset) as unknown as
        Parameters<typeof verifyWrite>[2] | undefined;
      if (write) {
        if (line.startOffset < write.start_offset || line.endOffset > write.end_offset || safe !== line.startOffset) {
          throw new Error(`Native write overlaps unread data: ${binding.native_path}:${line.startOffset}`);
        }
        if (verifiedEnd !== write.end_offset) {
          const file = await open(binding.native_path, "r");
          try { await verifyWrite(file, binding.native_path, write); } finally { await file.close(); }
          verifiedEnd = write.end_offset;
        }
        safe = line.endOffset;
        continue;
      }
      let result: ReturnType<typeof read>;
      try { result = read(line.text); }
      catch (error) {
        if (error instanceof SyntaxError) throw new Error(`Invalid JSONL record at byte ${line.startOffset}`);
        throw error;
      }
      if (result !== undefined) safe = line.endOffset;
      if (result) {
        if (adapter.trackGit) git ??= readGitState(workspace).catch(() => undefined);
        await this.record(binding, workspace, result, safe, { git: await git });
      }
    }
    if (safe !== binding.last_byte_offset) this.advance(binding, safe);
  }

  async catchUpNative(binding: Binding, snapshot: Stats): Promise<void> {
    const workspace = this.workspace(this.thread(binding.thread_id));
    const adapter = this.adapters[binding.agent];
    if (workspace && adapter) await this.drain(binding, workspace, adapter, snapshot);
  }

  private allowFanout(id: string): boolean {
    const now = this.now();
    const times = (this.fanouts.get(id) ?? []).filter((time) => now - time < 10_000);
    if (times.length >= 5) {
      this.db.prepare("UPDATE threads SET status = 'CIRCUIT_OPEN' WHERE thread_id = ?").run(id);
      this.warn(`[circuit] ${id}: outbound sync paused`);
      return false;
    }
    times.push(now);
    this.fanouts.set(id, times);
    return true;
  }

  missingNative(binding: Binding): string[] | null {
    const unread = this.deliveryUnread(binding.thread_id, binding.last_timeline_turn_id);
    if (!unread) return null;
    const delivered = this.db.prepare(`SELECT 1 FROM turns t WHERE t.turn_id = ? AND (t.origin_agent = ? OR EXISTS (
      SELECT 1 FROM native_writes n WHERE n.native_path = ? AND n.turn_id = t.turn_id AND n.status = 'done'))`);
    const piEntry = binding.agent === "pi" ? this.db.prepare("SELECT 1 FROM pi_entries WHERE thread_id = ? AND entry_id = ?") : null;
    return unread.filter((id) => !delivered.get(id, binding.agent, binding.native_path) &&
      !piEntry?.get(binding.thread_id, `al_${id}_a`));
  }

  async flushExisting(binding: Binding, append: AppendPayload, prepare: (current: Binding) =>
    Promise<(turn: Turn) => string>, cancelled: () => boolean, requiresProjection = false): Promise<number> {
    const thread = this.thread(binding.thread_id);
    const workspace = this.workspace(thread);
    const adapter = this.adapters[binding.agent];
    if (!workspace || !adapter || thread.status !== "SYNCED") throw new Error("Workspace is disabled or thread is not SYNCED");
    if (cancelled()) throw new Error("Offline request disconnected");
    await this.drain(binding, workspace, adapter);
    if (this.thread(thread.thread_id).status !== "SYNCED") throw new Error("Native changes caused a fork; no bytes were appended");
    const current = this.bindings(thread.thread_id).find((row) => row.agent === binding.agent)!;
    if ((await stat(current.native_path)).size !== current.last_byte_offset) {
      throw new Error("Target has an incomplete or unread native record; no bytes were appended");
    }
    const pending = this.missingNative(current);
    const afterSeen = this.deliveryUnread(thread.thread_id, current.last_seen_turn_id);
    if (!pending || !afterSeen) throw new Error("Target cursor is not on the current branch");
    if (!pending.length) return 0;
    const newToModel = new Set(afterSeen);
    const encode = await prepare(current);
    if (cancelled()) throw new Error("Offline request disconnected");
    if (!this.allowFanout(thread.thread_id)) throw new Error("Thread circuit is open");
    let written = 0;
    for (const id of pending) {
      if (cancelled()) break;
      const text = encode(await this.readTurn(thread.thread_id, id));
      const wrote = await appendNative(this.db, this.dataDir, current, id, text, (offset, payload) => {
        if (cancelled()) throw new Error("Offline request disconnected");
        return append(offset, payload);
      }, requiresProjection, newToModel.has(id) ? id : current.last_seen_turn_id ?? id);
      if (!wrote) throw new Error("Native end offset changed; retry after checking the target client");
      written++;
    }
    return written;
  }

  private async fanout(thread: Thread, workspace: string, bindings: Binding[]): Promise<void> {
    let allowed = false;
    for (const binding of bindings) {
      const adapter = this.adapters[binding.agent];
      if (!adapter?.withWritable || !adapter.encode || binding.last_written_turn_id === thread.head_turn_id) continue;
      await adapter.withWritable(binding, async () => {
        await this.drain(binding, workspace, adapter);
        const latest = this.thread(thread.thread_id);
        if (latest.status !== "SYNCED" || latest.head_turn_id !== thread.head_turn_id ||
            (await stat(binding.native_path)).size !== binding.last_byte_offset) return;
        const missing = this.deliveryUnread(latest.thread_id, binding.last_written_turn_id);
        if (!missing) throw new Error("Target cursor is not on the current branch");
        for (const next of missing) {
          if (!allowed) {
            if (!this.allowFanout(latest.thread_id)) return;
            allowed = true;
          }
          const text = adapter.encode!(await this.readTurn(latest.thread_id, next), binding);
          if (!(await appendNative(this.db, this.dataDir, binding, next, text))) break;
        }
      });
      const latest = this.thread(thread.thread_id);
      if (latest.status !== "SYNCED" || latest.head_turn_id !== thread.head_turn_id) break;
    }
  }

  private async syncAll(): Promise<void> {
    await this.collect?.(this);
    const ready = await this.scan?.();
    const clean: { id: string; workspace: string; bindings: Binding[] }[] = [];
    for (const row of this.db.prepare("SELECT * FROM threads").all()) {
      const thread = row as unknown as Thread;
      const workspace = this.workspace(thread);
      if (!workspace) continue;
      const bindings = this.bindings(thread.thread_id);
      let safe = true;
      for (const binding of bindings) {
        const adapter = this.adapters[binding.agent];
        if (!adapter) continue;
        const snapshot = ready?.get(binding.native_path);
        if (ready && !snapshot) continue;
        try {
          await this.drain(binding, workspace, adapter, snapshot);
        } catch (error) {
          this.warn(`[ingest] ${binding.native_path}: ${String(error)}`);
          safe = false;
        }
      }
      if (safe) clean.push({ id: thread.thread_id, workspace, bindings });
    }
    for (const { id, workspace, bindings } of clean) {
      const thread = this.thread(id);
      if (thread.status === "SYNCED") {
        try {
          await this.fanout(thread, workspace, bindings);
          if (this.project && this.thread(id).status === "SYNCED" && thread.head_turn_id) {
            await this.project(this, id, () => this.allowFanout(id));
          }
        } catch (error) {
          this.warn(`[write] ${id}: ${String(error)}`);
        }
      }
    }
  }
}
