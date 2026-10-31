# Opdater til det mørke Stemme-interface på din Mac

Denne opdatering ændrer kun brugerfladens filer i `public/`. Nøgler, samtaler, voice-id og engelske svar bevares i din eksisterende installation.

1. Stop Stemme med **Control+C** i det Terminal-vindue, der kører appen.
2. Åbn https://github.com/simonskov365/stemme og vælg **Code → Download ZIP**.
3. Pak den nye zip ud. Finder kan give den nye mappe et nummer, hvis `stemme-main` allerede findes.
4. Kopiér kun mappen **public** fra den nye download ind i din **eksisterende, fungerende Stemme-mappe** (den, hvor du normalt åbner `Start.command`). Vælg **Erstat** for `public`.
5. Åbn din eksisterende **Start.command** igen. Åbn chatten og tryk **Command+Shift+R** i browseren for at indlæse de nye filer.

Du skal ikke køre Installer.command igen. Erstat ikke hele den eksisterende projektmappe: `.env` og `data/` indeholder dine lokale nøgler og samtaler og skal blive liggende.

## Design og lyd

Interfacet er mørkt med cyan lys, en central animeret cirkel og den eksisterende chat. Ingen instrumentpaneler eller falsk mikrofonstatus. Cirklen viser, når assistenten arbejder, og analyserer den faktiske lyd fra afspilleren med browserens Web Audio API, når talen afspilles. Den bruger ikke mikrofonen. Stop stopper både lyd og bevægelse. Animation dæmpes, når macOS/browseren har reduceret bevægelse aktiveret; lydafspilning bevares.

Hvis Safari blokerer automatisk afspilning, tryk på afspilningsknappen i chatten. Hvis lydanalyse ikke understøttes eller tillades af browseren, bevares almindelig afspilning. Browserens lokale lydadgang og visuelle reaktion er testet i Chromium; Safari-kontrollen på din Mac udestår.

Den seneste udgave har en større lyscirkel, langsomt bevægeligt baggrundslys, kredsende lyspunkter og separate bølgebånd, der følger frekvenserne i den afspillede lyd. Stop nulstiller effekten med det samme. Bevægelse sættes på pause i skjulte faner, og reduceret bevægelse dæmper alle nye animationer.
