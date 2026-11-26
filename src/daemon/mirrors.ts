import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { codexDefaults, codexHeader, describeCodexSession, encodeCodexTurn, registerCodexSession } from "../adapters/codex-adapter.js";
import { describePiSession, encodePiTurn, piSessionDir } from "../adapters/pi-adapter.js";
import type { Engine } from "../core/engine.js";
import { readJsonlLines } from "../core/jsonl.js";

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

export function mirrorPublisher(db: DatabaseSync, piRoot: string, codexHome: string) {
  const context = db.prepare(`SELECT t.title, t.head_turn_id, w.raw_path FROM threads t
    JOIN workspaces w ON w.workspace_key = t.workspace_key AND w.enabled = 1 WHERE t.thread_id = ?`);
  const bindings = db.prepare("SELECT * FROM bindings WHERE thread_id = ? AND agent IN ('pi', 'codex')");
  const add = db.prepare(`INSERT INTO bindings (thread_id, agent, native_session_id, native_path, native_file_key,
    last_byte_offset, last_written_turn_id, updated_at, last_git_head, last_git_fp, mirror_pending) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`);
  const finish = db.prepare(`UPDATE bindings SET mirror_pending = 0, native_notice = ?,
    last_timeline_turn_id = last_written_turn_id, last_seen_turn_id = last_written_turn_id WHERE thread_id = ? AND agent = ?`);

  async function publish(path: string, key: string, size: number) {
    const stage = path + ".agent-link-pending";
    const check = async (file: string) => {
      const info = await lstat(file);
      if (!info.isFile() || `${info.dev}:${info.ino}` !== key || info.size < size) {
        throw new Error(`Unverifiable mirror: ${file}`);
      }
    };
    try { await check(path); }
    catch (error) {
      if (!missing(error)) throw error;
      await check(stage);
      await link(stage, path); // Never replace a file that has appeared at the destination.
    }
    try {
      await check(stage);
      await unlink(stage);
    } catch (error) { if (!missing(error)) throw error; }
  }

  async function register(path: string, cwd: string, title: string, id: string) {
    for await (const row of readJsonlLines(path, 0, undefined, 2 * 1024 * 1024 + 1)) {
      const meta = row.text && codexHeader(row.text);
      if (!meta || meta.id !== id) break;
      const defaults = codexDefaults(codexHome, cwd);
      return registerCodexSession(codexHome, { ...defaults, ...meta, path, created: Date.now(), ordinal: 0 }, title);
    }
    return `codex resume ${id}`;
  }

  return async (engine: Engine, threadId: string, allow: () => boolean): Promise<void> => {
    const ctx = context.get(threadId);
    if (typeof ctx?.raw_path !== "string" || typeof ctx.title !== "string" || typeof ctx.head_turn_id !== "string") return;
    const { raw_path: cwd, title, head_turn_id: head } = ctx;
    const existing = bindings.all(threadId);
    for (const binding of existing) {
      if (binding.mirror_pending !== 1) continue;
      const path = String(binding.native_path);
      await publish(path, String(binding.native_file_key), Number(binding.last_byte_offset));
      const notice = binding.agent === "codex" ? await register(path, cwd, title, String(binding.native_session_id)) : null;
      finish.run(notice, threadId, binding.agent);
    }
    const agent = !existing.some((b) => b.agent === "pi") ? "pi"
      : !existing.some((b) => b.agent === "codex") ? "codex" : null;
    if (!agent || !allow()) return;

    const configuredRoot = agent === "pi" ? piRoot : codexHome;
    await mkdir(configuredRoot, { recursive: true, mode: 0o700 });
    const root = await realpath(configuredRoot);
    const defaults = agent === "codex" ? codexDefaults(root, cwd) : null;
    const codex = defaults && describeCodexSession(root, cwd, defaults.modelProvider, defaults.model, defaults.version);
    const draft = codex || describePiSession(piSessionDir(root, cwd), cwd);
    const parent = dirname(draft.path);
    let dir = root;
    for (const part of relative(root, parent).split(sep)) {
      dir = join(dir, part);
      await mkdir(dir, { mode: 0o700 }).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      });
      if (!(await lstat(dir)).isDirectory() || await realpath(dir) !== dir) {
        throw new Error(`Mirror directory traverses a link: ${dir}`);
      }
    }
    const stage = draft.path + ".agent-link-pending";
    let kept = false;
    const file = await open(stage, "wx", 0o600);
    try {
      await file.writeFile(draft.header);
      let previous: string | null = null;
      let ordinal = 0;
      for (const id of engine.unread(threadId, null) ?? []) {
        const turn = await engine.readTurn(threadId, id);
        const encoded: string = codex ? encodeCodexTurn(turn, { ...codex, ordinal }) : encodePiTurn(turn, previous);
        await file.writeFile(encoded);
        if (codex) ordinal += 7;
        else previous = `al_${id}_a`;
      }
      await file.sync();
      const stat = await file.stat();
      const key = `${stat.dev}:${stat.ino}`;
      const baseline = await engine.readTurn(threadId, head);
      add.run(threadId, agent, draft.id, draft.path, key, stat.size, head, Date.now(), baseline.git_head, baseline.git_fp);
      kept = true;
      await file.close();
      await publish(draft.path, key, stat.size);
      const notice = codex ? registerCodexSession(root, codex, title) : null;
      finish.run(notice, threadId, agent);
    } finally {
      await file.close();
      if (!kept) await unlink(stage);
    }
  };
}
