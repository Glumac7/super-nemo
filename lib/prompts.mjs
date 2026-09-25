import readline from "node:readline/promises";

export function ttyPrompter() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on("SIGINT", () => {
    rl.close();
    process.exit(130);
  });
  return {
    ask: (question) => rl.question(question),
    say: (text) => console.log(text),
    close: () => rl.close(),
  };
}

export async function yesNo(p, question, def) {
  for (;;) {
    const a = (await p.ask(`${question} ${def ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
    if (!a) return def;
    if (["y", "yes"].includes(a)) return true;
    if (["n", "no"].includes(a)) return false;
  }
}

export async function choose(p, title, options, defIndex) {
  p.say(title);
  options.forEach((o, i) => p.say(`  ${i + 1}) ${o}${i === defIndex ? "  (default)" : ""}`));
  for (;;) {
    const a = (await p.ask(`Choice [${defIndex + 1}]: `)).trim();
    if (!a) return defIndex;
    const n = Number(a);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return n - 1;
  }
}
