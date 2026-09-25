import fs from "node:fs";
import { equal, getValue, parseYaml } from "./merge.mjs";
import { openManifest } from "./transaction.mjs";
import { SnError, lstat, readLink, readRegularFile, sha256 } from "./util.mjs";

export function status(ctx, log = console.log) {
  const manifest = openManifest(ctx, log, false);
  if (!manifest) {
    log(`SUPER-NEMO is not installed in ${ctx.agentDir}.`);
    if (lstat(ctx.state)) log(`note: ${ctx.state} exists but holds no SUPER-NEMO manifest.`);
    return 0;
  }
  const c = manifest.choices;
  log(`SUPER-NEMO is installed in ${ctx.agentDir} from ${manifest.repo} (updated ${manifest.updatedAt}).`);
  log(`Roles: default ${c.impl}; nemo-fast ${c.fast ?? "-"}; advisor ${c.advisor ?? "off"}; advisor-critical ${c.advisorCritical ?? "off"}; nemo-review ${c.review}; approval ${c.approval}`);
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
      if (!equal(cur, { value: e.ours })) drift.push(`${key} = ${cur.absent ? "(absent)" : JSON.stringify(cur.value)} (installed ${JSON.stringify(e.ours)})`);
    }
  } catch (err) {
    if (!(err instanceof SnError)) throw err;
    drift.push(err.message);
  }
  const broken = ctx.symlinks.flatMap((s) => {
    const link = readLink(s.path);
    if (link === null) return [`${s.path} is missing or not a symlink`];
    if (link !== s.target) return [`${s.path} points to ${link}, expected ${s.target}`];
    return fs.existsSync(s.path) ? [] : [`${s.path} is dangling`];
  });
  log(drift.length ? `Drift:\n${drift.map((d) => `  - ${d}`).join("\n")}` : "Drift: none");
  log(broken.length ? `Broken links:\n${broken.map((b) => `  - ${b}`).join("\n")}` : "Links: all OK");
  return 0;
}
