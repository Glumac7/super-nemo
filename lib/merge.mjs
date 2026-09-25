import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";
import { SnError } from "./util.mjs";

export const BEGIN = "<!-- super-nemo:begin -->";
export const END = "<!-- super-nemo:end -->";
export const AGENTS_BODY = "@~/.super-nemo/current/blocks/AGENTS.md";
export const WATCHDOG_BODY = "@~/.super-nemo/current/watchdog/WATCHDOG.md";
export const ABSENT = Object.freeze({ absent: true });
export const equal = isDeepStrictEqual;

export function parseYaml(text, file) {
  const doc = YAML.parseDocument(text ?? "");
  if (doc.errors.length) throw new SnError(`${file}: invalid YAML: ${doc.errors[0].message.split("\n")[0]}`);
  if (doc.contents !== null && !YAML.isMap(doc.contents)) throw new SnError(`${file}: top level is not a mapping`);
  return doc;
}

export const stringifyYaml = (doc) => (doc.contents === null ? "" : doc.toString({ lineWidth: 0 }));

export function isEmptyText(text, yaml) {
  const t = text.trim();
  return t === "" || (yaml && t === "{}");
}

const split = (key) => (Array.isArray(key) ? key : key.split("."));

export function getValue(doc, key) {
  const node = doc.getIn(split(key), true);
  if (node === undefined) return ABSENT;
  return { value: YAML.isNode(node) ? node.toJS(doc) : node };
}

export function checkMapPath(doc, key, file) {
  const parts = split(key);
  for (let i = 1; i < parts.length; i++) {
    const node = doc.getIn(parts.slice(0, i), true);
    if (node === undefined) return;
    if (!YAML.isMap(node)) throw new SnError(`${file}: ${parts.slice(0, i).join(".")} is not a mapping`);
  }
}

function valueNode(doc, value) {
  const node = doc.createNode(value);
  if (YAML.isScalar(node) && typeof value === "string") node.type = YAML.Scalar.QUOTE_DOUBLE;
  return node;
}

export function setValue(doc, key, value, createdMaps) {
  const parts = split(key);
  for (let i = 1; i < parts.length; i++) {
    const prefix = parts.slice(0, i).join(".");
    if (doc.getIn(parts.slice(0, i), true) === undefined && !createdMaps.includes(prefix)) createdMaps.push(prefix);
  }
  const existing = doc.getIn(parts, true);
  if (YAML.isScalar(existing) && (value === null || typeof value !== "object")) {
    existing.value = value;
    existing.type = typeof value === "string" ? YAML.Scalar.QUOTE_DOUBLE : undefined;
  } else {
    doc.setIn(parts, valueNode(doc, value));
  }
}

export function deleteValue(doc, key, createdMaps) {
  const parts = split(key);
  doc.deleteIn(parts);
  for (let i = parts.length - 1; i >= 1; i--) {
    const prefix = parts.slice(0, i).join(".");
    const node = doc.getIn(parts.slice(0, i), true);
    if (!createdMaps.includes(prefix) || !YAML.isMap(node) || node.items.length) break;
    doc.deleteIn(parts.slice(0, i));
    createdMaps.splice(createdMaps.indexOf(prefix), 1);
  }
}

export function restoreValue(doc, key, prior, createdMaps) {
  if (prior.absent) deleteValue(doc, key, createdMaps);
  else setValue(doc, key, prior.value, createdMaps);
}

const PATTERNS = ["bash", "patterns"];

export function checkPatterns(doc, file) {
  checkMapPath(doc, PATTERNS, file);
  const node = doc.getIn(PATTERNS, true);
  if (node !== undefined && !YAML.isSeq(node)) throw new SnError(`${file}: bash.patterns is not a list`);
}

export function patternList(doc) {
  const node = doc.getIn(PATTERNS, true);
  return YAML.isSeq(node) ? node.toJS(doc) : [];
}

export function shadowedBy(list, entry) {
  const i = list.findIndex((x) => equal(x, entry));
  if (i === -1) return undefined;
  return list.slice(0, i).find((x) => x?.approval !== "deny") ?? null;
}

export function insertPatterns(doc, entries, createdMaps) {
  const existing = patternList(doc);
  const head = entries.filter((e) => e.approval === "deny" && shadowedBy(existing, e) !== null);
  const tail = entries.filter((e) => e.approval !== "deny" && !existing.some((x) => equal(x, e)));
  if (!head.length && !tail.length) return { inserted: [], createdKey: false };
  const node = doc.getIn(PATTERNS, true);
  if (node === undefined) {
    setValue(doc, PATTERNS, [...head, ...tail], createdMaps);
    return { inserted: [...head, ...tail], createdKey: true };
  }
  node.items.splice(0, 0, ...head.map((e) => doc.createNode(e)));
  node.items.push(...tail.map((e) => doc.createNode(e)));
  return { inserted: [...head, ...tail], createdKey: false };
}

export function removePatterns(doc, entries, createdKey, createdMaps) {
  const node = doc.getIn(PATTERNS, true);
  if (!YAML.isSeq(node)) return { changed: false, notes: entries.length ? ["bash.patterns is gone; nothing to remove"] : [] };
  const list = node.toJS(doc);
  const taken = new Set();
  const notes = [];
  for (const entry of entries) {
    const hits = list.flatMap((x, i) => (!taken.has(i) && equal(x, entry) ? [i] : []));
    if (!hits.length) notes.push(`bash.patterns: ${JSON.stringify(entry)} already gone`);
    else taken.add(entry.approval === "deny" ? hits[0] : hits.at(-1));
  }
  for (const i of [...taken].sort((a, b) => b - a)) node.items.splice(i, 1);
  let changed = taken.size > 0;
  if (createdKey && node.items.length === 0) {
    deleteValue(doc, PATTERNS, createdMaps);
    changed = true;
  }
  return { changed, notes };
}

function blockRange(text, file) {
  const begins = [];
  const ends = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t === BEGIN) begins.push(offset);
    else if (t === END) ends.push(offset + line.length);
    offset += line.length + 1;
  }
  if (!begins.length && !ends.length) return null;
  if (begins.length !== 1 || ends.length !== 1 || ends[0] < begins[0]) {
    throw new SnError(`${file}: malformed super-nemo markers (need exactly one begin/end pair, in order); fix or remove them`);
  }
  return { start: begins[0], end: text[ends[0]] === "\n" ? ends[0] + 1 : ends[0] };
}

export const checkBlock = (text, file) => void blockRange(text, file);

export function upsertBlock(text, body, file) {
  const block = `${BEGIN}\n${body}\n${END}\n`;
  const range = blockRange(text, file);
  if (range) {
    return { text: text.slice(0, range.start) + block + text.slice(range.end), sep: null, prior: text.slice(range.start, range.end) };
  }
  const sep = text === "" ? "" : text.endsWith("\n") ? "\n" : "\n\n";
  return { text: text + sep + block, sep, prior: null };
}

export function removeBlock(text, { sep, prior }, file) {
  const range = blockRange(text, file);
  if (!range) return { text, removed: false };
  if (prior !== null && prior !== undefined) {
    return { text: text.slice(0, range.start) + prior + text.slice(range.end), removed: true };
  }
  let before = text.slice(0, range.start);
  if (sep && before.endsWith("\n\n")) before = before.slice(0, -sep.length);
  return { text: before + text.slice(range.end), removed: true };
}

const ADVISORS = ["advisors"];

function advisorMatches(doc, name) {
  const node = doc.getIn(ADVISORS, true);
  if (!YAML.isSeq(node)) return [];
  return node.items.flatMap((item, i) => {
    const js = YAML.isNode(item) ? item.toJS(doc) : item;
    return js && typeof js === "object" && js.name === name ? [{ i, js }] : [];
  });
}

export function checkWatchdog(doc, entry, file) {
  const node = doc.getIn(ADVISORS, true);
  if (node !== undefined && !YAML.isSeq(node)) throw new SnError(`${file}: advisors is not a list`);
  const matches = advisorMatches(doc, entry.name);
  if (matches.length > 1 || (matches.length === 1 && !equal(matches[0].js, entry))) {
    throw new SnError(`${file}: an advisor named ${entry.name} already exists and differs from ours; remove or rename it`);
  }
  return matches.length === 1;
}

export function addWatchdog(doc, entry) {
  const node = doc.createNode(entry);
  const tools = node.get("tools", true);
  if (YAML.isSeq(tools)) tools.flow = true;
  if (doc.getIn(ADVISORS, true) === undefined) {
    doc.setIn(ADVISORS, doc.createNode([]));
    doc.getIn(ADVISORS, true).items.push(node);
    return { createdKey: true };
  }
  doc.getIn(ADVISORS, true).items.push(node);
  return { createdKey: false };
}

export function removeWatchdog(doc, entry, createdKey) {
  const matches = advisorMatches(doc, entry.name).filter((m) => equal(m.js, entry));
  if (matches.length !== 1) {
    return matches.length ? `advisors: ${matches.length} identical ${entry.name} entries; kept all (ambiguous)` : `advisors: ${entry.name} entry already gone or edited; left as is`;
  }
  const node = doc.getIn(ADVISORS, true);
  node.items.splice(matches[0].i, 1);
  if (createdKey && node.items.length === 0) doc.deleteIn(ADVISORS);
  return null;
}

const show = (v) => (v.absent ? "(absent)" : JSON.stringify(v.value));

export function unmerge(manifest, kind, text, file, report, watchdog) {
  if (kind === "config") {
    const doc = parseYaml(text, file);
    const createdMaps = [...(manifest.config.createdMaps ?? [])];
    let changed = 0;
    for (const [key, e] of Object.entries(manifest.config.keys)) {
      const cur = getValue(doc, key);
      if (equal(cur, e.prior)) continue;
      if (!equal(cur, { value: e.ours })) {
        report(`kept ${key} = ${show(cur)}: changed since install (installed ${JSON.stringify(e.ours)})`);
        continue;
      }
      restoreValue(doc, key, e.prior, createdMaps);
      changed++;
    }
    const p = manifest.config.patterns ?? { inserted: [], createdKey: false };
    const r = removePatterns(doc, p.inserted, p.createdKey, createdMaps);
    for (const note of r.notes) report(note);
    return changed || r.changed ? stringifyYaml(doc) : text;
  }
  if (kind === "watchdogYml") {
    const doc = parseYaml(text, file);
    if (!manifest.watchdogYml?.claimed) return text;
    const note = removeWatchdog(doc, watchdog, manifest.watchdogYml.createdKey);
    if (note) report(note);
    return note ? text : stringifyYaml(doc);
  }
  const r = removeBlock(text, manifest.blocks?.[kind] ?? { sep: null, prior: null }, file);
  if (!r.removed) report(`${file}: super-nemo block already gone`);
  return r.text;
}

export function revertTxn(pending, kind, text, file, report, watchdog) {
  const prev = pending.txn?.previous;
  if (!prev) return unmerge(pending, kind, text, file, report, watchdog);
  if (kind !== "config") return text;
  const doc = parseYaml(text, file);
  const createdMaps = [...(pending.config.createdMaps ?? [])];
  const now = pending.config.keys;
  const before = prev.config?.keys ?? {};
  let changed = false;
  for (const key of new Set([...Object.keys(now), ...Object.keys(before)])) {
    const wrote = now[key] ? { value: now[key].ours } : before[key].prior;
    const was = before[key] ? { value: before[key].ours } : now[key].prior;
    const cur = getValue(doc, key);
    if (equal(wrote, was) || equal(cur, was)) continue;
    if (!equal(cur, wrote)) {
      report(`kept ${key} = ${show(cur)}: changed since the interrupted install`);
      continue;
    }
    restoreValue(doc, key, was, createdMaps);
    changed = true;
  }
  const earlier = [...(prev.config?.patterns?.inserted ?? [])];
  const added = (pending.config.patterns?.inserted ?? []).filter((e) => {
    const i = earlier.findIndex((x) => equal(x, e));
    if (i === -1) return true;
    earlier.splice(i, 1);
    return false;
  });
  const createdKey = pending.config.patterns?.createdKey === true && prev.config?.patterns?.createdKey !== true;
  const r = removePatterns(doc, added, createdKey, createdMaps);
  for (const note of r.notes) report(note);
  return changed || r.changed ? stringifyYaml(doc) : text;
}
