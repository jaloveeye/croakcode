#!/usr/bin/env bash
# Install a release after verifying the administrator-provided CA fingerprint.
set -euo pipefail
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }
gate=""; fingerprint=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --gate) [ "$#" -ge 2 ] || fail 'missing gate URL'; gate="$2"; shift 2 ;;
    --ca-sha256) [ "$#" -ge 2 ] || fail 'missing CA fingerprint'; fingerprint="$2"; shift 2 ;;
    *) fail "unknown argument: $1" ;;
  esac
done
[[ "$gate" =~ ^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?$ ]] || fail 'pass --gate https://host[:port]'
fingerprint="$(printf '%s' "$fingerprint" | tr -d ': ' | tr '[:upper:]' '[:lower:]')"
[[ "$fingerprint" =~ ^[0-9a-f]{64}$ ]] || fail 'pass the CA certificate SHA-256 fingerprint with --ca-sha256'
for cmd in curl openssl tar awk uname; do command -v "$cmd" >/dev/null || fail "$cmd is required"; done
case "$(uname -s)" in Linux) os=linux ;; Darwin) os=darwin ;; *) fail 'unsupported operating system' ;; esac
case "$(uname -m)" in x86_64|amd64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) fail 'unsupported CPU' ;; esac
target="$os-$arch"
umask 077
work="$(mktemp -d "${TMPDIR:-/tmp}/croak-install.XXXXXXXX")"
trap 'rm -rf "$work"' EXIT
# Only this initial CA download bypasses TLS; the pinned DER fingerprint is checked before use.
curl -fsSL --proto '=https' --tlsv1.2 -k "$gate/download/ca.crt" -o "$work/ca.crt"
actual="$(openssl x509 -in "$work/ca.crt" -outform DER | openssl dgst -sha256 | awk '{print tolower($NF)}')"
[ "$actual" = "$fingerprint" ] || fail 'CA fingerprint does not match'
get() { curl -fsSL --proto '=https' --tlsv1.2 --cacert "$work/ca.crt" "$gate/download/$1" -o "$2"; }
get manifest.json "$work/manifest.json"
# package-release.py writes this stable, indented JSON format. Reject unexpected fields.
version="$(awk -F '"' '/^[[:space:]]*"latest":[[:space:]]*"/ { print $4; exit }' "$work/manifest.json")"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail 'invalid release version'
archive="croakcode-$version-$target.tar.gz"
hash="$(awk -F '"' -v target="$target" '
  $2 == target && $0 ~ /\{[[:space:]]*$/ { found=1; next }
  found && $2 == "sha256" { print $4; exit }
' "$work/manifest.json")"
name="$(awk -F '"' -v target="$target" '
  $2 == target && $0 ~ /\{[[:space:]]*$/ { found=1; next }
  found && $2 == "file" { print $4; exit }
' "$work/manifest.json")"
[[ "$hash" =~ ^[0-9a-f]{64}$ && "$name" == "$archive" ]] || fail 'invalid archive in manifest'
get "$archive" "$work/archive.tar.gz"
actual="$(openssl dgst -sha256 "$work/archive.tar.gz" | awk '{print tolower($NF)}')"
[ "$actual" = "$hash" ] || fail 'archive SHA-256 does not match'
# The release packager emits regular files under bin/ and config/ only.
tar -tzf "$work/archive.tar.gz" | awk '
  $0 == "bin/croakcode" { next }
  /^config\// && $0 !~ /(^|\/)\.\.?($|\/)/ { next }
  { exit 1 }
' || fail 'unexpected archive path'
tar -tvzf "$work/archive.tar.gz" | awk 'substr($0, 1, 1) != "-" { exit 1 }' || fail 'archive contains non-regular files'
mkdir "$work/unpack"
tar -xzf "$work/archive.tar.gz" -C "$work/unpack"
[ -f "$work/unpack/bin/croakcode" ] && [ -d "$work/unpack/config" ] || fail 'archive is missing executable or config'
chmod 755 "$work/unpack/bin/croakcode"
if [ "$os" = darwin ] && xattr -p com.apple.quarantine "$work/unpack/bin/croakcode" >/dev/null 2>&1; then
  xattr -dr com.apple.quarantine "$work/unpack/bin/croakcode"
fi
base="$HOME/.local/share/croakcode"; settings="$HOME/.config/croak"; bin="$HOME/.local/bin"; config="$HOME/.croakcode"
mkdir -p "$base" "$settings/ca" "$bin"
stamp="$(date +%Y%m%d-%H%M%S)"
config_backup="$config.bak-$stamp"
launcher_backup="$bin/croakcode.bak-$stamp"
if [ -e "$config" ] || [ -L "$config" ]; then
  [ ! -e "$config_backup" ] && [ ! -L "$config_backup" ] || fail 'configuration backup already exists'
fi
if [ -e "$bin/croakcode" ] || [ -L "$bin/croakcode" ]; then
  [ ! -e "$launcher_backup" ] && [ ! -L "$launcher_backup" ] || fail 'launcher backup already exists'
fi
if [ -e "$config" ] || [ -L "$config" ]; then
  mv "$config" "$config_backup"
  printf '기존 설정을 %s에 보관했습니다.\n' "$config_backup"
fi
mv "$work/unpack/config" "$config"
if [ -e "$bin/croakcode" ] || [ -L "$bin/croakcode" ]; then
  mv "$bin/croakcode" "$launcher_backup"
fi
cp "$work/unpack/bin/croakcode" "$base/croakcode.new"
mv "$base/croakcode.new" "$base/croakcode"
cp "$work/ca.crt" "$settings/ca/ca.crt"
printf '%s\n' "$gate" > "$settings/gate-url"
cat > "$bin/croakcode" <<'LAUNCHER'
#!/usr/bin/env bash
set -euo pipefail
# A WSL terminal can start in the Windows system folder; never use it as the project.
case "$PWD" in /mnt/c/WINDOWS*|/mnt/c/Windows*|/mnt/c/windows*) cd "$HOME" ;; esac
IFS= read -r CROAK_AUTH_URL < "$HOME/.config/croak/gate-url"
export CROAK_AUTH_URL
export LITELLM_BASE_URL="$CROAK_AUTH_URL/v1"
export NODE_EXTRA_CA_CERTS="$HOME/.config/croak/ca/ca.crt"
export CROAK_CA_FILE="$NODE_EXTRA_CA_CERTS"
exec "$HOME/.local/share/croakcode/croakcode" "$@"
LAUNCHER
chmod 755 "$bin/croakcode"
printf 'croakcode %s 설치를 마쳤습니다.\n' "$version"
profile="$HOME/.profile"
case "${SHELL:-}" in
  */zsh) profile="$HOME/.zprofile" ;;
  */bash) [ ! -f "$HOME/.bash_profile" ] || profile="$HOME/.bash_profile" ;;
  */fish) profile="$HOME/.config/fish/config.fish"; mkdir -p "$(dirname "$profile")" ;;
esac
if [ "$os" = darwin ] && [ -z "${SHELL:-}" ]; then profile="$HOME/.zprofile"; fi
if ! grep -Fq '# croakcode PATH' "$profile" 2>/dev/null; then
  case "${SHELL:-}" in
    */fish) printf '\n%s\n%s\n' '# croakcode PATH' 'fish_add_path "$HOME/.local/bin"' >> "$profile" ;;
    *) printf '\n%s\n%s\n' '# croakcode PATH' 'export PATH="$HOME/.local/bin:$PATH"' >> "$profile" ;;
  esac
fi
printf '새 터미널에서 croakcode를 실행하고 /login을 입력하세요.\n'
