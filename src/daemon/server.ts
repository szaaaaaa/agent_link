import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, linkSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { Agent } from "../adapters/types.js";
import { openStateDb } from "../core/db.js";
import { Engine } from "../core/engine.js";
import type { FileAdapter } from "../core/engine.js";
import { normalizeWorkspace } from "../core/workspace.js";
import { agyBridge } from "./agy-bridge.js";
import { endpoint } from "./lifecycle.js";
import { NATIVE_QUIET_MS, watchNativeSessions } from "./watcher.js";

export class AlreadyRunning extends Error {}

export async function serve(dir: string, adapters?: Partial<Record<Agent, FileAdapter>>): Promise<void> {
  mkdirSync(dir, { mode: 0o700, recursive: true });
  // The OS releases SQLite's lock even after a hard kill. It arbitrates stale PID/socket cleanup.
  const lock = new DatabaseSync(join(dir, "daemon.lock.sqlite"));
  try {
    try {
      lock.exec("BEGIN EXCLUSIVE");
    } catch (error) {
      if ((error as { errcode?: number }).errcode === 5) throw new AlreadyRunning("Daemon already running");
      throw error;
    }
    const pidPath = join(dir, "daemon.pid");
    const address = endpoint(dir);
    rmSync(pidPath, { force: true });
    if (process.platform !== "win32") rmSync(address, { force: true });
    const token = randomBytes(32).toString("hex");
    const startedAt = Date.now();
    const log = (message: string) => {
      try { appendFileSync(join(dir, "daemon.log"), new Date().toISOString() + " " + message + "\n", { mode: 0o600 }); }
      catch { console.error(message); }
    };
    const db = openStateDb(dir);
    const native = adapters === undefined ? watchNativeSessions(db, log) : undefined;
    const agy = agyBridge(db, dir, log);
    const engine = new Engine(db, dir, adapters ?? native!.adapters, Date.now, log, native?.scan, native?.project, agy.drain);
    const shouldPoll = !!native || Object.keys(adapters ?? {}).length > 0;
    let closing = false;
    const shutdown = () => {
      closing = true;
      server.close();
    };
    const temporary = (path: string, value: unknown, publish: (from: string, to: string) => void) => {
      const tmp = path + "." + randomUUID();
      try {
        writeFileSync(tmp, JSON.stringify(value) + "\n", { flag: "wx", mode: 0o600 });
        publish(tmp, path);
      } finally {
        rmSync(tmp, { force: true });
      }
    };
    const workspaces = () => db.prepare("SELECT workspace_key, raw_path FROM workspaces WHERE enabled = 1 ORDER BY workspace_key").all();
    const config = () => temporary(join(dir, "config.json"), { workspaces: workspaces() }, renameSync);
    const dispatch = (command: string, arg: string | undefined, cancelled: () => boolean) => {
      if (closing) throw new Error("Daemon is shutting down");
      if (command === "daemon-status" || command === "daemon-stop") {
        return { running: true, pid: process.pid, startedAt, rss: process.memoryUsage.rss(), peakRss: process.resourceUsage().maxRSS * 1024 };
      }
      if (command === "resume" && arg) return engine.resume(arg);
      if ((command === "select" || command === "merge") && arg) {
        const input = JSON.parse(arg);
        if (typeof input?.threadId !== "string" || !/^th_[a-z0-9_-]+$/i.test(input.threadId) ||
            (input.agent !== "pi" && input.agent !== "codex" && input.agent !== "antigravity") ||
            (command === "merge" && (typeof input.conclusion !== "string" || !input.conclusion.trim() || input.conclusion.length > 2000))) {
          throw new Error("Invalid thread, agent or merge conclusion (1–2000 characters)");
        }
        return engine.resolveFork(input.threadId, input.agent, command === "merge" ? input.conclusion.trim() : undefined);
      }
      if (command === "sync-offline" && arg && native) {
        const input = JSON.parse(arg);
        if (input?.closed !== true || typeof input.threadId !== "string" || !/^th_[a-z0-9_-]+$/i.test(input.threadId) ||
            (input.agent !== "pi" && input.agent !== "codex")) throw new Error("Invalid offline sync request");
        return engine.serial(() => native.syncOffline(engine, input.threadId, input.agent, () => closing || cancelled()));
      }
      if (arg && (command === "agy-SessionStart" || command === "agy-PreInvocation")) {
        const event = command === "agy-SessionStart" ? "SessionStart" : "PreInvocation";
        return engine.serial(() => agy.dispatch(engine, event, arg));
      }
      if (command === "codex-pull" && native && arg) return engine.serial(() => native.codexHistory(engine, arg));
      if (command === "pi-sync" && native && arg) return engine.serial(() => native.piSync(engine, arg, () => closing || cancelled()));
      if ((command === "pi-preview" || command === "pi-pull") && native && arg) {
        return engine.serial(() => native.piHistory(engine, arg, command === "pi-pull"));
      }
      return engine.serial(() => {
        if (command === "watch" || command === "unwatch") {
          const key = arg && normalizeWorkspace(arg);
          if (!key || !arg) throw new Error("An absolute workspace path is required");
          if (command === "watch") {
            const path = /^file:/i.test(arg) ? fileURLToPath(arg) : arg;
            if (!statSync(path).isDirectory()) throw new Error("Workspace must be a directory");
            db.prepare(`INSERT INTO workspaces (workspace_key, raw_path, created_at) VALUES (?, ?, ?)
              ON CONFLICT(workspace_key) DO UPDATE SET enabled = 1, raw_path = excluded.raw_path`).run(key, path, Date.now());
          } else {
            db.prepare("UPDATE workspaces SET enabled = 0 WHERE workspace_key = ?").run(key);
          }
          config();
          return { workspace_key: key, enabled: command === "watch" };
        }
        if (command === "status") {
          const key = arg === undefined ? null : normalizeWorkspace(arg);
          if (arg !== undefined && !key) throw new Error("Invalid workspace path");
          const threads = db.prepare(`SELECT t.thread_id, t.title, t.workspace_key, t.status, t.head_turn_id, t.lca_turn_id
            FROM threads t JOIN workspaces w ON w.workspace_key = t.workspace_key AND w.enabled = 1
            WHERE t.title <> '' AND (? IS NULL OR t.workspace_key = ?) ORDER BY t.updated_at DESC`).all(key, key);
          return {
            workspaces: workspaces().filter((row) => key === null || row.workspace_key === key),
            threads: threads.map((thread) => ({ ...thread, short_id: String(thread.thread_id).slice(-8),
              marker: thread.status === "DIVERGED" ? "[fork]" : thread.status === "CIRCUIT_OPEN" ? "[circuit]" : undefined,
              bindings: db.prepare(`SELECT agent, native_session_id, branch_head_turn_id, mirror_pending, native_notice,
                last_written_turn_id, last_seen_turn_id, last_timeline_turn_id, projection_pending FROM bindings WHERE thread_id = ?`)
                .all(thread.thread_id!) })),
            notice: process.platform === "win32"
              ? "Pi 输入 /sync 更新当前会话；Codex 会话若仍持锁，请彻底退出客户端，等自动回写或运行 sync-offline <thread_id> codex --closed。"
              : "无法确认独占时，Agent Link 不追加已有原生文件。",
          };
        }
        throw new Error("Unknown daemon command");
      });
    };
    const server = createServer((socket) => {
      let input = "";
      let handled = false;
      const deadline = setTimeout(() => socket.destroy(), 5000);
      socket.once("close", () => clearTimeout(deadline));
      socket.on("error", () => {});
      socket.setEncoding("utf8");
      socket.on("data", async (chunk: string) => {
        if (handled) return;
        input += chunk;
        if (input.length > 16_384) { socket.destroy(); return; }
        const end = input.indexOf("\n");
        if (end < 0) return;
        handled = true;
        try {
          const message = JSON.parse(input.slice(0, end));
          if (!message || message.token !== token || typeof message.command !== "string" ||
              (message.arg !== undefined && typeof message.arg !== "string")) throw new Error("Invalid IPC request");
          if (["sync-offline", "pi-sync", "select", "merge"].includes(message.command)) clearTimeout(deadline);
          const value = await dispatch(message.command, message.arg, () => socket.destroyed);
          socket.end(JSON.stringify({ ok: true, value }) + "\n");
          if (message.command === "daemon-stop") shutdown();
        } catch (error) {
          socket.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }) + "\n");
        }
      });
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        await engine.sync();
        if (native) await engine.serial(() => native.syncCodexBacklog(engine, () => closing));
      } catch (error) { log(String(error)); }
      if (!closing && shouldPoll) timer = setTimeout(tick, NATIVE_QUIET_MS);
    };
    try {
      config();
      await engine.sync();
      await new Promise<void>((ready, reject) => {
        server.once("error", reject);
        server.listen(address, () => { server.off("error", reject); ready(); });
      });
      if (process.platform !== "win32") chmodSync(address, 0o600);
      temporary(pidPath, { pid: process.pid, startedAt, token }, linkSync);
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
      if (shouldPoll) timer = setTimeout(tick, NATIVE_QUIET_MS);
      await new Promise<void>((done, reject) => { server.once("close", done); server.once("error", reject); });
    } catch (error) {
      log(String(error));
      throw error;
    } finally {
      closing = true;
      clearTimeout(timer);
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      if (server.listening) await new Promise<void>((done) => server.close(() => done()));
      await engine.serial(() => db.close());
      rmSync(pidPath, { force: true });
    }
  } finally {
    lock.close();
  }
}
