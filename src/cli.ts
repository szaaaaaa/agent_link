#!/usr/bin/env node

const [major, minor] = process.versions.node.split(".").map(Number);

if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`agent-link requires Node.js >= 22.13.0 (found ${process.versions.node}).`);
  process.exit(1);
} else {
  const command = process.argv[2];
  if (command === "--version") {
    // Read after the runtime check so older Node versions can show the error above.
    const { readFileSync } = await import("node:fs");
    const metadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    console.log(metadata.version);
  } else if (!command || command === "--help") {
    console.log(`Usage: agent-link [--help | --version]
  install [--autostart]
  watch <workspace> | unwatch <workspace>
  status [workspace] | resume <thread_id>
  select <thread_id> <pi|codex|antigravity>
  merge <thread_id> --into <pi|codex|antigravity> -m <conclusion>
  sync-offline <thread_id> <pi|codex> --closed  (Windows; exit the target client first)
  daemon start | stop | status | run
  hook SessionStart | PreInvocation | Stop | CodexPrompt`);
  } else {
    try {
      const { dataDir, request, ensureDaemon, DaemonUnavailable } = await import("./daemon/lifecycle.js");
      const { fileURLToPath } = await import("node:url");
      const { resolve } = await import("node:path");
      const [, , , arg, ...rest] = process.argv;
      const dir = dataDir();
      const start = () => ensureDaemon(dir, fileURLToPath(import.meta.url));
      let output: unknown;
      if (rest.length && !["sync-offline", "select", "merge"].includes(command)) throw new Error("Too many arguments");
      if (command === "select" || command === "merge") {
        const selecting = command === "select";
        if (selecting ? rest.length !== 1 : rest.length !== 4 || rest[0] !== "--into" || rest[2] !== "-m") {
          throw new Error("Usage: select <thread_id> <agent> | merge <thread_id> --into <agent> -m <conclusion>");
        }
        await start();
        output = await request(dir, command, JSON.stringify({ threadId: arg, agent: rest[selecting ? 0 : 1],
          conclusion: selecting ? undefined : rest[3] }), 60_000);
      } else if (command === "sync-offline") {
        if (!arg || !/^th_[a-z0-9_-]+$/i.test(arg) || rest.length !== 2 ||
            (rest[0] !== "pi" && rest[0] !== "codex") || rest[1] !== "--closed") {
          throw new Error("Exit the target client, then run sync-offline <thread_id> <pi|codex> --closed");
        }
        if (process.platform !== "win32") throw new Error("Verified offline file leases are currently supported only on Windows");
        await start();
        output = await request(dir, "sync-offline", JSON.stringify({ threadId: arg, agent: rest[0], closed: true }), 60_000);
      } else if (command === "install" && (arg === undefined || arg === "--autostart")) {
        const { install } = await import("./install.js");
        output = await install(dir, fileURLToPath(import.meta.url), arg === "--autostart");
      } else if (command === "hook" && arg === "CodexPrompt") {
        const { runCodexPromptHook } = await import("./codex-hook.js");
        output = await runCodexPromptHook(dir, fileURLToPath(import.meta.url));
      } else if (command === "hook" && (arg === "SessionStart" || arg === "PreInvocation" || arg === "Stop")) {
        const { runAgyHook } = await import("./agy-hook.js");
        output = await runAgyHook(arg, dir, fileURLToPath(import.meta.url));
      } else if (command === "daemon" && arg === "run") {
        const { serve } = await import("./daemon/server.js");
        await serve(dir);
      } else if (command === "daemon" && arg === "start") {
        output = await start();
      } else if (command === "daemon" && (arg === "stop" || arg === "status")) {
        try { output = await request(dir, "daemon-" + arg); }
        catch (error) {
          if (!(error instanceof DaemonUnavailable)) throw error;
          output = { running: false };
        }
      } else if (command === "status" || (arg && ["watch", "unwatch", "resume"].includes(command))) {
        await start();
        const value = arg && command !== "resume" && !/^file:/i.test(arg) ? resolve(arg) : arg;
        output = await request(dir, command, value);
      } else {
        throw new Error(`Invalid command: ${command}; see agent-link --help`);
      }
      if (output !== undefined) console.log(JSON.stringify(output, null, command === "hook" ? 0 : 2));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
