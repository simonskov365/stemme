#!/bin/bash
set -Eeuo pipefail
cd "$(dirname "$0")"
source mac/common.sh
trap 'printf "\nOpdateringen blev ikke færdig. Se beskeden ovenfor.\n"; stemme_pause' ERR
stemme_check_node
printf '\nSTEMME — opdatering\nStop først den gamle Stemme med Control+C i dens Terminal-vindue.\nNæste vindue beder dig vælge din EKSISTERENDE Stemme-mappe.\nVælg mappen, hvor du normalt åbner Start.command, ikke denne nye download.\n'
read -r -p 'Tryk Enter, når den gamle app er stoppet. ' stemme_continue
if ! stemme_target=$(/usr/bin/osascript -e 'POSIX path of (choose folder with prompt "Vælg din eksisterende Stemme-mappe (den med dine gemte samtaler og Start.command)")'); then
  printf '\nOpdatering annulleret.\n'; exit 0
fi
node mac/update.mjs "$stemme_target"
printf '\nFærdig. Starter den opdaterede Stemme. Genindlæs browseren med Command+Shift+R.\n'
cd "$stemme_target"
exec /bin/bash ./Start.command
