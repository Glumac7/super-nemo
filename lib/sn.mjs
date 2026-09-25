import { parseArgs } from "node:util";
import { createContext } from "./context.mjs";
import { install } from "./install.mjs";
import { status } from "./status.mjs";
import { uninstall } from "./uninstall.mjs";
import { update } from "./update.mjs";
import { tilde } from "./ui.mjs";
import { SnError } from "./util.mjs";
import { verify } from "./verify.mjs";

const USAGE = `Usage: ./sn <command> [options]

Commands:
  install     link SUPER-NEMO into OMP and set up its model roles (asks a few questions)
  update      fast-forward this checkout from its remote and re-apply your recorded answers
  uninstall   remove everything install added and restore your previous settings
  status      show whether it is installed, the chosen models, changes since install and broken links
  verify      check the installation; --smoke also runs a live test (light + normal smoke evals)

Common options:
  --profile <name>        use the OMP profile ~/.omp/profiles/<name>/agent
  --dry-run               install/uninstall: print the summary, write nothing; update: fetch and list new commits only
  --verbose               install/uninstall/update: also print every file, link and config key that changes
  -h, --help              show this help

Install options (non-interactive with --yes; unspecified values use defaults):
  --yes                   no questions (uninstall: no confirmation)
  --reuse                 no questions; take every answer from the current installation
  --impl <sel[:thinking]>             main model (modelRoles.default)
  --fast <sel[:thinking]|none>        cheap model for scout/sonic (modelRoles.nemo-fast); none = same as main
  --advisor <sel[:thinking]|off>      advisor for NORMAL work (modelRoles.advisor)
  --advisor-critical <sel[:thinking]> advisor for CRITICAL work (modelRoles.advisor-critical)
  --review <sel[:thinking]>           reviewer model (modelRoles.nemo-review)
  --approval <write|always-ask|yolo>  tools.approvalMode (default write)
  --overwrite-drift       install/update: replace settings you changed since the last install
  --no-smoke              skip the live test after install (runs by default with --yes)
  --pull-only             update: only fast-forward the checkout, do not re-apply

Exit codes: 0 ok, 1 failed or aborted, 2 invalid usage or selector, 3 drift needs a decision.`;

const OPTIONS = {
  install: ["yes", "reuse", "impl", "fast", "advisor", "advisor-critical", "review", "approval", "overwrite-drift", "no-smoke", "dry-run", "verbose"],
  update: ["dry-run", "overwrite-drift", "pull-only", "verbose"],
  uninstall: ["dry-run", "yes", "verbose"],
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
  if (command === "update") return update(ctx, values);
  if (command === "status") return status(ctx);
  return (await verify(ctx, { smoke: values.smoke })) ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    if (!(err instanceof SnError)) throw err;
    console.error(tilde(err.message));
    process.exitCode = err.exitCode;
  },
);
