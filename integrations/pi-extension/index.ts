import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeWorkspace } from "../../dist/core/workspace.js";
import { DaemonUnavailable, dataDir, ensureDaemon, request } from "../../dist/daemon/lifecycle.js";

type History = { count: number; turnId?: string; content?: string; warning?: string; busy?: boolean };

export default function agentLink(pi: ExtensionAPI, dir = dataDir()) {
  const cli = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let starting = false;
  let sessionEpoch = 0;

  async function ask(command: "pi-pull" | "pi-preview", ctx: ExtensionContext): Promise<History | null> {
    try {
      const key = normalizeWorkspace(ctx.cwd);
      const config = JSON.parse(await readFile(join(dir, "config.json"), "utf8"));
      if (!key || !config.workspaces?.some((row: { workspace_key?: string }) => row.workspace_key === key)) return null;
      const path = ctx.sessionManager.getSessionFile();
      const leaf = ctx.sessionManager.getLeafId() ?? null;
      const arg = path ? JSON.stringify({ path, cwd: ctx.cwd, leaf }) : undefined;
      return await request(dir, arg ? command : "daemon-status", arg, command === "pi-pull" ? 1500 : 350) as History | null;
    } catch (error) {
      if (error instanceof DaemonUnavailable && !starting) {
        starting = true;
        void ensureDaemon(dir, cli).catch(() => {}).finally(() => { starting = false; });
      }
      return null;
    }
  }

  pi.on("session_start", (_event, ctx) => {
    const epoch = ++sessionEpoch;
    const refresh = async () => {
      const pending = await ask("pi-preview", ctx);
      if (sessionEpoch !== epoch || !ctx.hasUI || !ctx.isIdle()) return;
      ctx.ui.setWidget("agent-link", pending?.warning ? [pending.warning] : pending?.busy
        ? ["Codex 正在回复中，稍后可更新"] : pending?.count
        ? [`检测到 ${pending.count} 轮新问答 · 输入 /sync 更新当前会话`] : undefined);
    };
    void refresh();
    heartbeat = setInterval(() => void refresh(), 2000);
    heartbeat.unref();
  });
  pi.on("session_shutdown", () => {
    sessionEpoch++;
    clearInterval(heartbeat);
  });
  pi.on("before_agent_start", async (_event, ctx) => {
    const pending = await ask("pi-pull", ctx);
    if (!pending?.turnId || !pending.content) return;
    return { message: { customType: "agent-link", content: pending.content, display: true,
      details: { turnId: pending.turnId } } };
  });
  pi.registerCommand("sync", {
    description: "追加未同步问答并重新读取当前会话",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      const path = ctx.sessionManager.getSessionFile();
      if (!path) return;
      if (process.platform === "win32") {
        try {
          await request(dir, "pi-sync", JSON.stringify({ path, cwd: ctx.cwd,
            leaf: ctx.sessionManager.getLeafId() ?? null }), 15_000);
        } catch (error) {
          if (!(error instanceof DaemonUnavailable)) {
            if (ctx.hasUI) ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
            return;
          }
        }
      }
      await ctx.switchSession(path);
    },
  });
}
