#!/usr/bin/env bash
# Bundles Homebrew's pinned libmpv and builds the video helper against its headers.
# Requires: brew install mpv dylibbundler
set -euo pipefail
if [[ "$(uname -m)" != 'arm64' ]]; then
  echo 'macOS releases require an Apple Silicon runner.' >&2
  exit 1
fi
mpv_prefix="$(brew --prefix mpv)"
mpv_version="$(brew list --versions mpv | awk '{ print $2 }')"
test "${mpv_version%%_*}" = '0.41.0'
native_dir="apps/desktop/resources/native"
build="$(mktemp -d)"
trap 'rm -rf "$build"' EXIT
mkdir -p "$native_dir/lib"
cp "$mpv_prefix/lib/libmpv.dylib" "$native_dir/libmpv.dylib"
dylibbundler -od -b -x "$native_dir/libmpv.dylib" -d "$native_dir/lib" -p '@loader_path/lib/'
bun apps/desktop/scripts/prepare-macos-libraries.ts "$native_dir"
cmake -S apps/desktop/native -B "$build" -DCMAKE_BUILD_TYPE=Release -DCMAKE_OSX_ARCHITECTURES=arm64 \
  -DMPV_INCLUDE_DIR="$mpv_prefix/include"
cmake --build "$build" --parallel
ctest --test-dir "$build" --output-on-failure
cp "$build/Lumen Video Helper" "$native_dir/"
codesign --force --sign - "$native_dir/Lumen Video Helper"
if [[ -n "${GITHUB_ENV:-}" ]]; then echo 'LUMEN_MPV_VERSION=0.41.0' >> "$GITHUB_ENV"; fi
