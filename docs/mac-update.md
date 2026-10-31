# Opdater til det mørke Stemme-interface på din Mac

Denne opdatering forbedrer både brugerfladen og backendens oplæsning. **Det er ikke nok kun at udskifte public-mappen denne gang.**

1. Stop Stemme med **Control+C** i det Terminal-vindue, der kører appen.
2. Åbn https://github.com/simonskov365/stemme og vælg **Code → Download ZIP**.
3. Pak den nye zip ud. Finder kan give den nye mappe et nummer, hvis `stemme-main` allerede findes.
4. I den **nye download**: dobbeltklik på **Opdater.command**.
5. Vælg din **eksisterende, fungerende Stemme-mappe** i vinduet, der åbner. Det er mappen, hvor du normalt åbner `Start.command`, ikke den nye download.
6. Opdateringen kopierer programfiler, installerer afhængigheder og bygger backenden. Derefter starter den din eksisterende installation igen. Genindlæs browseren med **Command+Shift+R**.

Opdateringsværktøjet kopierer kun en fast liste af programfiler. Det overskriver aldrig `.env`, `data/` eller dine tilpassede `assistant.md`-instruktioner. Det kræver en eksisterende Stemme-installation og afviser den nye download som mål. Nye API-nøgler er ikke nødvendige. Finder-valget via AppleScript skal bekræftes på din Mac; kopieringslogikken er testet med midlertidige testdata i Linux.

## Design og lyd

Interfacet er mørkt med cyan lys, en central animeret cirkel og den eksisterende chat. Ingen instrumentpaneler eller falsk mikrofonstatus. Cirklen viser, når assistenten arbejder, og analyserer den faktiske lyd fra afspilleren med browserens Web Audio API, når talen afspilles. Den bruger ikke mikrofonen. Stop stopper både lyd og bevægelse. Animation dæmpes, når macOS/browseren har reduceret bevægelse aktiveret; lydafspilning bevares.

Hvis Safari blokerer automatisk afspilning, tryk på afspilningsknappen i chatten. Hvis lydanalyse ikke understøttes eller tillades af browseren, bevares almindelig afspilning. Browserens lokale lydadgang og visuelle reaktion er testet i Chromium; Safari-kontrollen på din Mac udestår.

Den seneste udgave har en større lyscirkel, langsomt bevægeligt baggrundslys, kredsende lyspunkter og separate bølgebånd, der følger frekvenserne i den afspillede lyd. Stop nulstiller effekten med det samme. Bevægelse sættes på pause i skjulte faner, og reduceret bevægelse dæmper alle nye animationer.

## Fast baggrund og hurtigere talestart

Cirklen er nu forankret til chatvinduet uden for det scrollende beskedområde. Lange samtaler glider hen over den; den forsvinder ikke op med teksten. Teksten har en diskret mørk baggrund for læsbarhed, og cirklen opsnapper ingen klik. Mens lyden afspilles, vibrerer cirklens indre lag i takt med den målte lydstyrke. Reduceret bevægelse slår vibrationen fra.

Oplæsningen starter med den første færdige sætning, mens resten af teksten fortsætter. Tidligere ventede backenden på hele svaret. Fish Audios netværks- og behandlingstid gælder stadig, og der kan være pauser mellem segmenter. Korte segmenter betyder flere TTS-forespørgsler end ét samlet kald; udbyderens kvoter og vilkår gælder. Tale- og tekstfejl håndteres fortsat uafhængigt, og Stop afbryder begge køer.

## Mikrofon og orange energikerne

Den seneste opdatering indeholder både ny backend-transskription og et sort/orange Canvas-design inspireret af referencebilledet. Brug Opdater.command som beskrevet ovenfor; kun at udskifte public er ikke nok. Eksisterende .env og Fish voice-id bevares. Groq-transskription virker med den eksisterende Groq-nøgle og bruger som standard whisper-large-v3-turbo, så en ny nøgle er ikke nødvendig.

Efter opdatering: Start samtale → tillad mikrofonadgang i Safari → tal → hold en kort pause. Stemme svarer på engelsk med Fish-stemmen og åbner mikrofonen igen bagefter. Afbryd og tal bruges til at tage ordet under et svar. Afslut samtale slukker mikrofonen. Hvis adgang afvises, se Safari > Indstillinger > Websteder > Mikrofon og macOS > Systemindstillinger > Anonymitet og sikkerhed > Mikrofon. Undlad at indsætte API-nøgler i browseren.

## Hvis siden bliver stående på Forbinder

Det kan ske, når en gammel Node-server stadig kører, mens nye frontendfiler ligger på disken. Den gamle backend kan mangle routes til voice.js/orb.js. Tidligere blokerede manglende ekstramoduler hele JavaScript-opstarten; dette er rettet, så tekstchatten fortsat kan starte, og mikrofonen giver en tydelig genstartsbesked.

Find det gamle Terminal-vindue, som kører Stemme, tryk **Control+C** dér og åbn den eksisterende **Start.command** igen. Genindlæs browseren med **Command+Shift+R**. Hvis der står, at porten er optaget, kører der stadig en server; en ny Start.command erstatter ikke den gamle proces. Luk ikke kun den nye Terminal-fane med fejlbeskeden. Den nye opdateringsfil afviser nu at kopiere programfiler, mens serverporten er optaget, og startfilen afviser at åbne databasen under en anden aktiv server.
