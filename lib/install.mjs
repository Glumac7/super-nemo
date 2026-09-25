import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { KINDS, MANAGED_KEYS, desiredKeys, ourPatterns, runOmp, watchdogEntry } from "./context.mjs";
import { originUrl, tryGit } from "./git.mjs";
import { backupPath, isStaleLink, saveManifest, staleLinkSpec, symlinkSpec } from "./manifest.mjs";
import {
  AGENTS_BODY, BEGIN, WATCHDOG_BODY, addWatchdog, checkBlock, checkMapPath, checkPatterns, checkWatchdog, equal, getValue, insertPatterns,
  detachOwnedPatterns, parseYaml, patternList, patternsEqual, restoreValue, setValue, stringifyYaml, upsertBlock,
} from "./merge.mjs";
import { cheapestReasoning, formatRole, loadModels, parseRole, pickThinking, roleFromFlag, strongest } from "./models.mjs";
import { choose, ttyPrompter, yesNo, yesNoChange } from "./prompts.mjs";
import { backupRel, openManifest, rollback, timestamp } from "./transaction.mjs";
import {
  KEPT, bold, bullet, changedSetting, dim, fail, modelName, noteLine, ok, sep, settingValue, setupRows, table, tilde, warn,
} from "./ui.mjs";
import { SnError, isDirectory, lstat, missingDirs, readLink, readRegularFile, rmdirIfEmpty, sha256, writeIfUnchanged } from "./util.mjs";
import { smokeTest, verify } from "./verify.mjs";

const APPROVALS = ["write", "always-ask", "yolo"];
const YAML_KINDS = new Set(["config", "watchdogYml"]);

async function preflightTools(ctx) {
  const res = await runOmp(ctx, ["--version"]);
  if (!res.ok) throw new SnError("omp is not on PATH; install Oh My Pi 18.3.0 or newer");
  const v = /(\d+)\.(\d+)\.(\d+)/.exec(res.stdout)?.slice(1).map(Number);
  if (!v || v[0] < 18 || (v[0] === 18 && v[1] < 3)) throw new SnError(`omp ${res.stdout.trim()} is too old; need 18.3.0 or newer`);
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
  } catch {
    throw new SnError("git is not on PATH");
  }
  if (Number(process.versions.node.split(".")[0]) < 20) throw new SnError("node 20 or newer is required");
}

function inspect(ctx, manifest) {
  const problems = [];
  const texts = {};
  const docs = {};
  if (ctx.configProblem) problems.push(ctx.configProblem);
  if (lstat(ctx.snHome) && !isDirectory(ctx.snHome)) problems.push(`${ctx.snHome} exists and is not a directory`);
  const state = lstat(ctx.state);
  if (state && !manifest) problems.push(`${ctx.state} exists but holds no SUPER-NEMO manifest; move it away first`);
  if (state && !state.isDirectory()) problems.push(`${ctx.state} is not a directory`);
  const backups = lstat(ctx.backupsDir);
  if (backups && !backups.isDirectory()) problems.push(`${ctx.backupsDir} is a symlink or not a directory`);
  if (lstat(ctx.agentDir) && !isDirectory(ctx.agentDir)) problems.push(`${ctx.agentDir} is not a directory`);
  for (const dir of ["skills", "agents"].map((d) => path.join(ctx.agentDir, d))) {
    const st = lstat(dir);
    if (st && !st.isDirectory()) problems.push(`${dir} is a symlink or not a directory; refusing to write through it`);
  }
  const dirs = [...new Set(["skills", "agents"].flatMap((d) => missingDirs(path.join(ctx.agentDir, d))))];
  for (const d of dirs) if (!ctx.allowedDirs.includes(d)) problems.push(`${path.dirname(d)} does not exist`);
  const symlinks = [];
  for (const spec of ctx.symlinks) {
    const st = lstat(spec.path);
    const link = readLink(spec.path);
    if (!st) symlinks.push(spec);
    else if (link !== spec.target) problems.push(`${spec.path} already exists${link !== null ? ` (symlink to ${link})` : ""} and is not ours`);
  }
  if (problems.some((p) => p.endsWith("and is not ours"))) {
    problems.push("leftovers from a manual install, or links into another checkout of this repo, count as conflicts: move them away (or run uninstall from that checkout), then install again");
  }
  const entry = watchdogEntry(ctx);
  for (const kind of KINDS) {
    const file = ctx.files[kind];
    try {
      texts[kind] = readRegularFile(file);
      if (YAML_KINDS.has(kind)) docs[kind] = parseYaml(texts[kind], file);
      else checkBlock(texts[kind] ?? "", file);
    } catch (err) {
      if (!(err instanceof SnError)) throw err;
      problems.push(err.message);
    }
  }
  if (docs.config) {
    try {
      for (const key of MANAGED_KEYS) checkMapPath(docs.config, key, ctx.files.config);
      checkPatterns(docs.config, ctx.files.config);
    } catch (err) {
      problems.push(err.message);
    }
  }
  if (docs.watchdogYml) {
    try {
      checkWatchdog(docs.watchdogYml, entry, ctx.files.watchdogYml);
    } catch (err) {
      problems.push(err.message);
    }
  }
  const staleLinks = [];
  const keptLinks = [];
  const notes = [];
  for (const p of manifest?.symlinks ?? []) {
    if (typeof p !== "string" || symlinkSpec(ctx, p) || !lstat(p)) continue;
    const spec = staleLinkSpec(ctx, p);
    if (!spec) notes.push(`left ${p}: not a path this installer manages`);
    else if (isStaleLink(ctx, p)) staleLinks.push(spec);
    else {
      keptLinks.push(p);
      notes.push(`left ${p}: no longer shipped and not a link into ${ctx.repo} that SUPER-NEMO can prove it owns`);
    }
  }
  return { problems, texts, docs, symlinks, dirs, staleLinks, keptLinks, notes };
}

function currentRole(models, doc, key) {
  const v = getValue(doc, key);
  return !v.absent && parseRole(models, v.value) ? v.value : null;
}

function withThinking(models, role, preferred) {
  const model = parseRole(models, role).model;
  return formatRole(model, pickThinking(model, preferred));
}

export function computeDefaults(models, doc, manifest, flags) {
  if (!models.length) throw new SnError("omp models --json lists no models; log in to a provider in omp first");
  const flag = (name, thinking) => roleFromFlag(models, flags[name], `--${name}`, thinking);
  const top = strongest(models);
  const impl = flags.impl ? flag("impl", "high") : currentRole(models, doc, "modelRoles.default") ?? formatRole(top, pickThinking(top, "high"));
  const implModel = parseRole(models, impl).model;
  let fast = currentRole(models, doc, "modelRoles.nemo-fast");
  if (flags.fast === "none") fast = null;
  else if (flags.fast) fast = flag("fast", "low");
  const advisorOff = getValue(doc, "task.agentAdvisor.nemo-implementer").value === "off";
  let advisor = advisorOff ? null : currentRole(models, doc, "modelRoles.advisor") ?? withThinking(models, impl, "medium");
  if (flags.advisor === "off") advisor = null;
  else if (flags.advisor) advisor = flag("advisor", "medium");
  if (flags["advisor-critical"] && !advisor) throw new SnError("--advisor-critical cannot be combined with the advisor turned off", 2);
  const advisorSuggestion = advisor ?? withThinking(models, impl, "medium");
  let advisorCritical = flags["advisor-critical"] ? flag("advisor-critical", "high") : currentRole(models, doc, "modelRoles.advisor-critical");
  advisorCritical ??= withThinking(models, advisorSuggestion, "high");
  const other = strongest(models.filter((m) => m.provider !== implModel.provider));
  const review = flags.review ? flag("review", "high") : currentRole(models, doc, "modelRoles.nemo-review")
    ?? (other ? formatRole(other, pickThinking(other, "high")) : withThinking(models, impl, "high"));
  if (flags.approval && !APPROVALS.includes(flags.approval)) {
    throw new SnError(`--approval must be one of ${APPROVALS.join(", ")}`, 2);
  }
  const approval = flags.approval ?? manifest?.choices?.approval ?? "write";
  return { impl, fast, advisor, advisorCritical: advisor ? advisorCritical : null, review, approval, installed: Boolean(manifest) };
}

const choicesOf = (d) => ({ impl: d.impl, fast: d.fast, advisor: d.advisor, advisorCritical: d.advisorCritical, review: d.review, approval: d.approval });

export const setupTable = (header, choices) => `${bold(header)}\n${table(setupRows(choices))}`;

async function pickModel(p, models, title, role, preferredThinking, { first, mark, cheapest } = {}) {
  const current = role ? parseRole(models, role) : null;
  const offset = first ? 1 : 0;
  const def = current ? offset + models.indexOf(current.model) : 0;
  const labels = [...(first ? [first] : []), ...models.map((m) => `${modelName(m.selector)}${dim(`${sep()}${m.provider}`)}`)].map((label, i) => {
    if (i === def) return `${label}  (${mark})`;
    return cheapest && models[i - offset] === cheapest ? `${label}  ${dim("(cheapest)")}` : label;
  });
  const i = await choose(p, title, labels, def);
  if (first && i === 0) return null;
  const model = models[i - offset];
  if (!model.thinking) return model.selector;
  const keep = model === current?.model && current.thinking;
  const want = keep ? current.thinking : pickThinking(model, preferredThinking);
  const t = model.thinking.indexOf(want);
  const levels = model.thinking.map((level, j) => (j === t ? `${level}  (${keep ? mark : "suggested"})` : level));
  return formatRole(model, model.thinking[await choose(p, `Thinking for ${modelName(model.selector)}`, levels, t)]);
}

async function changeSetup(p, models, s, mark) {
  const impl = await pickModel(p, models, bold("Main model") + dim(" (writes the code; also your everyday OMP model)"), s.impl, "high", { mark });
  const cheapest = cheapestReasoning(models, parseRole(models, impl).model.provider);
  const fast = await pickModel(p, models, bold("Cheap model") + dim(" (used for quick searches)"), s.fast, "low", { first: "same as main", mark, cheapest });
  const advisor = await pickModel(p, models, bold("Advisor") + dim(" (watches the coder)"), s.advisor, "medium", { first: "off", mark });
  let advisorCritical = null;
  if (advisor) {
    const same = s.advisor && s.advisorCritical && parseRole(models, s.advisor).model === parseRole(models, advisor).model;
    const suggested = same ? s.advisorCritical : withThinking(models, advisor, "high");
    advisorCritical = await pickModel(p, models, bold("Advisor for critical work"), suggested, "high", { mark: same ? mark : "suggested" });
  }
  const review = await pickModel(p, models, bold("Reviewers") + dim(" (a different provider than the main model reviews better)"), s.review, "high", { mark });
  const yolo = await yesNo(p, "Auto-approve every command? (yes = runs commands that change things without asking)", s.approval === "yolo");
  const approval = yolo ? "yolo" : s.approval === "always-ask" ? "always-ask" : "write";
  return { impl, fast, advisor, advisorCritical, review, approval };
}

export async function askChoices(p, models, d) {
  let choices = choicesOf(d);
  let header = d.installed ? "Current setup" : "Suggested setup";
  let mark = d.installed ? "current" : "suggested";
  let question = "Use this setup? [Y/n/c=change] ";
  for (;;) {
    p.say(`${setupTable(header, choices)}\n`);
    const answer = await yesNoChange(p, question);
    if (answer === "y") return choices;
    if (answer === "n") return null;
    choices = await changeSetup(p, models, choices, mark);
    p.say("");
    header = "Your setup";
    mark = "your choice";
    question = "Use this setup? [Y/n/c] ";
  }
}

function findDrift(doc, manifest, desired) {
  const prev = manifest?.config?.keys ?? {};
  return Object.entries(prev).flatMap(([key, e]) => {
    const cur = getValue(doc, key);
    if (equal(cur, { value: e.ours })) return [];
    const next = key in desired ? { value: desired[key] } : e.prior;
    return equal(cur, next) ? [] : [{ key, cur, ours: e.ours, next }];
  });
}

const show = (v) => (v.absent ? "(absent)" : JSON.stringify(v.value));

export function buildPlan(ctx, inspected, manifest, choices, keep) {
  const { texts, docs } = inspected;
  const lines = [];
  const changedKeys = [];
  const kept = [];
  const doc = docs.config;
  const desired = desiredKeys(choices);
  const prevKeys = manifest?.config?.keys ?? {};
  const createdMaps = [...(manifest?.config?.createdMaps ?? [])];
  const keys = {};
  const expect = {};
  let mutated = false;
  for (const [key, ours] of Object.entries(desired)) {
    const prev = prevKeys[key];
    if (keep.has(key)) {
      keys[key] = prev;
      lines.push(`  keep ${key} = ${show(getValue(doc, key))} (changed by you)`);
      kept.push(changedSetting(key, getValue(doc, key), ctx.files.config, KEPT));
      continue;
    }
    const cur = getValue(doc, key);
    keys[key] = { prior: prev ? prev.prior : cur, ours };
    expect[key] = ours;
    if (!equal(cur, { value: ours })) {
      setValue(doc, key, ours, createdMaps);
      mutated = true;
      lines.push(`  set ${key}: ${show(cur)} -> ${JSON.stringify(ours)}`);
      changedKeys.push(key);
    }
  }
  for (const [key, prev] of Object.entries(prevKeys)) {
    if (key in desired || keep.has(key)) continue;
    const cur = getValue(doc, key);
    if (!equal(cur, prev.prior)) {
      restoreValue(doc, key, prev.prior, createdMaps);
      mutated = true;
      lines.push(`  restore ${key}: ${show(cur)} -> ${show(prev.prior)}`);
      changedKeys.push(key);
    }
  }
  const prevPatterns = manifest?.config?.patterns ?? null;
  const unchanged = prevPatterns?.before && prevPatterns.after && patternsEqual(doc, prevPatterns.after);
  const baseline = unchanged ? { before: prevPatterns.before, owned: prevPatterns.inserted, notes: [] } : { owned: [], ...detachOwnedPatterns(doc, prevPatterns?.inserted ?? []) };
  if (baseline.changed) mutated = true;
  const added = insertPatterns(doc, ourPatterns(ctx), createdMaps);
  const patterns = {
    inserted: [...baseline.owned, ...added.inserted],
    createdKey: baseline.before.absent === true,
    before: baseline.before,
    after: patternList(doc),
  };
  if (added.inserted.length) lines.push(`  bash.patterns: insert ${added.inserted.length} entries (deny rules first, allow rules last)`);
  const next = { config: mutated || added.inserted.length ? stringifyYaml(doc) : texts.config ?? "" };

  const blocks = {};
  for (const [kind, body] of [["agents", AGENTS_BODY], ["watchdogMd", WATCHDOG_BODY]]) {
    const r = upsertBlock(texts[kind] ?? "", body, ctx.files[kind]);
    blocks[kind] = manifest?.blocks?.[kind] ?? { sep: r.sep, prior: r.prior };
    next[kind] = r.text;
  }
  const entry = watchdogEntry(ctx);
  const wdoc = docs.watchdogYml;
  let watchdogYml = manifest?.watchdogYml ?? { claimed: false, createdKey: false };
  next.watchdogYml = texts.watchdogYml ?? "";
  if (!checkWatchdog(wdoc, entry, ctx.files.watchdogYml)) {
    const r = addWatchdog(wdoc, entry);
    watchdogYml = { claimed: true, createdKey: watchdogYml.createdKey || r.createdKey };
    next.watchdogYml = stringifyYaml(wdoc);
  }

  const files = KINDS.filter((k) => next[k] !== (texts[k] ?? "")).map((kind) => ({
    kind, path: ctx.files[kind], before: texts[kind], after: next[kind],
  }));
  const now = new Date().toISOString();
  const createdDirs = [...new Set([...(manifest?.createdDirs ?? []), ...inspected.dirs])];
  const nextManifest = {
    tool: "super-nemo",
    version: 1,
    status: "installed",
    repo: ctx.repo,
    agentDir: ctx.agentDir,
    snHome: ctx.snHome,
    installedAt: manifest?.installedAt ?? now,
    installedCommit: tryGit(ctx.repo, ["rev-parse", "HEAD"]),
    updatedAt: now,
    createdHome: manifest ? manifest.createdHome : !lstat(ctx.snHome) || (ctx.bootstrap.createdHome && ctx.repo === ctx.cloneDir),
    clone: manifest ? manifest.clone : bootstrapClone(ctx),
    choices,
    createdDirs,
    symlinks: [...ctx.symlinks.map((s) => s.path), ...inspected.keptLinks],
    files: { ...(manifest?.files ?? {}) },
    config: { keys, createdMaps, patterns },
    blocks,
    watchdogYml,
  };
  const choicesChanged = !equal(manifest?.choices, choices);
  return {
    ts: timestamp(),
    dirs: inspected.dirs,
    symlinks: inspected.symlinks,
    staleLinks: inspected.staleLinks,
    files,
    configLines: lines,
    changedKeys,
    patternsAdded: added.inserted,
    fresh: !manifest,
    notes: [...inspected.notes, ...baseline.notes, ...kept],
    expect,
    manifest: nextManifest,
    empty: !files.length && !inspected.symlinks.length && !inspected.dirs.length && !inspected.staleLinks.length && !choicesChanged
      && manifest?.repo === ctx.repo && equal(prevPatterns, patterns) && equal(manifest.symlinks, nextManifest.symlinks)
      && manifest.installedCommit === nextManifest.installedCommit,
  };
}

function bootstrapClone(ctx) {
  if (!ctx.bootstrap.clone || ctx.repo !== ctx.cloneDir) return null;
  const origin = originUrl(ctx.repo);
  return origin ? { path: ctx.repo, createdByBootstrap: true, origin } : null;
}

export function describePlan(ctx, plan) {
  const out = [`Agent dir:       ${ctx.agentDir}`, `SUPER-NEMO home: ${ctx.snHome}`, `Repo:            ${ctx.repo}`];
  const c = plan.manifest.choices;
  out.push("Roles:", `  default           ${c.impl}`, `  nemo-fast         ${c.fast ?? "(not used; scout/sonic use @default)"}`,
    `  advisor           ${c.advisor ?? "off"}`, `  advisor-critical  ${c.advisorCritical ?? "off"}`,
    `  nemo-review       ${c.review}`, `  tools.approvalMode ${c.approval}`);
  if (plan.empty) return out.join("\n");
  for (const d of plan.dirs) out.push(`mkdir ${d}`);
  for (const s of plan.staleLinks) out.push(`unlink ${s.path} (no longer shipped)`);
  for (const s of plan.symlinks) out.push(`link ${s.path} -> ${s.target}`);
  for (const f of plan.files) {
    out.push(`${f.before === null ? "create" : "update"} ${f.path}${f.before !== null ? ` (backup in ${ctx.backupsDir}/${plan.ts}/)` : ""}`);
    if (f.kind === "config") out.push(...plan.configLines);
  }
  out.push(`write ${ctx.manifestPath}`);
  return out.join("\n");
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function linkCount(ctx, links) {
  const n = (dir) => links.filter((s) => path.dirname(s.path) === path.join(ctx.agentDir, dir)).length;
  return [[n("agents"), "agent"], [n("skills"), "skill"]].filter(([k]) => k).map(([k, w]) => plural(k, w)).join(" and ");
}

const CONFIG_GROUPS = [
  ["model roles", (k) => /^(modelRoles|task\.agentModelOverrides|task\.agentAdvisor)\./.test(k)],
  ["tool approval", (k) => k.startsWith("tools.")],
  ["task settings", (k) => k.startsWith("task.") || k.startsWith("advisor.")],
];

function configParts(plan) {
  const group = (k) => CONFIG_GROUPS.find(([, test]) => test(k))?.[0] ?? "other settings";
  const groups = new Set(plan.changedKeys.map(group));
  const deny = plan.patternsAdded.filter((e) => e.approval === "deny").length;
  const allow = plan.patternsAdded.length - deny;
  return [
    ...(groups.has("model roles") ? ["model roles"] : []),
    ...(deny ? [plural(deny, "blocked command")] : []),
    ...(allow ? [plural(allow, "allowed git command")] : []),
    ...[...groups].filter((g) => g !== "model roles"),
  ];
}

function fileLines(plan) {
  const out = [];
  const guidance = [];
  for (const f of plan.files) {
    const file = tilde(f.path);
    if (f.kind === "config") {
      const parts = configParts(plan);
      out.push(`${f.before === null ? "create" : "update"} ${file}${parts.length ? `: ${parts.join(", ")}` : ""}`);
    } else if (f.kind === "agents") {
      if (f.before === null) out.push(`create ${file} with the SUPER-NEMO block`);
      else out.push(f.before.includes(BEGIN) ? `update the SUPER-NEMO block in ${file}` : `add the SUPER-NEMO block to ${file}`);
    } else guidance.push(path.basename(f.path));
  }
  if (guidance.length) out.push(`${plan.fresh ? "add" : "update"} advisor guidance (${guidance.join(" / ")})`);
  return out;
}

export function summarizePlan(ctx, plan) {
  const notes = plan.notes.map((n) => `  ${warn(n)}`);
  if (plan.empty) return ["Nothing to change: already installed with these choices.", ...notes].join("\n");
  const items = [];
  const added = linkCount(ctx, plan.symlinks);
  if (added) items.push(`add ${added} to OMP (linked to ${tilde(ctx.repo)}, so updates are instant)`);
  const removed = linkCount(ctx, plan.staleLinks);
  if (removed) items.push(`remove ${removed} no longer shipped`);
  items.push(...fileLines(plan));
  if (!items.length) items.push("record the installation");
  const out = ["This will", ...items.map((i) => `  ${bullet(i)}`)];
  if (plan.files.some((f) => f.before !== null)) out.push(`  Backups of changed files: ${tilde(path.join(ctx.backupsDir, plan.ts))}`);
  out.push(...notes);
  return out.join("\n");
}

function validatePersisted(ctx, plan) {
  const hashes = {};
  for (const f of plan.files) {
    const text = readRegularFile(f.path);
    if (text !== f.after) throw new SnError(`${f.path} does not contain what was written`);
    hashes[f.kind] = sha256(text);
  }
  const doc = parseYaml(readRegularFile(ctx.files.config) ?? "", ctx.files.config);
  for (const [key, value] of Object.entries(plan.expect)) {
    if (!equal(getValue(doc, key), { value })) throw new SnError(`${ctx.files.config}: ${key} did not persist`);
  }
  return hashes;
}

function fileSteps(plan) {
  const step = (files, doing, done) => ({ files, doing, done });
  const created = (files) => files.every((f) => f.before === null);
  const of = (kinds) => plan.files.filter((f) => kinds.includes(f.kind));
  const config = of(["config"]);
  const agents = of(["agents"]);
  const guidance = of(["watchdogMd", "watchdogYml"]);
  return [
    created(config) ? step(config, "Creating OMP config", "Created OMP config") : step(config, "Updating OMP config", "Updated OMP config"),
    created(agents) ? step(agents, "Creating AGENTS.md", "Created AGENTS.md") : step(agents, "Updating AGENTS.md", "Updated AGENTS.md"),
    plan.fresh ? step(guidance, "Adding advisor guidance", "Added advisor guidance") : step(guidance, "Updating advisor guidance", "Updated advisor guidance"),
  ].filter((g) => g.files.length);
}

function apply(ctx, plan, prev, log) {
  const createdHome = !lstat(ctx.snHome);
  const createdState = !lstat(ctx.state);
  const txnDir = path.join(ctx.backupsDir, plan.ts);
  const txnFiles = plan.files.map((f) => ({
    kind: f.kind,
    path: f.path,
    existed: f.before !== null,
    backup: f.before === null ? null : backupRel(plan.ts, f.path),
    backupHash: null,
    afterHash: sha256(f.after),
  }));
  const pending = {
    ...plan.manifest,
    status: "pending",
    txn: {
      backupDir: path.posix.join("backups", plan.ts),
      files: txnFiles,
      symlinks: plan.symlinks.map((s) => ({ path: s.path })),
      removedLinks: plan.staleLinks.map((s) => ({ path: s.path })),
      dirs: plan.dirs,
      previous: prev ?? null,
    },
  };
  const copied = [];
  try {
    fs.mkdirSync(ctx.snHome, { recursive: true });
    if (createdState) fs.mkdirSync(ctx.state, { mode: 0o700 });
    if (!lstat(ctx.backupsDir)) fs.mkdirSync(ctx.backupsDir, { mode: 0o700 });
    fs.mkdirSync(txnDir, { recursive: true, mode: 0o700 });
    for (const f of txnFiles.filter((x) => x.backup)) {
      const dest = path.join(ctx.state, f.backup);
      const data = fs.readFileSync(f.path);
      fs.writeFileSync(dest, data, { mode: 0o600, flag: "wx" });
      copied.push(dest);
      f.backupHash = sha256(data);
    }
    saveManifest(ctx, pending);
  } catch (err) {
    for (const p of copied) fs.rmSync(p, { force: true });
    for (const d of [txnDir, ctx.backupsDir, createdState && ctx.state, createdHome && ctx.snHome]) if (d) rmdirIfEmpty(d);
    throw new SnError(`could not prepare backups, nothing was changed: ${err.message}`);
  }
  let final;
  let step = "Linking agents and skills";
  try {
    for (const s of plan.staleLinks) if (isStaleLink(ctx, s.path)) fs.unlinkSync(s.path);
    for (const d of plan.dirs) fs.mkdirSync(d);
    for (const s of plan.symlinks) fs.symlinkSync(s.target, s.path);
    if (plan.symlinks.length || plan.staleLinks.length) log(ok("Linked agents and skills"));
    for (const group of fileSteps(plan)) {
      step = group.doing;
      for (const f of group.files) writeIfUnchanged(f.path, f.before, f.after);
      log(ok(group.done));
    }
    step = "Saving the installation record";
    const hashes = validatePersisted(ctx, plan);
    final = { ...plan.manifest };
    for (const f of txnFiles) {
      const old = prev?.files?.[f.kind];
      const oldHash = f.existed ? sha256(plan.files.find((x) => x.kind === f.kind).before) : null;
      const reuse = old?.backup && old.postHash === oldHash && old.path === f.path;
      const backup = old ? (reuse ? { backup: old.backup, backupHash: old.backupHash } : { backup: null, backupHash: null })
        : { backup: f.backup, backupHash: f.backupHash };
      final.files[f.kind] = { path: f.path, created: old ? old.created : !f.existed, ...backup, postHash: hashes[f.kind] };
    }
    saveManifest(ctx, final);
  } catch (err) {
    log(fail(`${step}: ${err.message}`));
    log("Rolling back.");
    try {
      rollback(ctx, pending, (m, s) => log(noteLine(m, s)));
    } catch (rollbackErr) {
      throw new SnError(`install failed (${err.message}) and the automatic rollback did not finish: ${rollbackErr.message}`);
    }
    throw new SnError(`install failed and was rolled back: ${err.message}`);
  }
  const keep = new Set(Object.values(final.files).map((f) => f.backup).filter(Boolean));
  const stale = [...txnFiles.map((f) => f.backup), ...Object.values(prev?.files ?? {}).map((f) => f.backup)];
  for (const rel of stale) {
    const abs = rel && !keep.has(rel) ? backupPath(ctx, rel) : null;
    if (abs) {
      fs.unlinkSync(abs);
      rmdirIfEmpty(path.dirname(abs));
    }
  }
  rmdirIfEmpty(txnDir);
}

function reuseFlags(choices, opts) {
  const c = choices && typeof choices === "object" ? choices : {};
  const flags = { ...opts };
  const take = (flag, key, none) => {
    if (flags[flag] !== undefined || !Object.hasOwn(c, key)) return;
    if (c[key] === null && none) flags[flag] = none;
    else if (typeof c[key] === "string") flags[flag] = c[key];
  };
  take("impl", "impl");
  take("fast", "fast", "none");
  take("advisor", "advisor", "off");
  if (flags.advisor !== "off") take("advisor-critical", "advisorCritical");
  take("review", "review");
  take("approval", "approval");
  return flags;
}

export async function install(ctx, opts, log = console.log) {
  const interactive = !opts.yes && !opts.reuse;
  if (interactive && !(process.stdin.isTTY && process.stdout.isTTY)) {
    throw new SnError("no terminal for questions; re-run with --yes and flags (see --help)", 2);
  }
  await preflightTools(ctx);
  const manifest = openManifest(ctx, log, opts["dry-run"], (m, s) => log(noteLine(m, s)));
  if (opts.reuse && !manifest) throw new SnError("--reuse needs an existing installation, but SUPER-NEMO is not installed", 2);
  const inspected = inspect(ctx, manifest);
  if (inspected.problems.length) {
    throw new SnError(`Install aborted, nothing was written:\n${inspected.problems.map((p) => `  - ${p}`).join("\n")}`);
  }
  const models = await loadModels(ctx);
  const defaults = computeDefaults(models, inspected.docs.config, manifest, opts.reuse ? reuseFlags(manifest.choices, opts) : opts);
  if (!opts.reuse) log(`${bold("SUPER-NEMO setup")}\nFound models for: ${[...new Set(models.map((m) => m.provider))].join(", ")}\n`);
  const prompter = interactive ? ttyPrompter() : null;
  try {
    const choices = interactive ? await askChoices(prompter, models, defaults) : choicesOf(defaults);
    if (!choices) {
      log("Nothing was changed.");
      return 1;
    }
    if (!interactive && !opts.reuse) log(`${setupTable("Setup", choices)}\n`);
    const drift = findDrift(inspected.docs.config, manifest, desiredKeys(choices));
    const keep = new Set();
    if (drift.length && !opts["overwrite-drift"]) {
      if (!interactive) {
        const lines = drift.map((d) => `  ${warn(changedSetting(d.key, d.cur, ctx.files.config))}`);
        throw new SnError(`These settings were changed since the last install:\n${lines.join("\n")}\nRe-run with --overwrite-drift to replace them, or without --yes to choose for each one.`, 3);
      }
      for (const d of drift) {
        const question = changedSetting(d.key, d.cur, ctx.files.config, ` since install; replace it with ${settingValue(d.key, d.next)}?`);
        if (!(await yesNo(prompter, question, false))) keep.add(d.key);
      }
    }
    const plan = buildPlan(ctx, inspected, manifest, choices, keep);
    if (opts.verbose) log(`${describePlan(ctx, plan)}\n`);
    log(summarizePlan(ctx, plan));
    if (opts["dry-run"]) {
      log(`\nDry run: nothing was written.${opts.verbose ? "" : " Add --verbose for every file and setting."}`);
      return 0;
    }
    if (!plan.empty && interactive && !(await yesNo(prompter, "Apply?", true))) {
      log("Nothing was changed.");
      return 1;
    }
    log("");
    if (!plan.empty) {
      apply(ctx, plan, manifest, log);
      if (prompter) prompter.afterCancel = "SUPER-NEMO is installed.";
    }
    const sn = tilde(path.join(ctx.repo, "sn"));
    if (!(await verify(ctx, { label: "Checked installation" }, log))) {
      log(`Fix the problems above, then run: ${sn} verify`);
      return 1;
    }
    const smoke = interactive
      ? await yesNo(prompter, "Run a quick live test? OMP does two tiny tasks in a throwaway folder to prove the agents work (~3-4 min, uses model quota).", false)
      : !opts["no-smoke"];
    if (smoke && !smokeTest(ctx, log)) {
      log(`Try it again: ${sn} verify --smoke`);
      return 1;
    }
    if (opts.reuse) {
      log(ok("SUPER-NEMO is installed."));
      return 0;
    }
    if (!smoke) log(`Test it later: ${sn} verify --smoke`);
    log([
      "",
      ok("SUPER-NEMO is installed."),
      "  Next: open a NEW omp session in a repo and ask it to change some code.",
      `  Update:    ${sn} update`,
      `  Uninstall: ${sn} uninstall`,
    ].join("\n"));
    return 0;
  } finally {
    prompter?.close();
  }
}
