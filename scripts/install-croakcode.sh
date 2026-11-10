#!/usr/bin/env bash
# Installs croakcode for the current user from this checkout, so it works in
# any project folder:
#
#   0. ~/.local/share/croakcode/app
#      A git worktree of origin/master that croakcode runs from. Switching
#      branches in this checkout does not change the running croakcode; only
#      a merge to master followed by a re-run of this script does.
#   1. ~/.croakcode -> <app>/upstream/.croakcode
#      croakcode reads ~/.croakcode in every project: the litellm-head
#      provider, the croak plugins (login, gate identity, tool policy, HWP,
#      usage), commands and agents, from the same pinned worktree.
#   2. ~/.config/croak/croakcode.env (mode 600)
#      The gate address and its CA certificate. Operational values stay out
#      of the repository.
#   3. ~/.local/bin/croakcode
#      Starts the TUI in the current folder with those settings.
#
# Usage:
#   scripts/install-croakcode.sh --gate https://<gate-host>:8443 [--ca <ca.crt>]
#   scripts/install-croakcode.sh             # update to origin/master, keeping the saved gate
#   scripts/install-croakcode.sh --dev       # run this checkout as it is (for development)
#   scripts/install-croakcode.sh --uninstall # remove the link, the launcher and the worktree
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$HOME/.local/share/croakcode/app"
LINK="$HOME/.croakcode"
ENV_DIR="$HOME/.config/croak"
ENV_FILE="$ENV_DIR/croakcode.env"
BIN_DIR="$HOME/.local/bin"
LAUNCHER="$BIN_DIR/croakcode"

die() { echo "error: $*" >&2; exit 1; }

gate=""
ca="$ENV_DIR/ca/ca.crt"
uninstall=0
dev=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --gate) gate="${2:?--gate needs a URL}"; shift 2 ;;
    --ca) ca="${2:?--ca needs a path}"; shift 2 ;;
    --uninstall) uninstall=1; shift ;;
    --dev) dev=1; shift ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

if [[ "$uninstall" == 1 ]]; then
  if [[ -L "$LINK" ]]; then rm "$LINK"; echo "removed $LINK"; fi
  if [[ -f "$LAUNCHER" ]] && grep -q "croakcode launcher" "$LAUNCHER"; then rm "$LAUNCHER"; echo "removed $LAUNCHER"; fi
  if [[ -d "$APP_DIR" ]]; then git -C "$REPO" worktree remove --force "$APP_DIR"; echo "removed $APP_DIR"; fi
  echo "kept $ENV_FILE (delete it yourself if you no longer need the gate settings)"
  exit 0
fi

command -v bun >/dev/null || die "bun is not installed (https://bun.sh)"
[[ -d "$REPO/upstream/.croakcode" ]] || die "$REPO/upstream/.croakcode not found; run this from a croakcode checkout"

# 0. The code croakcode runs: a worktree pinned to origin/master, or this checkout with --dev.
install_deps() {
  # tree-sitter-powershell's build needs a C compiler; without one the
  # scripts fail but the links are still usable (see README).
  (cd "$1" && bun install --frozen-lockfile >/dev/null 2>&1) || (cd "$1" && bun install --frozen-lockfile --ignore-scripts >/dev/null)
}
if [[ "$dev" == 1 ]]; then
  SRC="$REPO"
  [[ -d "$REPO/upstream/node_modules" ]] || die "dependencies are missing; run 'bun install' in $REPO and in $REPO/upstream first"
  echo "using this checkout as it is: $REPO (branch $(git -C "$REPO" branch --show-current))"
else
  SRC="$APP_DIR"
  git -C "$REPO" fetch --quiet origin master
  if [[ -d "$APP_DIR" ]]; then
    git -C "$APP_DIR" checkout --quiet --detach origin/master
  else
    mkdir -p "$(dirname "$APP_DIR")"
    git -C "$REPO" worktree add --quiet --detach "$APP_DIR" origin/master
  fi
  echo "pinned $APP_DIR to origin/master ($(git -C "$APP_DIR" log --oneline -1))"
  echo "installing dependencies (this can take a minute)..."
  install_deps "$APP_DIR"
  install_deps "$APP_DIR/upstream"
fi
CONFIG_SRC="$SRC/upstream/.croakcode"

# 1. Project config and plugins for every folder.
if [[ -L "$LINK" ]]; then
  ln -sfn "$CONFIG_SRC" "$LINK"
elif [[ -e "$LINK" ]]; then
  backup="$LINK.bak-$(date +%Y%m%d-%H%M%S)"
  mv "$LINK" "$backup"
  echo "moved the existing $LINK to $backup"
  ln -s "$CONFIG_SRC" "$LINK"
else
  ln -s "$CONFIG_SRC" "$LINK"
fi
echo "linked $LINK -> $CONFIG_SRC"

# 2. Gate settings, kept outside the repository.
mkdir -p "$ENV_DIR"
chmod 700 "$ENV_DIR"
if [[ -n "$gate" ]]; then
  [[ "$gate" =~ ^https://[^/[:space:]]+$ ]] || die "--gate must look like https://<host>:<port> with no path"
  [[ -f "$ca" ]] || echo "warning: CA certificate $ca not found; HTTPS to the gate will fail until it exists" >&2
  umask 077
  cat > "$ENV_FILE" <<EOF
# croakcode gate settings (written by scripts/install-croakcode.sh)
CROAK_AUTH_URL=$gate
LITELLM_BASE_URL=$gate/v1
NODE_EXTRA_CA_CERTS=$ca
EOF
  chmod 600 "$ENV_FILE"
  echo "wrote $ENV_FILE"
elif [[ -f "$ENV_FILE" ]]; then
  echo "kept $ENV_FILE"
else
  die "no gate settings yet; pass --gate https://<gate-host>:8443"
fi

# 3. Launcher.
mkdir -p "$BIN_DIR"
cat > "$LAUNCHER" <<EOF
#!/usr/bin/env bash
# croakcode launcher (installed by $REPO/scripts/install-croakcode.sh)
# Opens the TUI for the current folder, or for the folder given first.
# Sessions: croakcode resume [folder] [--last | --list | -s <session id>]
#           croakcode -s <session id>
set -euo pipefail
set -a
. "$ENV_FILE"
set +a
# "resume" is a subcommand; the rest follows the same rules.
sub=()
if [[ "\${1:-}" == resume ]]; then sub=(resume); shift; fi
# A first argument that is not an option is the project folder; options such
# as "-s <session>" go to croakcode as they are.
start="\$PWD"
if [[ \$# -gt 0 && "\$1" != -* ]]; then start="\$1"; shift; fi
# A WSL terminal starts in the Windows system folder; never use that as the project.
case "\$start" in /mnt/c/WINDOWS*|/mnt/c/Windows*) start="\$HOME" ;; esac
project="\$(cd "\$start" && pwd)"
exec bun run --cwd "$SRC/upstream/packages/opencode" --conditions=browser src/index.ts "\${sub[@]}" "\$project" "\$@"
EOF
chmod 755 "$LAUNCHER"
echo "installed $LAUNCHER"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "note: $BIN_DIR is not on PATH; add it to your shell profile" ;;
esac
echo "done. Run 'croakcode' in a project folder, then /login."
