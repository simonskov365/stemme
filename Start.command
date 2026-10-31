#!/bin/bash
set -Eeuo pipefail
cd "$(dirname "$0")"
source mac/common.sh
stemme_check_node
if [ ! -f .env ] || [ ! -f dist/app.js ] || [ ! -d node_modules ]; then
  stemme_fail 'Kør først Installer.command i denne mappe.'
fi
printf '\nSTEMME — din personlige assistent\nBrowseren åbnes automatisk, når serveren er klar.\nLad dette vindue stå åbent. Tryk Ctrl+C her for at stoppe Stemme.\n'
node --use-env-proxy --env-file=.env mac/launch.mjs || {
  printf '\nStemme kunne ikke starte. Hvis programmet allerede kører, skal du bruge det eksisterende vindue.\n'
  stemme_pause; exit 1
}
