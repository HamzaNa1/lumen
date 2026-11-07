#!/usr/bin/env bash
set -euo pipefail

read -r -a browsers <<< "${E2E_BROWSERS:-}"
# macOS ships Bash 3.2, where an empty array trips nounset without this guard.
for browser in ${browsers[@]+"${browsers[@]}"}; do
  case "$browser" in
    chromium|firefox|webkit) ;;
    *) echo "Unsupported browser: $browser" >&2; exit 1 ;;
  esac
done

install_linux_packages() {
  sudo apt-get update
  local packages=(ffmpeg) missing status=0
  if [[ "$E2E_NATIVE" == true ]]; then
    packages+=(mpv)
  fi
  if [[ "$E2E_NATIVE" == true ]] || (( ${#browsers[@]} )); then
    packages+=(xvfb openbox x11-utils pulseaudio pulseaudio-utils)
  fi
  if (( ${#browsers[@]} )); then
    missing=$(bun run playwright install-deps --dry-run "${browsers[@]}") || status=$?
    printf '%s\n' "$missing"
    if (( status != 0 )); then
      # Playwright 1.63 reports missing packages without installing them. Reject
      # unexpected output instead of silently proceeding with incomplete libraries.
      if (( status != 1 )) || ! grep -Eq '^Missing system dependencies \([0-9]+\):$' <<< "$missing"; then
        return 1
      fi
      while read -r package; do
        [[ "$package" =~ ^[a-z0-9][a-z0-9.+:-]*$ ]] || return 1
        packages+=("$package")
      done < <(sed -n 's/^  //p' <<< "$missing")
    fi
  fi
  sudo apt-get install -y --no-install-recommends "${packages[@]}"
}

if [[ "$RUNNER_OS" == Linux ]]; then
  install_linux_packages &
  packages_pid=$!
  # Always reap the installer, including when a concurrent download fails.
  trap 'wait "$packages_pid"' EXIT
elif [[ "$RUNNER_OS" == macOS ]]; then
  packages=(ffmpeg)
  if [[ "$E2E_NATIVE" == true ]]; then packages+=(mpv); fi
  brew install "${packages[@]}"
elif [[ "$RUNNER_OS" == Windows ]]; then
  packages=(ffmpeg)
  # Windows native tests use the renamed MPV executable from bundle-mpv.
  choco install "${packages[@]}" -y --no-progress --cache-location "$(cygpath -w "$HOME/.cache/chocolatey")"
fi

if (( ${#browsers[@]} )); then
  PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1 bun run playwright install --only-shell "${browsers[@]}"
fi
if [[ "$E2E_NATIVE" == true ]]; then
  bun apps/desktop/node_modules/electron/install.js
fi
if [[ "$RUNNER_OS" == Linux ]]; then
  wait "$packages_pid"
  trap - EXIT
fi
if (( ${#browsers[@]} )); then
  # Validate libraries only after apt finishes, including on browser cache hits.
  bun run playwright install --only-shell "${browsers[@]}"
fi
