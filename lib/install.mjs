import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { KINDS, MANAGED_KEYS, desiredKeys, ourPatterns, runOmp, watchdogEntry } from "./context.mjs";
import { originUrl, tryGit } from "./git.mjs";
import { backupPath, isStaleLink, saveManifest, staleLinkSpec, symlinkSpec } from "./manifest.mjs";
import {
  AGENTS_BODY, WATCHDOG_BODY, addWatchdog, checkBlock, checkMapPath, checkPatterns, checkWatchdog, equal, getValue, insertPatterns,
  detachOwnedPatterns, parseYaml, patternList, patternsEqual, restoreValue, setValue, stringifyYaml, upsertBlock,
} from "./merge.mjs";
import { cheapestReasoning, formatRole, loadModels, parseRole, pickThinking, roleFromFlag, strongest } from "./models.mjs";
import { choose, ttyPrompter, yesNo } from "./prompts.mjs";
import { backupRel, openManifest, rollback, timestamp } from "./transaction.mjs";
import { SnError, isDirectory, lstat, missingDirs, readLink, readRegularFile, rmdirIfEmpty, sha256, writeIfUnchanged } from "./util.mjs";
import { verify } from "./verify.mjs";

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
  const cheap = cheapestReasoning(models, implModel.provider);
  const fastSuggestion = formatRole(cheap, pickThinking(cheap, "low"));
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
  return { impl, fast, fastSuggestion, advisor, advisorSuggestion, advisorCritical: advisor ? advisorCritical : null, review, approval };
}

async function chooseRole(p, models, title, def, preferredThinking) {
  const current = parseRole(models, def);
  const providers = [...new Set(models.map((m) => m.provider))];
  const pi = await choose(p, `${title} — provider:`, providers, Math.max(0, providers.indexOf(current.model.provider)));
  const list = models.filter((m) => m.provider === providers[pi]);
  const model = list[await choose(p, `${title} — model:`, list.map((m) => m.selector), Math.max(0, list.indexOf(current.model)))];
  if (!model.thinking) return model.selector;
  const want = model === current.model && current.thinking ? current.thinking : pickThinking(model, preferredThinking);
  return formatRole(model, model.thinking[await choose(p, `${title} — thinking:`, model.thinking, model.thinking.indexOf(want))]);
}

export async function askChoices(p, models, d) {
  const impl = await chooseRole(p, models, "Implementation/main model (modelRoles.default, also your everyday OMP model)", d.impl, "high");
  let fast = null;
  if (await yesNo(p, "Use a cheaper model for scout/sonic?", Boolean(d.fast))) {
    fast = await chooseRole(p, models, "Fast model (modelRoles.nemo-fast)", d.fast ?? d.fastSuggestion, "low");
  }
  let advisor = null;
  let advisorCritical = null;
  if (await yesNo(p, "Enable the advisor for NORMAL work?", Boolean(d.advisor))) {
    advisor = await chooseRole(p, models, "Advisor NORMAL (modelRoles.advisor)", d.advisorSuggestion, "medium");
    advisorCritical = await chooseRole(p, models, "Advisor CRITICAL (modelRoles.advisor-critical)", d.advisorCritical ?? advisor, "high");
  }
  const review = await chooseRole(p, models, "Review model (modelRoles.nemo-review)", d.review, "high");
  const yolo = await yesNo(p, "Auto-approve all tool calls (yolo)?", d.approval === "yolo");
  const approval = yolo ? "yolo" : d.approval === "always-ask" ? "always-ask" : "write";
  return { impl, fast, advisor, advisorCritical, review, approval };
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
      continue;
    }
    const cur = getValue(doc, key);
    keys[key] = { prior: prev ? prev.prior : cur, ours };
    expect[key] = ours;
    if (!equal(cur, { value: ours })) {
      setValue(doc, key, ours, createdMaps);
      mutated = true;
      lines.push(`  set ${key}: ${show(cur)} -> ${JSON.stringify(ours)}`);
    }
  }
  for (const [key, prev] of Object.entries(prevKeys)) {
    if (key in desired || keep.has(key)) continue;
    const cur = getValue(doc, key);
    if (!equal(cur, prev.prior)) {
      restoreValue(doc, key, prev.prior, createdMaps);
      mutated = true;
      lines.push(`  restore ${key}: ${show(cur)} -> ${show(prev.prior)}`);
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
    notes: [...inspected.notes, ...baseline.notes],
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
  const notes = plan.notes.map((n) => `note: ${n}`);
  if (plan.empty) return [...out, ...notes, "Nothing to change: already installed with these choices."].join("\n");
  for (const d of plan.dirs) out.push(`mkdir ${d}`);
  for (const s of plan.staleLinks) out.push(`unlink ${s.path} (no longer shipped)`);
  for (const s of plan.symlinks) out.push(`link ${s.path} -> ${s.target}`);
  for (const f of plan.files) {
    out.push(`${f.before === null ? "create" : "update"} ${f.path}${f.before !== null ? ` (backup in ${ctx.backupsDir}/${plan.ts}/)` : ""}`);
    if (f.kind === "config") out.push(...plan.configLines);
  }
  out.push(`write ${ctx.manifestPath}`, ...notes);
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
  try {
    for (const s of plan.staleLinks) if (isStaleLink(ctx, s.path)) fs.unlinkSync(s.path);
    for (const d of plan.dirs) fs.mkdirSync(d);
    for (const s of plan.symlinks) fs.symlinkSync(s.target, s.path);
    for (const f of plan.files) writeIfUnchanged(f.path, f.before, f.after);
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
    log(`Install failed: ${err.message}. Rolling back.`);
    try {
      rollback(ctx, pending, log);
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
  const manifest = openManifest(ctx, log, opts["dry-run"]);
  if (opts.reuse && !manifest) throw new SnError("--reuse needs an existing installation, but SUPER-NEMO is not installed", 2);
  const inspected = inspect(ctx, manifest);
  if (inspected.problems.length) {
    throw new SnError(`Install aborted, nothing was written:\n${inspected.problems.map((p) => `  - ${p}`).join("\n")}`);
  }
  const models = await loadModels(ctx);
  const defaults = computeDefaults(models, inspected.docs.config, manifest, opts.reuse ? reuseFlags(manifest.choices, opts) : opts);
  const prompter = interactive ? ttyPrompter() : null;
  try {
    const choices = interactive ? await askChoices(prompter, models, defaults) : {
      impl: defaults.impl, fast: defaults.fast, advisor: defaults.advisor,
      advisorCritical: defaults.advisorCritical, review: defaults.review, approval: defaults.approval,
    };
    const drift = findDrift(inspected.docs.config, manifest, desiredKeys(choices));
    const keep = new Set();
    if (drift.length && !opts["overwrite-drift"]) {
      if (!interactive) {
        throw new SnError(`These settings were changed since the last install:\n${drift.map((d) => `  - ${d.key} = ${show(d.cur)} (installed ${JSON.stringify(d.ours)})`).join("\n")}\nRe-run with --overwrite-drift to replace them, or interactively to choose per key.`, 3);
      }
      for (const d of drift) {
        if (!(await yesNo(prompter, `${d.key} is now ${show(d.cur)} (installed ${JSON.stringify(d.ours)}). Replace with ${show(d.next)}?`, false))) keep.add(d.key);
      }
    }
    const plan = buildPlan(ctx, inspected, manifest, choices, keep);
    log(describePlan(ctx, plan));
    if (opts["dry-run"]) return 0;
    if (interactive && !(await yesNo(prompter, "Apply this plan?", false))) {
      log("Nothing was changed.");
      return 1;
    }
    const smoke = interactive
      ? await yesNo(prompter, "Run smoke evals light + normal now? Uses real model calls, roughly $2 and 5 minutes (see README).", true)
      : !opts["no-smoke"];
    if (!plan.empty) {
      apply(ctx, plan, manifest, log);
      log("Installed.");
    }
    return (await verify(ctx, { smoke }, log)) ? 0 : 1;
  } finally {
    prompter?.close();
  }
}
