import fs from "node:fs";
import { resolveEvalApproval } from "./context.mjs";
import { launcherMatches } from "./launcher.mjs";
import { equal, getValue, parseYaml } from "./merge.mjs";
import { symlinkSpec } from "./manifest.mjs";
import { openManifest } from "./transaction.mjs";
import { changedSetting, fail, noteLine, setupRows, table, tilde, warn } from "./ui.mjs";
import { SnError, lstat, readLink, readRegularFile, sha256 } from "./util.mjs";

const when = (iso) => (typeof iso === "string" ? `${iso.slice(0, 16).replace("T", " ")} UTC` : "unknown");

export function status(ctx, log = console.log) {
  const manifest = openManifest(ctx, log, false, (m, s) => log(noteLine(m, s)));
  if (!manifest) {
    log(`SUPER-NEMO is not installed in ${tilde(ctx.agentDir)}.`);
    if (lstat(ctx.state)) log(warn(`${ctx.state} exists but holds no SUPER-NEMO manifest.`));
    return 0;
  }
  log(`SUPER-NEMO is installed in ${tilde(ctx.agentDir)}.`);
  const evalApproval = Object.hasOwn(manifest.config.keys, "tools.approval.eval") ? resolveEvalApproval(manifest) : "unmanaged";
  log(table(setupRows({ ...manifest.choices, evalApproval })));
  log(`Installed from ${tilde(manifest.repo)} (updated ${when(manifest.updatedAt)}).`);
  const drift = [];
  for (const [kind, f] of Object.entries(manifest.files)) {
    const text = lstat(f.path)?.isFile() ? readRegularFile(f.path) : null;
    if (text === null) drift.push(`${f.path} is missing`);
    else if (sha256(text) !== f.postHash) drift.push(`${f.path} changed since install${kind === "config" ? " (by you or OMP)" : ""}`);
  }
  try {
    const doc = parseYaml(readRegularFile(ctx.files.config) ?? "", ctx.files.config);
    for (const [key, e] of Object.entries(manifest.config.keys)) {
      const cur = getValue(doc, key);
      if (!equal(cur, { value: e.ours })) drift.push(changedSetting(key, cur, ctx.files.config));
    }
  } catch (err) {
    if (!(err instanceof SnError)) throw err;
    drift.push(err.message);
  }
  const broken = ctx.symlinks.flatMap((s) => {
    if (!symlinkSpec(ctx, s.path)) return [`${s.path} has an unsafe parent directory`];
    const link = readLink(s.path);
    if (link === null) return [`${s.path} is missing or not a symlink`];
    if (link !== s.target) return [`${s.path} points to ${link}, expected ${s.target}`];
    if (s.path === ctx.launcher && !launcherMatches(ctx, manifest.launcherIdentity)) return [`${s.path} is not the sn launcher recorded at install`];
    return fs.existsSync(s.path) ? [] : [`${s.path} is dangling`];
  });
  log(drift.length ? `Changes since install:\n${drift.map((d) => `  ${warn(d)}`).join("\n")}` : "Changes since install: none");
  log(broken.length ? `Links:\n${broken.map((b) => `  ${fail(b)}`).join("\n")}` : "Links: OK");
  return 0;
}
