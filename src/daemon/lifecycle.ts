import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export function dataDir(): string {
  return resolve(process.env.AGENT_LINK_HOME ?? join(homedir(), ".agent-link"));
}

export function endpoint(dir: string): string {
  const key = createHash("sha256").update(process.platform === "win32" ? dir.toLowerCase() : dir).digest("hex");
  return process.platform === "win32" ? "\\\\.\\pipe\\agent-link-" + key : join(dir, "daemon.sock");
}

export class DaemonUnavailable extends Error {}

export async function request(dir: string, command: string, arg?: string, timeout = 3000): Promise<unknown> {
  let token: string;
  try {
    token = JSON.parse(await readFile(join(dir, "daemon.pid"), "utf8")).token;
    if (typeof token !== "string") throw new Error("Invalid daemon lock");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new DaemonUnavailable("Daemon is not running");
    throw error;
  }
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint(dir));
    const deadline = setTimeout(() => socket.destroy(new Error("Daemon IPC deadline exceeded")), timeout);
    socket.once("close", () => { clearTimeout(deadline); reject(new Error("Daemon closed IPC without a reply")); });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      reject(error.code === "ENOENT" || error.code === "ECONNREFUSED"
        ? new DaemonUnavailable("Daemon is not running") : error);
    });
    socket.once("connect", () => socket.write(JSON.stringify({ token, command, arg }) + "\n"));
    socket.setEncoding("utf8");
    let received = "";
    socket.on("data", (chunk: string) => {
      received += chunk;
      if (received.length > 1024 * 1024) return socket.destroy(new Error("Daemon reply exceeds limit"));
      const end = received.indexOf("\n");
      if (end === -1) return;
      try {
        const reply = JSON.parse(received.slice(0, end));
        if (reply.ok === true) resolve(reply.value);
        else reject(new Error(String(reply.error)));
      } catch (error) {
        reject(error);
      } finally {
        socket.destroy();
      }
    });
  });
}

export async function ensureDaemon(dir: string, cli: string, timeout = 3000): Promise<unknown> {
  const deadline = Date.now() + timeout;
  try {
    return await request(dir, "daemon-status", undefined, timeout);
  } catch (error) {
    if (!(error instanceof DaemonUnavailable)) throw error;
  }
  const child = spawn(process.execPath, [cli, "daemon", "run"], {
    env: { ...process.env, AGENT_LINK_HOME: dir }, detached: true, stdio: "ignore", windowsHide: true,
  });
  let failure: Error | undefined;
  child.once("error", (error) => { failure = error; });
  child.unref();
  while (Date.now() < deadline) {
    if (failure) throw failure;
    try {
      return await request(dir, "daemon-status", undefined, Math.max(1, deadline - Date.now()));
    } catch (error) {
      if (!(error instanceof DaemonUnavailable)) throw error;
    }
    await delay(40);
  }
  throw new Error(`Daemon did not become ready before the deadline; see ${join(dir, "daemon.log")}`);
}
