import readline from "node:readline/promises";
import { SnError } from "./util.mjs";

export function ttyPrompter() {
  const terminal = process.env.TERM !== "dumb";
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal });
  let closing = false;
  let pending = null;
  const cancelled = () => new SnError(`\nCancelled. ${p.afterCancel}`);
  const interrupt = () => {
    closing = true;
    rl.close();
    console.log(`\nCancelled. ${p.afterCancel}`);
    process.exit(130);
  };
  rl.on("SIGINT", interrupt);
  if (!terminal) process.on("SIGINT", interrupt);
  rl.on("close", () => {
    if (!closing) pending?.(cancelled());
  });
  const p = {
    afterCancel: "Nothing was changed.",
    ask: (question) => new Promise((resolve, reject) => {
      pending = reject;
      rl.question(question).then(resolve, (err) => reject(err?.code === "ABORT_ERR" ? cancelled() : err));
    }).finally(() => {
      pending = null;
    }),
    say: (text) => console.log(text),
    close: () => {
      closing = true;
      process.off("SIGINT", interrupt);
      rl.close();
    },
  };
  return p;
}

async function keyed(p, question, answers, def, hint) {
  for (;;) {
    const a = (await p.ask(question)).trim().toLowerCase();
    if (!a) return def;
    const hit = Object.keys(answers).find((k) => answers[k].includes(a));
    if (hit) return hit;
    p.say(hint);
  }
}

const YES = ["y", "yes"];
const NO = ["n", "no"];

export async function yesNo(p, question, def) {
  return (await keyed(p, `${question} ${def ? "[Y/n]" : "[y/N]"} `, { y: YES, n: NO }, def ? "y" : "n", "Please answer y or n.")) === "y";
}

export function yesNoChange(p, question) {
  return keyed(p, question, { y: YES, n: NO, c: ["c", "change"] }, "y", "Please answer y (use it), n (cancel) or c (change it).");
}

export async function choose(p, title, options, defIndex) {
  p.say(title);
  const pad = String(options.length).length;
  options.forEach((o, i) => p.say(`  ${String(i + 1).padStart(pad)}) ${o}`));
  for (;;) {
    const a = (await p.ask(`Choice [${defIndex + 1}]: `)).trim();
    if (!a) return defIndex;
    const n = Number(a);
    if (/^\d+$/.test(a) && n >= 1 && n <= options.length) return n - 1;
    p.say(`Enter a number from 1 to ${options.length}, or press Enter for ${defIndex + 1}.`);
  }
}
