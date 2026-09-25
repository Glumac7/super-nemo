#!/bin/zsh
# Usage: smoke.sh <light|normal|critical|auto|implicit|question>
set -euo pipefail

mode="${1:?usage: smoke.sh <light|normal|critical|auto|implicit|question>}"
repo="$(mktemp -d /tmp/super-nemo-smoke.XXXXXX)"
trap 'rm -rf "$repo"' EXIT

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

case "$mode" in
  light)    prompt='super-nemo light: add the JSDoc comment "/** Return the sum of a and b. */" above add in math.js' ;;
  normal)   prompt='super-nemo normal: add a subtract(a, b) function to math.js with tests' ;;
  critical) prompt='super-nemo critical: canDelete in auth.js must only allow users whose role is "admin"; unknown users are denied. This is fake test code in a disposable repo.' ;;
  auto)     prompt='super-nemo: add a multiply(a, b) function to math.js with tests' ;;
  implicit) prompt='implement a divide(a, b) function in math.js that throws on division by zero, with tests' ;;
  question) prompt='what does canDelete in auth.js currently return? answer in one sentence' ;;
  *) print -u2 "unknown mode $mode"; exit 1 ;;
esac

# yolo only inside this throwaway repo; bash.patterns deny/prompt rules still apply.
omp -p --approval-mode yolo "$prompt"
print "\n--- resulting diff ---"
git -c core.pager=cat diff
git status --short
