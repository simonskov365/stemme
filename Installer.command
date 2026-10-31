#!/bin/bash
set -Eeuo pipefail
cd "$(dirname "$0")"
source mac/common.sh
trap 'printf "\nOpsætningen blev ikke færdig. Se fejlbeskeden ovenfor.\n"; stemme_pause' ERR
printf '\nSTEMME — opsætning på din Mac\n'
stemme_check_node
if [ ! -f .env ]; then
  printf '\nIndsæt din Groq-nøgle (gsk_...). Den vises ikke, mens du skriver.\n'
  read -r -s -p 'Groq API-nøgle: ' STEMME_SETUP_GROQ_KEY
  printf '\n'
  case "$STEMME_SETUP_GROQ_KEY" in gsk_*) ;; *) stemme_fail 'Det ligner ikke en Groq-nøgle. Start Installer.command igen.' ;; esac
  if [[ "$STEMME_SETUP_GROQ_KEY" =~ [[:space:]] ]]; then stemme_fail 'Nøglen må ikke indeholde mellemrum.'; fi
  printf '\nIndsæt din Fish-nøgle (sk-fish-...) for at bruge din valgte stemme.\nDu kan trykke Enter uden en nøgle for kun at bruge tekst.\n'
  read -r -s -p 'Fish API-nøgle: ' STEMME_SETUP_FISH_KEY
  printf '\n'
  if [ -n "$STEMME_SETUP_FISH_KEY" ]; then
    case "$STEMME_SETUP_FISH_KEY" in sk-fish-*) ;; *) stemme_fail 'Det ligner ikke en Fish-nøgle. Start Installer.command igen.' ;; esac
    if [[ "$STEMME_SETUP_FISH_KEY" =~ [[:space:]] ]]; then stemme_fail 'Nøglen må ikke indeholde mellemrum.'; fi
  fi
  export STEMME_SETUP_GROQ_KEY STEMME_SETUP_FISH_KEY
  node mac/configure.mjs
  unset STEMME_SETUP_GROQ_KEY STEMME_SETUP_FISH_KEY
else
  printf '\nDin eksisterende .env bevares. API-nøgler bliver ikke overskrevet.\n'
fi
printf '\nInstallerer afhængigheder. Det kræver internet og kan tage et par minutter.\n'
npm ci --include=dev --no-audit --no-fund
npm run build
printf '\nOpsætningen er færdig. Starter Stemme …\n'
exec /bin/bash ./Start.command
