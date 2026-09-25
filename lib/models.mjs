import fs from "node:fs";
import { runOmp } from "./context.mjs";
import { SnError } from "./util.mjs";

export const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const SAFE = /^[A-Za-z0-9._@+/-][A-Za-z0-9._@+/:-]*$/;

function normalize(raw) {
  const list = Array.isArray(raw?.models) ? raw.models : null;
  if (!list) throw new SnError("model list is not of the form {\"models\": [...]}");
  return list.flatMap((m) => {
    if (!m || typeof m.selector !== "string" || !SAFE.test(m.selector) || typeof m.provider !== "string") return [];
    if (m.kind !== undefined && m.kind !== "chat") return [];
    const thinking = Array.isArray(m.thinking) ? m.thinking.filter((t) => LEVELS.includes(t)) : null;
    const output = m.cost?.output;
    return [{
      provider: m.provider,
      selector: m.selector,
      name: typeof m.name === "string" ? m.name : m.selector,
      reasoning: m.reasoning === true,
      thinking: thinking?.length ? thinking : null,
      costOutput: typeof output === "number" && Number.isFinite(output) ? output : null,
    }];
  });
}

export async function loadModels(ctx) {
  let raw;
  if (process.env.SN_MODELS_JSON) {
    raw = fs.readFileSync(process.env.SN_MODELS_JSON, "utf8");
  } else {
    const res = await runOmp(ctx, ["models", "--json"]);
    if (!res.ok) throw new SnError(`omp models --json failed: ${res.stderr.trim()}`);
    raw = res.stdout;
  }
  try {
    return normalize(JSON.parse(raw));
  } catch (err) {
    if (err instanceof SnError) throw err;
    throw new SnError(`cannot parse model list: ${err.message}`);
  }
}

export function formatRole(model, thinking) {
  return thinking ? `${model.selector}:${thinking}` : model.selector;
}

export function parseRole(models, value) {
  if (typeof value !== "string" || !value) return null;
  const exact = models.find((m) => m.selector === value);
  if (exact) return { model: exact, thinking: null };
  const i = value.lastIndexOf(":");
  if (i <= 0) return null;
  const model = models.find((m) => m.selector === value.slice(0, i));
  const thinking = value.slice(i + 1);
  if (!model || !model.thinking?.includes(thinking)) return null;
  return { model, thinking };
}

export function pickThinking(model, preferred) {
  if (!model.thinking) return null;
  if (model.thinking.includes(preferred)) return preferred;
  const want = LEVELS.indexOf(preferred);
  return [...model.thinking].sort((a, b) => Math.abs(LEVELS.indexOf(a) - want) - Math.abs(LEVELS.indexOf(b) - want))[0];
}

export function roleFromFlag(models, value, flag, preferredThinking) {
  const exact = models.find((m) => m.selector === value);
  if (exact) return formatRole(exact, pickThinking(exact, preferredThinking));
  const i = value.lastIndexOf(":");
  const model = i > 0 ? models.find((m) => m.selector === value.slice(0, i)) : null;
  if (!model) throw new SnError(`${flag}: unknown model selector ${JSON.stringify(value)} (see omp models)`, 2);
  const thinking = value.slice(i + 1);
  if (!model.thinking?.includes(thinking)) {
    const allowed = model.thinking ? model.thinking.join(", ") : "none (omit the suffix)";
    throw new SnError(`${flag}: thinking level ${JSON.stringify(thinking)} is not supported by ${model.selector}; supported: ${allowed}`, 2);
  }
  return value;
}

const byCost = (a, b) => (a.costOutput ?? Infinity) - (b.costOutput ?? Infinity);

export function strongest(models) {
  const reasoning = models.filter((m) => m.reasoning);
  const pool = reasoning.length ? reasoning : models;
  return [...pool].sort((a, b) => (b.costOutput ?? -1) - (a.costOutput ?? -1))[0] ?? null;
}

export function cheapestReasoning(models, provider) {
  const pool = models.filter((m) => m.provider === provider && m.reasoning);
  return [...(pool.length ? pool : models.filter((m) => m.provider === provider))].sort(byCost)[0] ?? null;
}
