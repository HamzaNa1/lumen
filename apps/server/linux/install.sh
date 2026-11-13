#!/bin/sh
# Installs or updates the Lumen server as a systemd service.
#   curl -fsSL https://github.com/HamzaNa1/lumen/releases/download/server-latest/install.sh | sudo sh
# Options (after `sh -s --`): --version=X.Y.Z, --auto-update
# Installed releases run their copy of this script to install newer ones, so the package name,
# SHA256SUMS and `bin/lumenctl install` are a contract between releases.
set -eu

releases=${LUMEN_RELEASE_URL:-https://github.com/HamzaNa1/lumen/releases}
version=""
auto_update=""

fail() {
  echo "lumen: $*" >&2
  exit 1
}

for arg in "$@"; do
  case "$arg" in
    --version=*) version=${arg#--version=} ;;
    --auto-update) auto_update=--auto-update ;;
    *) fail "unknown option: $arg" ;;
  esac
done

[ "$(id -u)" = 0 ] || fail "run the installer as root, for example with sudo"
[ "$(uname -s)" = Linux ] || fail "the Lumen service installer supports Linux only"
[ -d /run/systemd/system ] || fail "the Lumen service needs systemd"
for libc in /lib/ld-musl-*; do
  [ -e "$libc" ] && fail "musl systems are not supported; run the Lumen server image with Docker instead"
done
for tool in curl tar gzip sha256sum flock; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is required"
done
case "$(uname -m)" in
  x86_64 | amd64) arch=amd64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) fail "unsupported architecture: $(uname -m)" ;;
esac

# Held until lumenctl install finishes, so an install and an automatic update never overlap.
exec 9>/run/lumen-install.lock
flock -n 9 || fail "another Lumen install or update is running"

if [ -z "$version" ]; then
  version=$(curl -fsSL "$releases/download/server-latest/latest-version") ||
    fail "could not find the latest Lumen server release"
fi
printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' ||
  fail "not a release version: $version"

target=/opt/lumen/versions/$version
if [ ! -x "$target/bin/lumenctl" ]; then
  package=lumen-server-$version-linux-$arch.tar.gz
  download=$(mktemp -d)
  trap 'rm -rf "$download"' EXIT
  echo "Downloading Lumen $version for $arch"
  base="$releases/download/v$version%2Bserver"
  curl -fsSL -o "$download/$package" "$base/$package" ||
    fail "could not download $package"
  curl -fsSL -o "$download/SHA256SUMS" "$base/SHA256SUMS" ||
    fail "could not download the checksums for Lumen $version"
  grep -q "  $package\$" "$download/SHA256SUMS" ||
    fail "the release has no checksum for $package"
  (cd "$download" && grep "  $package\$" SHA256SUMS | sha256sum -c --status -) ||
    fail "$package does not match its published checksum"
  umask 022
  mkdir -p /opt/lumen/versions
  rm -rf "$target.partial"
  mkdir "$target.partial"
  tar --no-same-owner -xzf "$download/$package" -C "$target.partial"
  mv "$target.partial" "$target"
  rm -rf "$download"
  trap - EXIT
fi

LUMEN_RELEASE_URL=$releases exec "$target/bin/lumenctl" install $auto_update
