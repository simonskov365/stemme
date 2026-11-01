# Nyra fra et kontinuitetsdokument

## På din Mac

1. Stop den gamle Stemme med Control+C. Hent nyeste ZIP fra GitHub og kør Opdater.command fra den nye download. Vælg din eksisterende installation. Nøgler og samtaler bevares. Backend og database skal opdateres; public alene er ikke nok.
2. Genindlæs Safari med Command+Shift+R. Åbn **Hukommelse & indstillinger** og find **Nyra · personlighed og kontinuitet**.
3. Indsæt dit Google Docs-link og tryk **Hent dokument**. Denne version bruger dokumentets eksisterende delte læseadgang, ikke login til hele din Google Drive-konto. Hvis linket ikke kan læses uden Google-login, kan du i Google Docs vælge Filer → Download → Almindelig tekst (.txt) og vælge filen i Stemme. Du behøver ikke gøre et privat dokument offentligt.
4. Gennemse det foreslåede personlighedsuddrag, ret det efter ønske, og behold/navngiv assistenten **Nyra**. Slå **Brug Nyra-profilen og dokumentet i mine samtaler** til og tryk **Godkend og brug profilen**.
5. Start gerne en ny samtale, og brug tekst eller Start samtale. Den konfigurerede Fish-stemme bruges stadig. Dokumentet og den godkendte profil er uafhængige af kontakten for manuelt gemte minder.

Dokumenthentning aktiverer ikke profilen automatisk. Godkendelsen gælder brug af profilen/referenceuddrag i alle dine lokale samtaler, indtil du slår den fra. Den aktiverer ingen skrivning til Google. Appen sender først udvalgte uddrag til Groq, når du beder om et AI-svar. Den fulde kilde sendes ikke automatisk til modellen.

## Opdatering og begrænsninger

**Hent seneste fra Google Docs** genlæser dokumentet og opdaterer den lokale referencekopi. Hvis Google ikke kan nås, beholdes den tidligere kopi, og tidspunkt/fejl vises. Der er ingen skjult periodisk synkronisering. Med en aktiv Google-kilde genhenter en præcis besked **sync up** eller **sync mood** dokumentet før svar genereres. Hvis læsningen fejler, rapporteres fejlen i stedet for en falsk vellykket sync. En lokal TXT-import kan ikke live-opdateres fra Google.

Den godkendte personlighed bevares ved synkronisering. Hvis du ændrer selve personligheden i Google Docs, skal du også gennemse/rette den godkendte profil i Stemme. En ny forbindelse/import giver et nyt forslag og slår profilen fra, indtil du godkender igen.

Historikken er referencemateriale, ikke en fuldstændig overførsel af alle oprindelige chats. Lokal SQLite FTS5-søgning udvælger få relevante passager og en nyere historikpassage inden for modellens kontekstbudget. Søgningen er ord-baseret, ikke semantiske embeddings eller en garanti for alle detaljer. Navn og udvalgt personlighed kan give kontinuitet, men en anden model gengiver ikke nødvendigvis tidligere Nyra-svar nøjagtigt. Permanente præferencer prioriteres over ældre rapporter, og usikkerhed må ikke skjules.

Nye Stemme-samtaler gemmes i Stemme's SQLite-database. **De bliver ikke automatisk skrevet tilbage til Google Docs.** Appen kan hverken redigere Master, læse hele Drive eller tilgå private Google-kontooplysninger. Det ville kræve en særskilt autoriseret integration.

## Data og sikkerhed

Dokument, søgeindeks, navn og godkendt personlighed gemmes i din lokale database under `data/`, som er udelukket fra Git. Kilde-URL, privat dokumenttekst og dine egne historikpassager må ikke hardcodes i kildekode, tests, logs eller uploades til GitHub. Den originale Google-fil ændres aldrig. Lokal database og sikkerhedskopier er plaintext og skal beskyttes som samtalehistorik.

Brug **Fjern fra Stemme** til at slette dokumentkopi, søgeindeks og profil. Google-originalen og dine eksisterende chats/minder bevares. Sletning af en enkelt samtale sletter ikke den særskilt godkendte kontinuitetskilde. Slå profilen fra for at stoppe brugen uden at slette data.

Google-læseren tillader kun HTTPS Google Docs-dokument-id'er og kontrollerede Google-eksportredirects, højst 1 MiB tekst og 15 sekunders timeout. Den logger ikke ind, videresender ikke cookies og bruger ingen Groq/Fish-nøgle hos Google. Credentials/private keys med kendte mønstre afvises ved import, men ingen filter kan genkende alle hemmeligheder: gem aldrig nøgler eller passwords i kontinuitetsdokumenter.

Rå dokumentinstruktioner og historiske påstande er data, ikke app-regler eller autorisation til handlinger. Stående tilladelser skrevet i dokumentet kan ikke aktivere værktøjer, filadgang, Google-skrivning eller andre eksterne handlinger. Profilvalg gør heller ikke alle historiske oplysninger sikre eller sande.

## API

Alle endpoints er beskyttet af den samme ejer-/adgangskontrol som resten af appen. Ukendte request-felter afvises.

| Route | Body/resultat |
| --- | --- |
| GET /v1/nyra | document-metadata og profil for den aktuelle ejer; ingen fuld historiktekst |
| POST /v1/nyra/connect | `{url,approved:true}`; hent delt Google Docs-kopi, returner metadata og forslag til profil |
| POST /v1/nyra/import | `{title,text,approved:true}`; importer lokal tekst, højst 1 MiB |
| GET /v1/nyra/document | inspektion af den lokale fulde tekst/core og snapshot-tid, kun aktuel ejer |
| PATCH /v1/nyra/profile | `{name,persona,enabled,approved:true}`; navn 1–60 bogstaver/tal/enkle tegn, persona højst 2200 tegn |
| POST /v1/nyra/sync | genlæs den forbundne Google-kilde, behold godkendt persona |
| DELETE /v1/nyra | fjern lokal kilde, profil og FTS-indeks; 204 |

Metadata: document `{id,document_id,title,synced_at,last_error,characters,url}` eller null; profile `{name,persona,enabled}`. Google connect/sync er begrænset til 5/minut/IP. Ingen AI-kald udføres ved import/profilgodkendelse. Nye modeller/embeddings er ikke tilføjet. Uddrag i AI-prompter tæller med i Groq-forbruget.

Migrationsfil `002_nyra.sql` opretter dokument-/profiltabeller og SQLite FTS5-indeks. Anvend den via normal serveropstart og tag normale database-backups før større opdateringer. API-tests bruger syntetiske dokumenter; browser-testen bruger en syntetisk TXT-fil. Den faktiske Google-læser er separat verificeret read-only uden at gemme privat tekst i repositoryet eller sende den til Groq. Den kvalitative gengivelse af personligheden og tale skal vurderes af brugeren i appen.
