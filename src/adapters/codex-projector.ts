import { execFileSync, spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";

export async function resolveCodexCli(): Promise<string> {
  const configured = process.env.AGENT_LINK_CODEX_CLI;
  const candidates = configured ? [configured] : [];
  if (!configured) {
    if (process.env.APPDATA) candidates.push(join(process.env.APPDATA, "npm", "node_modules", "@openai", "codex", "bin", "codex.js"));
    try {
      const where = join(process.env.SystemRoot || "C:\\Windows", "System32", "where.exe");
      candidates.push(...execFileSync(where, ["codex.exe"], { encoding: "utf8", windowsHide: true, timeout: 2000 }).trim().split(/\r?\n/));
    } catch { /* The npm launcher or an explicit path can still work. */ }
  }
  for (const path of candidates) {
    if (isAbsolute(path) && /\.(?:exe|[cm]?js)$/i.test(path) && (await lstat(path).catch(() => null))?.isFile()) return path;
  }
  throw new Error("Codex CLI not found; set AGENT_LINK_CODEX_CLI to its absolute executable or JS launcher path");
}

export async function projectCodexSession(cli: string, home: string, cwd: string, threadId: string, expected?: string): Promise<void> {
  const args = ["app-server", "-c", "features.daemon_auto_start=false"];
  const js = /\.[cm]?js$/i.test(cli);
  const child = spawn(js ? process.execPath : cli, js ? [cli, ...args] : args, {
    cwd, env: { ...process.env, CODEX_HOME: home }, windowsHide: true, stdio: ["pipe", "pipe", "ignore"],
  });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const lines = createInterface({ input: child.stdout });
  const replies = lines[Symbol.asyncIterator]();
  child.on("error", () => lines.close());
  child.stdin.on("error", () => lines.close());
  const timeout = setTimeout(() => lines.close(), 10_000);
  let sequence = 0;
  const send = (body: object) => child.stdin.write(JSON.stringify(body) + "\n");
  async function call(method: string, params: object) {
    const id = ++sequence;
    send({ id, method, params });
    for (;;) {
      const { value, done } = await replies.next();
      if (done) throw new Error(`Codex projection interrupted (${method}); retry offline sync`);
      const response = JSON.parse(value);
      if (response.id !== id) continue;
      if (response.error || !response.result) throw new Error(`Codex projection failed (${method}); exit the target client and retry`);
      return response.result;
    }
  }
  try {
    await call("initialize", { clientInfo: { name: "agent-link-projector", version: "0.1.0" }, capabilities: { experimentalApi: true } });
    send({ method: "initialized" });
    const resumed = await call("thread/resume", { threadId, excludeTurns: true });
    if (resumed.thread?.id !== threadId) throw new Error("Codex projection returned a different thread");
    await call("thread/unsubscribe", { threadId });
    if (expected) {
      const page = await call("thread/items/list", { threadId, turnId: expected, limit: 10 });
      const types = page.data?.map((entry: { item?: { type?: string }; type?: string }) => entry.item?.type ?? entry.type);
      if (!types?.includes("userMessage") || !types?.includes("agentMessage")) {
        throw new Error("Codex did not expose both messages of the appended turn");
      }
    }
  } finally {
    clearTimeout(timeout);
    child.stdin.end();
    const kill = setTimeout(() => { child.stdout.destroy(); child.stdin.destroy(); child.kill(); }, 2000);
    try { await closed; } finally { clearTimeout(kill); lines.close(); }
  }
}
