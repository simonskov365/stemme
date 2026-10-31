#!/bin/bash
# Compatible with macOS's built-in Bash 3.2. No credentials are logged.
set -Eeuo pipefail
stemme_pause() { printf '\nTryk Enter for at lukke vinduet. '; read -r stemme_unused || true; }
stemme_fail() { printf '\n%s\n' "$1"; stemme_pause; exit 1; }
stemme_check_node() {
  if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    printf '\nInstaller først Node.js 24 LTS fra https://nodejs.org/en/download\nVælg macOS Installer (.pkg). Luk og genåbn dette vindue bagefter.\n'
    stemme_pause; exit 1
  fi
  if ! node -e 'const [major,minor]=process.versions.node.split(".").map(Number);process.exit(major===24&&minor>=10?0:1)'; then
    stemme_fail 'Denne udgave kræver Node.js 24.10 eller nyere inden for version 24. Installer Node.js 24 LTS.'
  fi
}
