import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";

const windowsTool = (name: string) => process.platform === "win32"
  ? join(process.env.SystemRoot || "C:\\Windows", "System32", name) : name;

const xml = (value: string) => value.replace(/[&<>"]/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
})[char]!);

export function autostartPlan(platform: NodeJS.Platform, home: string, dir: string, node: string, entry: string, sid?: string) {
  const id = "agent-link-" + createHash("sha256").update(platform === "win32" ? dir.toLowerCase() : dir).digest("hex").slice(0, 12);
  if (platform === "win32") {
    if (!sid || !/^S-1-(?:\d+-)*\d+$/.test(sid)) throw new Error("Could not determine the current Windows user SID");
    const path = join(dir, "autostart.xml");
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Agent Link daemon for this user</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${sid}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="User"><UserId>${sid}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy></Settings>
  <Actions Context="User"><Exec><Command>${xml(node)}</Command><Arguments>${xml('"' + entry + '" daemon run')}</Arguments></Exec></Actions>
</Task>
`;
    return { path, body, command: [windowsTool("schtasks.exe"), "/Create", "/TN", id, "/XML", path, "/F"], id };
  }
  if (platform === "darwin") {
    const label = "io.agent-link." + id;
    const path = join(home, "Library", "LaunchAgents", label + ".plist");
    const args = [node, entry, "daemon", "run"].map((arg) => `    <string>${xml(arg)}</string>`).join("\n");
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>
${args}
  </array>
  <key>RunAtLoad</key><true/>
</dict></plist>
`;
    return { path, body, command: [], id: label };
  }
  if (platform === "linux") {
    const unit = id + ".service";
    const xdg = process.env.XDG_CONFIG_HOME;
    const config = xdg && isAbsolute(xdg) ? xdg : join(home, ".config");
    const path = join(config, "systemd", "user", unit);
    // systemd applies specifier and environment expansion after unquoting ExecStart.
    const quote = (value: string) => JSON.stringify(value.replaceAll("%", "%%").replaceAll("$", () => "$$"));
    const body = `[Unit]\nDescription=Agent Link daemon\n\n[Service]\nExecStart=${quote(node)} ${quote(entry)} daemon run\n\n[Install]\nWantedBy=default.target\n`;
    return { path, body, command: ["systemctl", "--user", "enable", unit], id: unit };
  }
  throw new Error(`Autostart is not supported on ${platform}`);
}

export function windowsSid(): string | undefined {
  return execFileSync(windowsTool("whoami.exe"), ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", timeout: 5000, windowsHide: true })
    .match(/\bS-1-(?:\d+-)*\d+\b/)?.[0];
}
