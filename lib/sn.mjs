import { parseArgs } from "node:util";
import { createContext } from "./context.mjs";
import { install } from "./install.mjs";
import { status } from "./status.mjs";
import { uninstall } from "./uninstall.mjs";
import { SnError } from "./util.mjs";
import { verify } from "./verify.mjs";

const USAGE = `Usage: ./sn <command> [options]

Commands:
  install     link SUPER-NEMO into OMP and configure model roles (asks questions)
  uninstall   remove everything install added and restore your previous settings
  status      show whether it is installed, chosen roles, drift and broken links
  verify      check the installation; --smoke also runs the light + normal smoke evals

Common options:
  --profile <name>        use the OMP profile ~/.omp/profiles/<name>/agent
  --dry-run               install/uninstall: print the plan, write nothing
  -h, --help              show this help

Install options (non-interactive with --yes; unspecified values use defaults):
  --yes                   no questions
  --impl <sel[:thinking]>             implementation/main model (modelRoles.default)
  --fast <sel[:thinking]|none>        cheaper model for scout/sonic
  --advisor <sel[:thinking]|off>      advisor for NORMAL work
  --advisor-critical <sel[:thinking]> advisor for CRITICAL work
  --review <sel[:thinking]>           reviewer model
  --approval <write|always-ask|yolo>  tools.approvalMode (default write)
  --overwrite-drift       replace settings you changed since the last install
  --no-smoke              skip the smoke evals after install

Exit codes: 0 ok, 1 failed or aborted, 2 invalid usage or selector, 3 drift needs a decision.`;

const OPTIONS = {
  install: ["yes", "impl", "fast", "advisor", "advisor-critical", "review", "approval", "overwrite-drift", "no-smoke", "dry-run"],
  uninstall: ["dry-run"],
  status: [],
  verify: ["smoke"],
};
const STRINGS = new Set(["impl", "fast", "advisor", "advisor-critical", "review", "approval", "profile"]);

async function main(argv) {
  const command = argv[0];
  if (!command || command === "-h" || command === "--help" || command === "help") {
    console.log(USAGE);
    return 0;
  }
  if (!OPTIONS[command]) throw new SnError(`unknown command ${JSON.stringify(command)}\n\n${USAGE}`, 2);
  const names = [...OPTIONS[command], "profile", "help"];
  const options = Object.fromEntries(names.map((n) => [n, { type: STRINGS.has(n) ? "string" : "boolean" }]));
  options.help.short = "h";
  let values;
  try {
    ({ values } = parseArgs({ args: argv.slice(1), options, strict: true, allowPositionals: false }));
  } catch (err) {
    throw new SnError(`${err.message}\n\n${USAGE}`, 2);
  }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const ctx = createContext({ profile: values.profile });
  if (command === "install") return install(ctx, values);
  if (command === "uninstall") return uninstall(ctx, values);
  if (command === "status") return status(ctx);
  return (await verify(ctx, { smoke: values.smoke })) ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    const error = err?.code === "ABORT_ERR" ? new SnError("Aborted; nothing was changed.") : err;
    if (!(error instanceof SnError)) throw error;
    console.error(error.message);
    process.exitCode = error.exitCode;
  },
);
