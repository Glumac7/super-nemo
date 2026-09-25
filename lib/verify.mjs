import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { ourPatterns, runOmp, watchdogEntry } from "./context.mjs";
import { checkRoots, loadManifest } from "./manifest.mjs";
import { BEGIN, END, equal, getValue, parseYaml, patternList, shadowedBy } from "./merge.mjs";
import { loadModels, parseRole } from "./models.mjs";
import { lstat, readLink, readRegularFile } from "./util.mjs";

function frontmatter(file) {
  const m = /^---\n([\s\S]*?)\n---(\n|$)/.exec(fs.readFileSync(file, "utf8"));
  if (!m) return null;
  try {
    return YAML.parse(m[1]);
  } catch {
    return null;
  }
}

function blockBody(text) {
  if (text === null) return null;
  const m = new RegExp(`${BEGIN}\\n([\\s\\S]*?)\\n${END}`).exec(text);
  return m ? m[1] : null;
}

function imports(ctx, text) {
  return [...text.matchAll(/^@(~\/\S+)\s*$/gm)].map((m) => ({ ref: m[1], abs: path.join(ctx.home, m[1].slice(2)) }));
}

function readable(p) {
  try {
    fs.accessSync(p, fs.constants.R_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

async function effectiveValue(ctx, key, cache) {
  const parts = key.split(".");
  for (let n = parts.length; n >= 1; n--) {
    const name = parts.slice(0, n).join(".");
    cache[name] ??= runOmp(ctx, ["config", "get", name, "--json"]);
    const res = await cache[name];
    if (!res.ok) continue;
    let value;
    try {
      value = JSON.parse(res.stdout).value;
    } catch {
      return { ok: false };
    }
    for (const part of parts.slice(n)) value = value && typeof value === "object" && part in value ? value[part] : undefined;
    return { ok: true, value };
  }
  return { ok: false };
}

export async function verify(ctx, { smoke = false } = {}, log = console.log) {
  const failures = [];
  const warnings = [];
  const fail = (msg) => failures.push(msg);
  const manifest = loadManifest(ctx);
  if (!manifest || manifest.status !== "installed") {
    log("SUPER-NEMO is not installed.");
    return false;
  }
  checkRoots(ctx, manifest);

  const configText = readRegularFile(ctx.files.config);
  const doc = parseYaml(configText ?? "", ctx.files.config);
  const cache = {};
  await effectiveValue(ctx, "tools.approvalMode", cache);
  const effective = await Promise.all(Object.keys(manifest.config.keys).map((key) => effectiveValue(ctx, key, cache)));
  Object.entries(manifest.config.keys).forEach(([key, { ours }], i) => {
    if (!equal(getValue(doc, key), { value: ours })) fail(`${key} is not ${JSON.stringify(ours)} in ${ctx.files.config}`);
    else if (!effective[i].ok) warnings.push(`omp config get could not read ${key}`);
    else if (!equal(effective[i].value, ours)) {
      warnings.push(`${key}: omp sees ${JSON.stringify(effective[i].value)} (an overlay or env setting shadows ${JSON.stringify(ours)})`);
    }
  });
  const patterns = patternList(doc);
  for (const entry of manifest.config.patterns.inserted) {
    if (!patterns.some((p) => equal(p, entry))) fail(`bash.patterns is missing ${JSON.stringify(entry)}`);
  }
  const shadowing = new Set();
  for (const deny of ourPatterns(ctx).filter((e) => e.approval === "deny")) {
    const by = shadowedBy(patterns, deny);
    if (by === undefined) fail(`bash.patterns is missing ${JSON.stringify(deny)}`);
    else if (by) shadowing.add(JSON.stringify(by));
  }
  for (const by of shadowing) fail(`bash.patterns: ${by} comes before SUPER-NEMO's deny rules and can override them (first match wins)`);

  for (const s of ctx.symlinks) {
    if (readLink(s.path) !== s.target) fail(`${s.path} is not a symlink to ${s.target}`);
    else if (!fs.existsSync(s.path)) fail(`${s.path} is a broken symlink`);
  }

  for (const name of ctx.names.skills) {
    const fm = frontmatter(path.join(ctx.repo, "skills", name, "SKILL.md"));
    if (fm?.name !== name || typeof fm?.description !== "string" || !fm.description) fail(`skills/${name}/SKILL.md frontmatter needs name: ${name} and a description`);
  }
  for (const name of ctx.names.agents) {
    const fm = frontmatter(path.join(ctx.repo, "agents", `${name}.md`));
    if (fm?.name !== name || typeof fm?.description !== "string" || !fm.description) fail(`agents/${name}.md frontmatter needs name: ${name} and a description`);
  }

  const reads = await Promise.all(ctx.names.skills.map((n) => runOmp(ctx, ["read", `skill://${n}`])));
  ctx.names.skills.forEach((name, i) => {
    const res = reads[i];
    if (!res.ok) fail(`omp read skill://${name} failed: ${(res.stderr || res.stdout).trim().split("\n")[0]}`);
    else if (res.stdout.trim() !== fs.readFileSync(path.join(ctx.repo, "skills", name, "SKILL.md"), "utf8").trim()) {
      fail(`skill://${name} resolves to a different copy than ${ctx.repo}/skills/${name}`);
    }
  });

  let models = [];
  try {
    models = await loadModels(ctx);
    if (!models.length) fail("omp models --json lists no available models; run `omp login`");
  } catch (err) {
    fail(err.message);
  }
  const c = manifest.choices;
  for (const [role, value] of [["default", c.impl], ["nemo-fast", c.fast], ["advisor", c.advisor], ["advisor-critical", c.advisorCritical], ["nemo-review", c.review]]) {
    if (value && models.length && !parseRole(models, value)) fail(`modelRoles.${role} ${value} is not in omp models --json`);
  }

  const sources = [
    [ctx.files.agents, blockBody(readRegularFile(ctx.files.agents))],
    [ctx.files.watchdogMd, blockBody(readRegularFile(ctx.files.watchdogMd))],
    [path.join(ctx.repo, "blocks", "AGENTS.md"), fs.readFileSync(path.join(ctx.repo, "blocks", "AGENTS.md"), "utf8")],
  ];
  for (const [file, text] of sources) {
    if (text === null) {
      fail(`${file} has no super-nemo block`);
      continue;
    }
    const refs = imports(ctx, text);
    if (!refs.length) fail(`${file} has no @~/ import`);
    for (const r of refs) if (!readable(r.abs)) fail(`${file}: @${r.ref} does not resolve to a readable file`);
  }
  const wdoc = lstat(ctx.files.watchdogYml) ? parseYaml(readRegularFile(ctx.files.watchdogYml), ctx.files.watchdogYml) : null;
  const advisors = wdoc ? (getValue(wdoc, "advisors").value ?? []) : [];
  const entry = watchdogEntry(ctx);
  if (!Array.isArray(advisors) || !advisors.some((a) => equal(a, entry))) fail(`${ctx.files.watchdogYml} lacks the ${entry.name} advisor`);

  if (smoke && !failures.length) {
    for (const mode of ["light", "normal"]) {
      log(`Running smoke eval: ${mode}`);
      const res = spawnSync("bash", [path.join(ctx.repo, "evals", "smoke.sh"), mode], { env: ctx.env, stdio: "inherit" });
      if (res.status !== 0) fail(`smoke eval ${mode} failed`);
    }
  }

  for (const w of warnings) log(`warning: ${w}`);
  for (const f of failures) log(`FAIL ${f}`);
  log(failures.length ? `verify: ${failures.length} problem(s)` : "verify: OK");
  return failures.length === 0;
}
