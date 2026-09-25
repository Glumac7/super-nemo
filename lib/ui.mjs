import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LEVELS } from "./models.mjs";

const rich = () => Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined && process.env.TERM !== "dumb";
const paint = (code) => (text) => (rich() ? `\x1b[${code}m${text}\x1b[0m` : String(text));

export const bold = paint("1");
export const dim = paint("2");
const green = paint("32");
const red = paint("31");
const yellow = paint("33");

const pick = (fancy, plain) => (rich() ? fancy : plain);
export const sep = () => pick(" · ", " - ");

function homes() {
  const list = [os.homedir()];
  try {
    list.push(fs.realpathSync(list[0]));
  } catch {}
  return [...new Set(list)].filter((h) => h.length > 1).sort((a, b) => b.length - a.length);
}

export function tilde(text) {
  let out = String(text);
  for (const home of homes()) {
    const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`${escaped}(?![\\w.-])`, "g"), "~");
  }
  return out;
}

export const ok = (text) => `${green(pick("✓", "OK"))} ${tilde(text)}`;
export const fail = (text) => `${red(pick("✗", "x"))} ${tilde(text)}`;
export const warn = (text) => `${yellow("!")} ${tilde(text)}`;
export const bullet = (text) => `${pick("•", "-")} ${tilde(text)}`;

const width = (text) => String(text).replace(/\x1b\[[0-9;]*m/g, "").length;

export function table(rows, indent = "  ") {
  const widths = [];
  for (const row of rows) row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, width(cell))));
  return rows.map((row) => indent + row.map((cell, i) => (i === row.length - 1 ? cell : cell + " ".repeat(widths[i] - width(cell) + 3))).join("").trimEnd()).join("\n");
}

export function modelName(selector) {
  const i = selector.indexOf("/");
  return i > 0 ? selector.slice(i + 1) : selector;
}

function splitRole(role) {
  if (typeof role !== "string" || !role) return { selector: "unknown", thinking: null };
  const i = role.lastIndexOf(":");
  return i > 0 && LEVELS.includes(role.slice(i + 1)) ? { selector: role.slice(0, i), thinking: role.slice(i + 1) } : { selector: role, thinking: null };
}

const provider = (selector) => (selector.includes("/") ? selector.slice(0, selector.indexOf("/")) : null);

export function roleLabel(role) {
  const r = splitRole(role);
  return r.thinking ? `${modelName(r.selector)}${sep()}${r.thinking}` : modelName(r.selector);
}

function criticalLabel(advisor, critical) {
  const a = splitRole(advisor);
  const c = splitRole(critical);
  return a.selector === c.selector && c.thinking ? c.thinking : roleLabel(critical);
}

const APPROVAL = {
  write: ["off", "asks before running commands that change things"],
  "always-ask": ["off", "asks before every command"],
  yolo: ["on", "runs every command without asking"],
};

export function setupRows(choices) {
  const c = choices && typeof choices === "object" ? choices : {};
  const sameProvider = provider(splitRole(c.review).selector) === provider(splitRole(c.impl).selector);
  const approval = Object.hasOwn(APPROVAL, c.approval) ? APPROVAL[c.approval] : [String(c.approval ?? "unknown"), ""];
  return [
    ["Main model", roleLabel(c.impl), "writes the code; also your everyday OMP model"],
    ["Cheap model", c.fast ? roleLabel(c.fast) : "same as main", "used for quick searches"],
    ["Advisor", c.advisor ? roleLabel(c.advisor) : "off",
      c.advisor ? `watches the coder (critical work: ${criticalLabel(c.advisor, c.advisorCritical)})` : "nobody watches the coder"],
    ["Reviewers", roleLabel(c.review), sameProvider ? "same provider as the main model (a different one reviews better)" : "different provider = better reviews"],
    ["Auto-approve", ...approval],
  ].map(([label, value, note]) => [label, value, dim(note)]);
}

const SETTINGS = {
  "modelRoles.default": "Main model",
  "modelRoles.nemo-fast": "Cheap model",
  "modelRoles.advisor": "Advisor",
  "modelRoles.advisor-critical": "Advisor for critical work",
  "modelRoles.nemo-review": "Reviewers",
  "task.agentModelOverrides.reviewer": "Model for the reviewer agent",
  "task.agentModelOverrides.security-reviewer": "Model for the security reviewer",
  "task.agentModelOverrides.task": "Model for task agents",
  "task.agentModelOverrides.scout": "Model for scout",
  "task.agentModelOverrides.sonic": "Model for sonic",
  "task.agentAdvisor.nemo-implementer": "Advisor for the implementer",
  "task.agentAdvisor.nemo-implementer-critical": "Advisor for the critical implementer",
  "task.isolation.enabled": "Isolation",
  "advisor.syncBacklog": "Advisor backlog",
  "tools.approvalMode": "Auto-approve",
  "tools.approval.eval": "Eval approval",
  "bash.patterns": "Blocked commands",
};

const ALIASES = { "@default": "same as main", "@nemo-fast": "Cheap model", "@nemo-review": "Reviewers model", "@advisor": "Advisor model" };

export const settingLabel = (key) => (Object.hasOwn(SETTINGS, key) ? SETTINGS[key] : key);

export function settingValue(key, v) {
  if (!v || v.absent) return "not set";
  const value = v.value;
  if (key === "tools.approvalMode" && Object.hasOwn(APPROVAL, value)) return value === "always-ask" ? "off (asks before every command)" : APPROVAL[value][0];
  if (typeof value === "boolean") return value ? "on" : "off";
  if (typeof value === "string" && /^(modelRoles|task\.agentModelOverrides)\./.test(key)) {
    if (Object.hasOwn(ALIASES, value)) return ALIASES[value];
    return value.startsWith("@") ? `the ${value.slice(1)} role` : roleLabel(value);
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function changedSetting(key, cur, file, suffix = "") {
  return `${settingLabel(key)}: you changed this to ${settingValue(key, cur)}${suffix} (${path.basename(file)}: ${key})`;
}

export const settingNote = (key, file, text) => `${settingLabel(key)}: ${text} (${path.basename(file)}: ${key})`;

export function mismatchedSetting(key, cur, expected, file) {
  return settingNote(key, file, `is ${settingValue(key, cur)}, expected ${settingValue(key, { value: expected })}`);
}

export const KEPT = "; kept it";

export const noteLine = (msg, setting) => warn(setting ? changedSetting(setting.key, setting.cur, setting.file, KEPT) : msg);
