import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { installLaunchd, uninstallLaunchd } from "../lib/linear-launchd.mjs";
import { acquire, releaseRegistration } from "../lib/linear-state.mjs";

function fixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sn-launchd-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const stateDir = path.join(home, "state");
  fs.mkdirSync(stateDir, { mode: 0o700 });
  const configPath = path.join(home, "config & <operator>.json");
  fs.writeFileSync(configPath, "{}", { mode: 0o600 });
  const calls = [];
  const options = {
    platform: "darwin", home, uid: process.getuid(), nodePath: process.execPath,
    loadConfig: async () => ({ configPath, stateDir, tokenFile: path.join(home, "external-token") }),
    releaseRegistration: async (_config, _dir, callback) => { callback(); },
    acquireRegistration: () => ({ release() {} }),
    spawnSync: (...args) => { calls.push(args); return { status: 0 }; },
  };
  const plist = () => path.join(home, "Library", "LaunchAgents", fs.readdirSync(path.join(home, "Library", "LaunchAgents"))[0]);
  return { home, stateDir, configPath, options, calls, plist };
}

test("launchd uses private plist, escaped absolute argv and scoped commands without credentials", async (t) => {
  const f = fixture(t);
  assert.match(await installLaunchd(f.configPath, f.options), /Installed/);
  const p = f.plist();
  const text = fs.readFileSync(p, "utf8");
  assert.equal(fs.statSync(p).mode & 0o777, 0o600);
  assert.match(text, /config &amp; &lt;operator&gt;\.json/);
  assert.match(text, /<key>KeepAlive<\/key><true\/>/);
  assert.match(text, /<key>RunAtLoad<\/key><true\/>/);
  assert.ok(!text.includes("external-token"));
  assert.ok(!text.includes("EnvironmentVariables"));
  assert.deepEqual(f.calls[0][1], ["bootstrap", `gui/${process.getuid()}`, p]);
  assert.deepEqual(Object.keys(f.calls[0][2].env).sort(), ["HOME", "PATH"]);
  fs.writeFileSync(path.join(f.stateDir, "claim.json"), "durable");
  assert.match(await uninstallLaunchd(f.configPath, f.options), /preserved/);
  assert.match(f.calls[1][1][1], /^gui\/\d+\/com\.super-nemo\.linear\.[a-f0-9]{24}$/);
  assert.equal(f.calls[1][1][0], "bootout");
  assert.equal(fs.existsSync(p), false);
  assert.equal(fs.readFileSync(path.join(f.stateDir, "claim.json"), "utf8"), "durable");
});

test("never overwrites an existing plist or removes changed content", async (t) => {
  const f = fixture(t);
  await installLaunchd(f.configPath, f.options);
  const p = f.plist();
  const original = fs.readFileSync(p, "utf8");
  await assert.rejects(installLaunchd(f.configPath, f.options), /overwrite/);
  assert.equal(fs.readFileSync(p, "utf8"), original);
  fs.appendFileSync(p, "unowned change");
  await assert.rejects(uninstallLaunchd(f.configPath, f.options), /unowned or changed/);
  assert.equal(f.calls.length, 1);
});

test("rejects unsafe permissions, symlinks and foreign ownership", async (t) => {
  const f = fixture(t);
  await installLaunchd(f.configPath, f.options);
  const p = f.plist();
  fs.chmodSync(p, 0o644);
  await assert.rejects(uninstallLaunchd(f.configPath, f.options), /unsafe/);
  fs.chmodSync(p, 0o600);
  await assert.rejects(uninstallLaunchd(f.configPath, { ...f.options, uid: process.getuid() + 1 }), /[Uu]nsafe/);
  fs.renameSync(p, `${p}.original`);
  fs.symlinkSync(`${p}.original`, p);
  await assert.rejects(uninstallLaunchd(f.configPath, f.options));
  assert.equal(f.calls.length, 1);
});

test("rejects symlinked launch directories and log files without service actions", async (t) => {
  const f = fixture(t);
  const other = path.join(f.home, "other");
  fs.mkdirSync(other);
  fs.symlinkSync(other, path.join(f.home, "Library"));
  await assert.rejects(installLaunchd(f.configPath, f.options), /Unsafe/);
  fs.unlinkSync(path.join(f.home, "Library"));
  fs.mkdirSync(path.join(f.stateDir, "launchd"), { mode: 0o700 });
  fs.symlinkSync(f.configPath, path.join(f.stateDir, "launchd", "stdout.log"));
  await assert.rejects(installLaunchd(f.configPath, f.options));
  assert.equal(f.calls.length, 0);
  assert.equal(fs.readFileSync(f.configPath, "utf8"), "{}");
});

test("bootstrap/bootout failures preserve owned plist and do not leak diagnostics", async (t) => {
  const f = fixture(t);
  f.options.spawnSync = () => ({ status: 1, stderr: "sensitive diagnostics" });
  await assert.rejects(installLaunchd(f.configPath, f.options), (error) => /bootstrap failed/.test(error.message) && !error.message.includes("sensitive"));
  const p = f.plist();
  await assert.rejects(uninstallLaunchd(f.configPath, f.options), /bootout failed/);
  assert.equal(fs.existsSync(p), true);
});

test("non-Mac and environment-only credential configurations fail closed", async (t) => {
  const f = fixture(t);
  await assert.rejects(installLaunchd(f.configPath, { ...f.options, platform: "linux" }), /macOS/);
  await assert.rejects(installLaunchd(f.configPath, { ...f.options, loadConfig: () => ({ stateDir: f.stateDir }) }), /tokenFile/);
  assert.equal(f.calls.length, 0);
  assert.match(await uninstallLaunchd(f.configPath, f.options), /No launchd plist/);
});

test("absent plist still stops loaded service before releasing registration", async (t) => {
  const f = fixture(t);
  let released = false;
  f.options.releaseRegistration = async (_config, _dir, callback) => { callback(); released = true; };
  f.options.spawnSync = () => ({ status: 1 });
  await assert.rejects(uninstallLaunchd(f.configPath, f.options), /bootout failed/);
  assert.equal(released, false);
  f.options.spawnSync = (_bin, argv) => {
    assert.equal(released, false);
    assert.equal(argv[0], "bootout");
    return { status: 0 };
  };
  await uninstallLaunchd(f.configPath, f.options);
  assert.equal(released, true);
});

test("confirmed exact service absence permits repeated uninstall; ambiguous print does not", async (t) => {
  const f = fixture(t);
  let releases = 0;
  f.options.releaseRegistration = async (_config, _dir, callback) => { callback(); releases++; };
  f.options.spawnSync = (_bin, argv) => argv[0] === "bootout" ? { status: 3 } : {
    status: 113,
    stderr: `Bad request.\nCould not find service "${argv[1].split("/").at(-1)}" in domain for user gui: ${process.getuid()}\n`,
  };
  await uninstallLaunchd(f.configPath, f.options);
  await uninstallLaunchd(f.configPath, f.options);
  assert.equal(releases, 2);
  f.options.spawnSync = () => ({ status: 113, stderr: "permission denied" });
  await assert.rejects(uninstallLaunchd(f.configPath, f.options), /bootout failed/);
  assert.equal(releases, 2);
});

test("macOS plutil validates the generated plist without installing a service", { skip: process.platform !== "darwin" }, async (t) => {
  const f = fixture(t);
  await installLaunchd(f.configPath, f.options);
  const result = spawnSync("/usr/bin/plutil", ["-lint", f.plist()], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("install refuses a conflicting canonical registration before writing a plist or bootstrapping", async (t) => {
  const f = fixture(t);
  f.options.acquireRegistration = () => { throw new Error("Another configuration is registered"); };
  await assert.rejects(installLaunchd(f.configPath, f.options), /Another configuration/);
  assert.equal(f.calls.length, 0);
  assert.equal(fs.existsSync(path.join(f.home, "Library")), false);
});

test("uninstall releases registration using the canonical config identity", async (t) => {
  const f = fixture(t);
  let identity;
  f.options.releaseRegistration = async (value, _dir, callback) => { callback(); identity = value; };
  await uninstallLaunchd(path.join(f.home, "alias.json"), f.options);
  assert.equal(identity, f.configPath);
});

test("install excludes concurrent unregister and another topology through bootstrap", async (t) => {
  const f = fixture(t);
  const control = path.join(f.home, "control");
  const config = await f.options.loadConfig();
  const other = { ...config, configPath: path.join(f.home, "other.json"), stateDir: path.join(f.home, "other-state") };
  f.options.acquireRegistration = (value) => acquire(value, control);
  f.options.spawnSync = (_bin, argv) => {
    assert.equal(argv[0], "bootstrap");
    assert.equal(fs.existsSync(argv[2]), true);
    assert.throws(() => releaseRegistration(config.configPath, control), /active or uncertain/);
    assert.throws(() => acquire(other, control), /locked/);
    assert.throws(() => acquire(config, control), /locked/);
    return { status: 0 };
  };
  await installLaunchd(f.configPath, f.options);
  assert.equal(fs.existsSync(path.join(control, "lock.json")), false);
  assert.throws(() => acquire(other, control), /Another configuration/);
  const runtime = acquire(config, control);
  runtime.release();
});

test("install failures release the lifecycle lock but preserve registration", async (t) => {
  for (const failure of ["directory", "bootstrap"]) {
    const f = fixture(t);
    const control = path.join(f.home, "control");
    const config = await f.options.loadConfig();
    f.options.acquireRegistration = (value) => acquire(value, control);
    if (failure === "directory") fs.symlinkSync(f.stateDir, path.join(f.home, "Library"));
    else f.options.spawnSync = () => ({ status: 1 });
    await assert.rejects(installLaunchd(f.configPath, f.options), failure === "directory" ? /Unsafe/ : /bootstrap failed/);
    assert.equal(fs.existsSync(path.join(control, "lock.json")), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(control, "registry.json"), "utf8")).configPath, config.configPath);
    const runtime = acquire(config, control);
    runtime.release();
  }
});

test("uninstall excludes competing install through bootout and registry removal", async (t) => {
  const f = fixture(t);
  const control = path.join(f.home, "control");
  const config = await f.options.loadConfig();
  const other = { ...config, configPath: path.join(f.home, "other.json"), stateDir: path.join(f.home, "other-state") };
  f.options.acquireRegistration = (value) => acquire(value, control);
  f.options.releaseRegistration = (value, _dir, callback) => releaseRegistration(value, control, callback);
  await installLaunchd(f.configPath, f.options);
  const plist = f.plist();
  f.options.spawnSync = (_bin, argv) => {
    assert.equal(argv[0], "bootout");
    assert.equal(fs.existsSync(plist), true);
    assert.throws(() => acquire(config, control), /locked/);
    assert.throws(() => acquire(other, control), /locked/);
    return { status: 0 };
  };
  await uninstallLaunchd(f.configPath, f.options);
  assert.equal(fs.existsSync(plist), false);
  assert.equal(fs.existsSync(path.join(control, "registry.json")), false);
  assert.equal(fs.existsSync(path.join(control, "lock.json")), false);
  const next = acquire(other, control);
  next.release();
});

test("uninstall refuses an active lock before service effects and preserves registration on failure", async (t) => {
  const f = fixture(t);
  const control = path.join(f.home, "control");
  const config = await f.options.loadConfig();
  f.options.acquireRegistration = (value) => acquire(value, control);
  f.options.releaseRegistration = (value, _dir, callback) => releaseRegistration(value, control, callback);
  await installLaunchd(f.configPath, f.options);
  const plist = f.plist();
  const runtime = acquire(config, control);
  await assert.rejects(uninstallLaunchd(f.configPath, f.options), /active or uncertain/);
  assert.equal(f.calls.length, 1);
  assert.equal(fs.existsSync(plist), true);
  runtime.release();
  f.options.spawnSync = () => ({ status: 1 });
  await assert.rejects(uninstallLaunchd(f.configPath, f.options), /bootout failed/);
  assert.equal(fs.existsSync(plist), true);
  assert.equal(fs.existsSync(path.join(control, "registry.json")), true);
  assert.equal(fs.existsSync(path.join(control, "lock.json")), false);
});

test("absent-plist uninstall holds lock during bootout and cannot touch a foreign registration", async (t) => {
  const f = fixture(t);
  const control = path.join(f.home, "control");
  const config = await f.options.loadConfig();
  const registration = acquire(config, control);
  registration.release();
  f.options.releaseRegistration = (value, _dir, callback) => releaseRegistration(value, control, callback);
  f.options.spawnSync = (_bin, argv) => {
    assert.equal(argv[0], "bootout");
    assert.throws(() => acquire(config, control), /locked/);
    return { status: 0 };
  };
  assert.match(await uninstallLaunchd(f.configPath, f.options), /No launchd plist/);
  const other = { ...config, configPath: path.join(f.home, "other.json") };
  const foreign = acquire(other, control);
  foreign.release();
  f.options.spawnSync = () => { assert.fail("foreign registration must reject before bootout"); };
  await assert.rejects(uninstallLaunchd(f.configPath, f.options), /does not own registry/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(control, "registry.json"), "utf8")).configPath, other.configPath);
});
