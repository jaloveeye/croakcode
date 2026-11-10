#!/usr/bin/env bash
# Installs croakcode for the current user from this checkout, so it works in
# any project folder:
#
#   1. ~/.croakcode -> <repo>/upstream/.croakcode
#      croakcode reads ~/.croakcode in every project: the litellm-head
#      provider, the croak plugins (login, gate identity, tool policy, HWP,
#      usage), commands and agents. A link keeps them in step with git pull.
#   2. ~/.config/croak/croakcode.env (mode 600)
#      The gate address and its CA certificate. Operational values stay out
#      of the repository.
#   3. ~/.local/bin/croakcode
#      Starts the TUI in the current folder with those settings.
#
# Usage:
#   scripts/install-croakcode.sh --gate https://<gate-host>:8443 [--ca <ca.crt>]
#   scripts/install-croakcode.sh             # reinstall, keeping the saved gate
#   scripts/install-croakcode.sh --uninstall # remove the link and the launcher
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_SRC="$REPO/upstream/.croakcode"
LINK="$HOME/.croakcode"
ENV_DIR="$HOME/.config/croak"
ENV_FILE="$ENV_DIR/croakcode.env"
BIN_DIR="$HOME/.local/bin"
LAUNCHER="$BIN_DIR/croakcode"

die() { echo "error: $*" >&2; exit 1; }

gate=""
ca="$ENV_DIR/ca/ca.crt"
uninstall=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --gate) gate="${2:?--gate needs a URL}"; shift 2 ;;
    --ca) ca="${2:?--ca needs a path}"; shift 2 ;;
    --uninstall) uninstall=1; shift ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

if [[ "$uninstall" == 1 ]]; then
  if [[ -L "$LINK" ]]; then rm "$LINK"; echo "removed $LINK"; fi
  if [[ -f "$LAUNCHER" ]] && grep -q "croakcode launcher" "$LAUNCHER"; then rm "$LAUNCHER"; echo "removed $LAUNCHER"; fi
  echo "kept $ENV_FILE (delete it yourself if you no longer need the gate settings)"
  exit 0
fi

command -v bun >/dev/null || die "bun is not installed (https://bun.sh)"
[[ -d "$CONFIG_SRC" ]] || die "$CONFIG_SRC not found; run this from a croakcode checkout"
[[ -d "$REPO/upstream/node_modules" ]] || die "dependencies are missing; run 'bun install' in $REPO and in $REPO/upstream first"

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
# Resume a session with: croakcode -s <session id>
set -euo pipefail
set -a
. "$ENV_FILE"
set +a
# A first argument that is not an option is the project folder; options such
# as "-s <session>" go to croakcode as they are.
start="\$PWD"
if [[ \$# -gt 0 && "\$1" != -* ]]; then start="\$1"; shift; fi
# A WSL terminal starts in the Windows system folder; never use that as the project.
case "\$start" in /mnt/c/WINDOWS*|/mnt/c/Windows*) start="\$HOME" ;; esac
project="\$(cd "\$start" && pwd)"
exec bun run --cwd "$REPO/upstream/packages/opencode" --conditions=browser src/index.ts "\$project" "\$@"
EOF
chmod 755 "$LAUNCHER"
echo "installed $LAUNCHER"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "note: $BIN_DIR is not on PATH; add it to your shell profile" ;;
esac
echo "done. Run 'croakcode' in a project folder, then /login."
