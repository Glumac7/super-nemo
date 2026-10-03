import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { loadConfig, releaseRegistration } from "./linear.mjs";
import { SnError, sha256 } from "./util.mjs";
import { acquire, privateDir } from "./linear-state.mjs";

const cliPath = fileURLToPath(new URL("./linear-cli.mjs", import.meta.url));
const xml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));

function directory(dir, uid, mode = 0o700) {
  const parent = path.dirname(dir);
  if (parent !== dir) {
    const st = fs.lstatSync(parent);
    if (!st.isDirectory() || st.uid !== uid || (st.mode & 0o022)) throw new SnError(`Unsafe launchd directory: ${parent}`);
  }
  try { fs.mkdirSync(dir, { mode }); } catch (error) { if (error.code !== "EEXIST") throw error; }
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.uid !== uid || (st.mode & 0o022)) throw new SnError(`Unsafe launchd directory: ${dir}`);
}

function ownedFile(file, uid, flags) {
  const fd = fs.openSync(file, flags | fs.constants.O_NOFOLLOW, 0o600);
  const st = fs.fstatSync(fd);
  if (!st.isFile() || st.uid !== uid || (st.mode & 0o777) !== 0o600 || st.nlink !== 1) {
    fs.closeSync(fd);
    throw new SnError(`Refusing unowned or unsafe launchd file: ${file}`);
  }
  return fd;
}

async function setup(configPath, options) {
  if ((options.platform ?? process.platform) !== "darwin") throw new SnError("Linear launchd setup requires macOS");
  const uid = options.uid ?? process.getuid();
  const home = fs.realpathSync(options.home ?? os.homedir());
  const config = await (options.loadConfig ?? loadConfig)(configPath);
  const canonical = config.configPath ?? fs.realpathSync(configPath);
  if (!config.tokenFile) throw new SnError("launchd requires an external tokenFile; environment credentials are not supported");
  const label = `com.super-nemo.linear.${sha256(canonical).slice(0, 24)}`;
  const plistPath = path.join(home, "Library", "LaunchAgents", `${label}.plist`);
  const logs = path.join(config.stateDir, "launchd");
  const nodePath = options.nodePath ?? process.execPath;
  const args = [nodePath, cliPath, "run", "--config", canonical];
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>30</integer>
<key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>${xml(path.join(logs, "stdout.log"))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(logs, "stderr.log"))}</string>
</dict></plist>
`;
  const invoke = (argv) => (options.spawnSync ?? spawnSync)("/bin/launchctl", argv, {
    encoding: "utf8", env: { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, timeout: 30_000,
  });
  const command = (argv) => {
    const result = invoke(argv);
    if (!result.error && result.status === 0) return;
    if (argv[0] === "bootout" && !result.error) {
      // A failed bootout alone is ambiguous. Accept absence only when print
      // reports launchctl's service-not-found status and this exact identity.
      const probe = invoke(["print", `gui/${uid}/${label}`]);
      const absent = `Could not find service "${label}" in domain for user gui: ${uid}`;
      if (!probe.error && probe.status === 113 && String(probe.stderr).split(/\r?\n/).some((line) => line.trim() === absent)) return;
    }
    // Diagnostics are not echoed: inherited service output can be sensitive.
    throw new SnError(`launchctl ${argv[0]} failed; inspect this scoped service manually: gui/${uid}/${label}`);
  };
  return { uid, home, config, label, plistPath, logs, plist, command };
}

export async function installLaunchd(configPath, options = {}) {
  const s = await setup(configPath, options);
  privateDir(s.config.stateDir);
  // Hold the control-plane lock through every install side effect. A service
  // started by bootstrap may initially fail to acquire it; KeepAlive retries.
  const registration = (options.acquireRegistration ?? acquire)(s.config);
  try {
    directory(path.join(s.home, "Library"), s.uid, 0o700);
    directory(path.dirname(s.plistPath), s.uid, 0o700);
    directory(s.logs, s.uid);
    for (const name of ["stdout.log", "stderr.log"]) {
      const fd = ownedFile(path.join(s.logs, name), s.uid, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT);
      fs.closeSync(fd);
    }
    let fd;
    try { fd = ownedFile(s.plistPath, s.uid, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL); }
    catch (error) {
      if (error.code === "EEXIST") throw new SnError(`Refusing to overwrite existing launchd plist: ${s.plistPath}; uninstall the owned service first`);
      throw error;
    }
    try { fs.writeFileSync(fd, s.plist); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    // Keep the owned plist on bootstrap failure, allowing explicit uninstall/recovery.
    s.command(["bootstrap", `gui/${s.uid}`, s.plistPath]);
    return `Installed ${s.label} at ${s.plistPath}. State and logs: ${s.config.stateDir}`;
  } finally { registration.release(); }
}

export async function uninstallLaunchd(configPath, options = {}) {
  const s = await setup(configPath, options);
  let message;
  // Serialize bootout, plist removal and unregister against install/runtime.
  // A running or uncertain daemon must be stopped/recovered explicitly first.
  await (options.releaseRegistration ?? releaseRegistration)(s.config.configPath, undefined, () => {
    for (const dir of [s.home, path.join(s.home, "Library"), path.dirname(s.plistPath)]) {
      try {
        const st = fs.lstatSync(dir);
        if (!st.isDirectory() || st.uid !== s.uid || (st.mode & 0o022)) throw new SnError(`Unsafe launchd directory: ${dir}`);
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    let fd;
    try { fd = ownedFile(s.plistPath, s.uid, fs.constants.O_RDONLY); }
    catch (error) {
      if (error.code === "ENOENT") {
        s.command(["bootout", `gui/${s.uid}/${s.label}`]);
        message = `No launchd plist installed for ${s.label}; registration released, state and worktrees preserved.`;
        return;
      }
      throw error;
    }
    let st;
    try {
      st = fs.fstatSync(fd);
      if (fs.readFileSync(fd, "utf8") !== s.plist) throw new SnError(`Refusing to remove unowned or changed launchd plist: ${s.plistPath}`);
    } finally { fs.closeSync(fd); }
    s.command(["bootout", `gui/${s.uid}/${s.label}`]);
    const current = fs.lstatSync(s.plistPath);
    if (current.dev !== st.dev || current.ino !== st.ino || !current.isFile()) throw new SnError("Launchd plist changed during uninstall; preserved replacement");
    fs.unlinkSync(s.plistPath);
    message = `Uninstalled ${s.label}; state, claims, logs and worktrees preserved. Use status before manual recovery.`;
  });
  return message;
}
