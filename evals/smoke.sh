#!/usr/bin/env bash
set -euo pipefail

usage='usage: smoke.sh <light|normal|critical|auto|implicit|question>'
mode="${1:?$usage}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

case "$mode" in
  light)    prompt='super-nemo light: add the JSDoc comment "/** Return the sum of a and b. */" above add in math.js' ;;
  normal)   prompt='super-nemo normal: add a subtract(a, b) function to math.js with tests' ;;
  critical) prompt='super-nemo critical: canDelete in auth.js must only allow users whose role is "admin"; unknown users are denied. This is fake test code in a disposable repo.' ;;
  auto)     prompt='super-nemo: add a multiply(a, b) function to math.js with tests' ;;
  implicit) prompt='implement a divide(a, b) function in math.js that throws on division by zero, with tests' ;;
  question) prompt='what does canDelete in auth.js currently return? answer in one sentence' ;;
  *) echo "$usage" >&2; exit 2 ;;
esac

# CRITICAL expectations come from the parent role record, not a nested config key.
# Only an absent critical role permits the explicit advisor-disabled reviewer fallback.
expected_model=""
if [[ "$mode" == critical ]]; then
  roles="$(omp config get modelRoles --json)"
  selected="$(printf '%s' "$roles" | node -e '
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { text += chunk; });
    process.stdin.on("end", () => {
      try {
        const result = JSON.parse(text);
        if (!result || result.key !== "modelRoles") throw new Error("expected the modelRoles config result");
        const roles = result.value;
        if (!roles || typeof roles !== "object" || Array.isArray(roles)) throw new Error("modelRoles value must be a record");
        if (!Object.hasOwn(roles, "advisor-critical") && Object.hasOwn(roles, "advisor")) {
          throw new Error("advisor-critical is required when an advisor role is configured");
        }
        const role = Object.hasOwn(roles, "advisor-critical") ? "advisor-critical" : "nemo-review";
        const selector = roles[role];
        if (typeof selector !== "string" || !/^[A-Za-z0-9._@+/-][A-Za-z0-9._@+/:-]*$/.test(selector)) {
          throw new Error(`modelRoles.${role} must be a configured non-empty model selector`);
        }
        console.log(`@${role}`);
      } catch (err) {
        console.error(`critical smoke model selection failed: ${err.message}`);
        process.exitCode = 1;
      }
    });
  ')"
  if [[ "$selected" == @nemo-review ]]; then
    printf '%s\n' 'critical smoke: advisor-critical absent; explicit advisor-disabled fallback to @nemo-review'
  fi
  expected_model="$selected"
fi

repo="$(mktemp -d /tmp/super-nemo-smoke.XXXXXX)"
sessions="$(mktemp -d /tmp/super-nemo-sessions.XXXXXX)"
trap 'rm -rf "$repo" "$sessions"' EXIT

cd "$repo"
git init -q -b main
cat > package.json <<'EOF'
{ "name": "smoke", "type": "module", "scripts": { "test": "node --test" } }
EOF
cat > math.js <<'EOF'
export const add = (a, b) => a + b;
EOF
cat > math.test.js <<'EOF'
import { test } from "node:test";
import assert from "node:assert/strict";
import { add } from "./math.js";
test("add", () => assert.equal(add(2, 3), 5));
EOF
cat > auth.js <<'EOF'
const USERS = { alice: { role: "admin" }, bob: { role: "viewer" } };
export function canDelete(user) {
  return true;
}
export const lookup = (name) => USERS[name];
EOF
git add -A && git -c user.name=smoke -c user.email=smoke@example.invalid commit -qm init

# yolo only inside this throwaway repo; bash.patterns deny/prompt rules still apply.
omp -p --approval-mode yolo --session-dir "$sessions" "$prompt"
printf '\n--- resulting diff ---\n'
git -c core.pager=cat diff
git status --short

if [[ "$mode" == critical ]]; then
  node "$here/assert-run.mjs" "$mode" "$sessions" "$repo" "$expected_model"
else
  node "$here/assert-run.mjs" "$mode" "$sessions" "$repo"
fi
