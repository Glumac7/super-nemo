#!/usr/bin/env bash
set -euo pipefail

say() { printf 'super-nemo: %s\n' "$*" >&2; }
die() {
  say "$*"
  exit 1
}
redact() { sed -E 's#([A-Za-z][A-Za-z0-9+.-]*://)[^/@[:space:]]*@#\1***@#g'; }
shown() { printf '%s' "$1" | redact; }

git_net() {
  case "$access" in
    gh) env -u SSH_ASKPASS GIT_TERMINAL_PROMPT=0 GIT_ASKPASS="$silent_askpass" git -c credential.helper= -c 'credential.helper=!gh auth git-credential' -c core.askPass= "$@" ;;
    anonymous) env -u SSH_ASKPASS GIT_TERMINAL_PROMPT=0 GIT_ASKPASS="$silent_askpass" git -c credential.helper= -c core.askPass= "$@" ;;
    *) GIT_TERMINAL_PROMPT=0 git "$@" ;;
  esac
}

identity() {
  node -e '
try {
  const s = require("fs").lstatSync(process.argv[1], { bigint: true });
  process.stdout.write(s.isDirectory() ? `${s.dev}:${s.ino}` : "other");
} catch {
  process.stdout.write("missing");
}' "$1"
}

remove_if_ours() {
  local dir="$1" id="$2" parent
  [ -e "$dir" ] || [ -L "$dir" ] || return 0
  parent="$(cd "$(dirname "$dir")" 2>/dev/null && pwd -P)" || parent=""
  if [ -n "$id" ] && [ "$(identity "$dir")" = "$id" ] && [ "$parent" = "$home_real" ]; then
    rm -rf "$dir"
    return 0
  fi
  say "left $dir: it is no longer the directory this installer created"
  return 1
}

manifest_clone() {
  node -e '
const [file, clone, origin] = process.argv.slice(1);
let m;
try {
  m = JSON.parse(require("fs").readFileSync(file, "utf8"));
} catch {
  process.stdout.write("none 0");
  process.exit(0);
}
const c = m && m.clone;
const ok = m && m.tool === "super-nemo" && ["installed", "pending"].includes(m.status) && m.repo === clone
  && c && c.createdByBootstrap === true && c.path === clone && c.origin === origin;
process.stdout.write(ok ? `${m.status} ${m.createdHome === true ? 1 : 0}` : "none 0");
' "$home_real/state/manifest.json" "$clone_real" "$url"
}

manifest_refers_to_clone() {
  node -e '
const [file, clone] = process.argv.slice(1);
let m;
try {
  m = JSON.parse(require("fs").readFileSync(file, "utf8"));
} catch {
  process.exit(0);
}
process.exit(m && (m.repo === clone || (m.clone && m.clone.path === clone)) ? 0 : 1);
' "$home_real/state/manifest.json" "$clone_real"
}

is_our_checkout() {
  [ -d "$clone" ] && [ ! -L "$clone" ] || return 1
  [ "$(git -C "$clone" rev-parse --show-toplevel 2>/dev/null)" = "$clone_real" ] || return 1
  [ "$(git -C "$clone" config --get remote.origin.url 2>/dev/null)" = "$url" ] || return 1
  node -e 'process.exit(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).name === "super-nemo" ? 0 : 1)' "$clone/package.json" 2>/dev/null
}

on_exit() {
  local status=$?
  trap - EXIT
  if [ -n "$tmp" ]; then remove_if_ours "$tmp" "$tmp_id" || true; fi
  if [ "$created_clone" = 1 ]; then
    if [ -e "$home_real/state/manifest.json" ] && manifest_refers_to_clone; then
      [ "$status" -eq 0 ] || say "kept $clone: the installer recorded state; run $clone/sn uninstall to remove everything"
    elif remove_if_ours "$clone" "$clone_id"; then
      say "removed $clone again: no installation was recorded"
    fi
  fi
  if [ "$created_home" = 1 ]; then rmdir "$home_dir" 2>/dev/null || true; fi
  exit "$status"
}

fresh_clone() {
  local err
  tmp="$(mktemp -d "$home_real/.repo.XXXXXX")"
  tmp_id="$(identity "$tmp")"
  say "cloning $(shown "$url") ($ref) into $clone"
  if ! err="$(git_net clone --quiet --depth 1 --branch "$ref" "$url" "$tmp" 2>&1 </dev/null)"; then
    [ -z "$err" ] || printf '%s\n' "$err" | redact >&2
    die "could not clone $(shown "$url")$access_hint"
  fi
  [ "$(identity "$tmp")" = "$tmp_id" ] || die "$tmp changed while cloning; not touching it"
  node -e 'require("fs").renameSync(process.argv[1], process.argv[2])' "$tmp" "$clone" 2>/dev/null \
    || die "$clone appeared while cloning; not touching it"
  tmp=""
  created_clone=1
  clone_id="$(identity "$clone")"
  [ "$clone_id" = "$tmp_id" ] || die "$clone is not the directory that was just cloned"
  export SN_BOOTSTRAP_CLONE=1 SN_BOOTSTRAP_CREATED_HOME="$created_home"
}

existing_clone() {
  local state created
  is_our_checkout || die "$clone exists but is not a checkout this installer created and installed from; move it away, then re-run"
  read -r state created <<<"$(manifest_clone)"
  case "$state" in
    installed)
      if [ "$dry_run" = 1 ]; then
        "$clone/sn" update --pull-only --dry-run </dev/null
      else
        "$clone/sn" update --pull-only </dev/null
      fi
      ;;
    pending)
      say "found an interrupted install from $clone; the installer rolls it back first"
      created_clone=1
      clone_id="$(identity "$clone")"
      if [ "$created" = 1 ]; then created_home=1; fi
      export SN_BOOTSTRAP_CLONE=1 SN_BOOTSTRAP_CREATED_HOME="$created"
      ;;
    *) die "$clone exists but is not a checkout this installer created and installed from; move it away, then re-run" ;;
  esac
}

main() {
  unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_NAMESPACE GIT_PREFIX
  unset SN_BOOTSTRAP_CLONE SN_BOOTSTRAP_CREATED_HOME
  repo="${SN_REPO:-Glumac7/super-nemo}"
  url="${SN_REPO_URL:-https://github.com/$repo.git}"
  ref="${SN_REF:-main}"
  home_dir="$HOME/.super-nemo"
  clone="$home_dir/repo"
  home_real=""
  tmp=""
  tmp_id=""
  clone_id=""
  created_home=0
  created_clone=0
  dry_run=0
  local arg
  for arg in "$@"; do
    if [ "$arg" = --dry-run ]; then dry_run=1; fi
  done
  access=local
  access_hint=""

  command -v git >/dev/null 2>&1 || die "git is not installed"
  command -v node >/dev/null 2>&1 || die "node 20 or newer is required"
  node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' || die "node 20 or newer is required; found $(node --version)"
  command -v omp >/dev/null 2>&1 || die "omp is not on PATH; install Oh My Pi 18.3.0 or newer"
  local omp_version
  omp_version="$(omp --version 2>/dev/null || true)"
  [[ "$omp_version" =~ ([0-9]+)\.([0-9]+)\.[0-9]+ ]] || die "cannot read the omp version from \`omp --version\`"
  if ((BASH_REMATCH[1] < 18 || (BASH_REMATCH[1] == 18 && BASH_REMATCH[2] < 3))); then
    die "omp $omp_version is too old; need 18.3.0 or newer"
  fi
  case "$url" in
    https://github.com/*)
      silent_askpass="$(type -P true)" || die "cannot find the true command on PATH"
      access_hint="; the repository may be private or unreachable"
      if command -v gh >/dev/null 2>&1 && gh auth status --hostname github.com >/dev/null 2>&1 </dev/null; then
        access=gh
      else
        access=anonymous
        access_hint="$access_hint; for a private fork install \`gh\` and run \`gh auth login\`"
      fi
      ;;
  esac

  trap on_exit EXIT
  if [ ! -e "$home_dir" ] && [ ! -L "$home_dir" ]; then
    mkdir "$home_dir"
    created_home=1
  fi
  [ -d "$home_dir" ] || die "$home_dir exists and is not a directory"
  home_real="$(cd "$home_dir" && pwd -P)"
  clone_real="$home_real/repo"

  if [ -e "$clone" ] || [ -L "$clone" ]; then
    existing_clone
  else
    fresh_clone
  fi

  if [ -t 0 ]; then
    "$clone/sn" install "$@"
  elif { : </dev/tty; } 2>/dev/null; then
    "$clone/sn" install "$@" </dev/tty
  else
    "$clone/sn" install "$@" </dev/null
  fi
  if [ "$dry_run" = 1 ]; then return 0; fi
  say "update later with: $clone/sn update"
  say "uninstall with:    $clone/sn uninstall"
}

main "$@"
