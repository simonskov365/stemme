# Stemme · chat og backend

Personal AI assistant backend: Node.js 24.10+ (24.x), TypeScript, Fastify, SQLite, Groq text streaming, Fish Audio MP3 speech. A Danish chat interface is included and served by the same process. No deployment is included. Fastify supplies a small HTTP layer, body limits and plugins; Zod validates inputs. SQLite uses Node's built-in driver with versioned SQL migrations, so no separate database server is needed.

## Run

From `/workspace/stemme` (or the repository root on your computer):

```sh
npm ci
cp .env.example .env   # only when .env does not already exist
# Edit .env on the server; add your credentials and chosen models.
npm run typecheck
npm test
npm run build
npm start
```

Development: `npm run dev` (watch mode, loads `.env`). Default bind is loopback port 3000. A missing `.env` is allowed: conversations, memory, tools and health work; text requests return `TEXT_NOT_CONFIGURED` until both `GROQ_API_KEY` and `GROQ_MODEL` are set. Speech is explicitly off by default. To enable it, set `SPEECH_ENABLED=true`, `FISH_API_KEY`, `FISH_MODEL`, `FISH_VOICE_ID`. No model IDs are hardcoded. Select current supported IDs and ensure your account has access.

`npm start` and `npm run dev` use Node's `--use-env-proxy` so inherited HTTPS proxy and CA trust continue to apply in cloud environments. Never disable TLS verification. Scripts require Node 24.10+; `.nvmrc` selects 24. Tests use only mocked providers, including mocked SDK HTTP responses; they do not need keys or spend API credit. One test opens an ephemeral loopback HTTP server to exercise actual SSE. The runner uses `--test-isolation=none` to avoid unnecessary worker processes in restricted environments.

Edit `assistant.md` to change the system instructions, or configure `SYSTEM_INSTRUCTIONS_FILE` and `ASSISTANT_NAME`. Responses default to English for both displayed text and speech; the interface remains Danish and the configured Fish voice is unchanged. Restart after changes. Startup validates configuration by variable name without printing values. Invalid speech configuration prevents startup when speech is enabled. Health reports configuration presence, **not** live provider connectivity.

## Brugerfladen

Start med `npm start` fra projektmappen. Brugerfladen serveres på `/` på den samme server som API'et (standard: lokal port 3000). Du behøver ingen ekstra frontendserver eller frontend-build.

- Skriv i chatfeltet; på computer sender Enter, mens Shift+Enter laver linjeskift. På mobil sender pilknappen.
- **Talte svar** er et aktivt tilvalg. Kontakten vises deaktiveret, hvis tale er slået fra på serveren. Din konfigurerede Fish-stemme bruges; brugerfladen kender ikke provider-nøglerne.
- **Stop** afbryder både generation og lokal afspilning. En ny samtale stopper også gammel lyd. Hvis browseren blokerer automatisk lyd, bruges den synlige afspilningsknap.
- Historik, omdøbning, sletning og opt-in hukommelse findes i sidemenuen/indstillingerne. Hukommelse gemmes kun ved en udtrykkelig godkendelse.
- Hvis serveren kræver `API_TOKEN`, indtastes denne serveradgangskode under indstillinger. Den gemmes kun i fanens hukommelse. Indtast aldrig Groq- eller Fish-nøgler i brugerfladen.

Samtaler og hukommelse gemmes i SQLite. Brugerfladen gemmer ingen samtaletekst eller nøgler i localStorage/sessionStorage. Den starter ikke automatisk nye chargeable requests ved forbindelsesfejl; prøv igen-knappen genbruger samme request-id. SSE-genforbindelse genafspiller kun allerede gemte events.

## Structure

- `public/`: responsive Danish chat, browser SSE reader, audio queue and memory controls. No external scripts, fonts or frontend packages are loaded.
- `src/app.ts`: API validation, ownership, CORS, authentication, limits, SSE.
- `src/orchestrator.ts`: durable turns/events, cancellation, text/audio lifecycle.
- `src/providers/`: official Groq SDK adapter and Fish Audio HTTP adapter.
- `src/store.ts`, `migrations/`: SQLite, migrations and recovery of interrupted work.
- `src/context.ts`: conservative context budgeting, lossy history excerpts, speech cleanup.
- `src/tools.ts`: allowlisted registry, exact approvals, at-most-once execution.
- `tests/`: storage, API, orchestration, real HTTP transport and mocked provider tests. `tests/browser/` adds Chromium end-to-end tests with generated audio.

[API reference](docs/api.md) · [Frontend connection guide](docs/frontend.md) · [Operations and live smoke test](docs/operations.md)

## Security and scope

This is a **single-user local development backend**. With no token it accepts only loopback Host headers and binds to loopback. Allowed origins are explicit. No identity is taken from request bodies or ownership headers. Optional `API_TOKEN` authenticates one configured `OWNER_ID`; it is not multi-user authentication. Remote binding requires at least 32 random characters in `API_TOKEN`. Before remote access, use TLS, a trusted authentication gateway, real per-user identity mapping if needed, secure token handling, backups, request/connection quotas and deployment-specific controls. Do not put provider keys into the frontend. A static API token in a public frontend bundle is not a secure deployment design.

No arbitrary shell, filesystem, URL-fetching or external-action tool is registered. Only a read-only clock example exists and is disabled until `ENABLED_TOOLS=clock`. Tools are called through the explicit API; no model-specific automatic function calling is assumed. Future state-changing integrations must be registered server-side, honor abort signals and require exact user approval. Microphone conversation mode is opt-in and uses a separate Groq Whisper transcription request, configured with `GROQ_TRANSCRIPTION_MODEL` (default `whisper-large-v3-turbo`). Recording pauses during text/speech generation and playback to prevent feedback. There is no wake word or automatic listening before the user starts the mode.

Code and data stay local; nothing has been pushed, deployed or published by setup. Provider requests will use your accounts and can incur charges once you enable them and explicitly send requests.

## Browser tests

`npm run test:ui` runs ten browser scenarios against a separate in-memory database and mocked text/speech providers. It never uses real provider credentials. Requires Chromium (default `/usr/bin/chromium`, override with `CHROMIUM_PATH`) and `ffmpeg` on PATH for a synthetic MP3 fixture. Both are available in this cloud environment. Playwright Core is pinned in the lockfile; no browser download is needed here. Screenshots are written to ignored `artifacts/`. Regular `npm test` remains independent of browser/ffmpeg availability.

The static login shell is public when API_TOKEN is enabled, but every API request still requires authentication. Only seven exact static paths are served. No `.env`, database, source file, arbitrary path or provider configuration is accessible. A same-origin CSP restricts scripts and connections; user/assistant text is rendered as literal text, never inserted as HTML. Same-origin browser requests are accepted without adding the local server origin to ALLOWED_ORIGINS; external origins still require the configured allowlist.

## Mørkt stemmeinterface

Brugerfladen har et mørkt, cyan Jarvis-inspireret udtryk uden instrumentpaneler. Den centrale cirkel følger assistentens faktiske lydafspilning, viser arbejdsstatus og respekterer reduceret bevægelse. Se [Mac-opdateringsvejledningen](docs/mac-update.md) for at opdatere kun brugerfladen uden at flytte dine nøgler eller samtaler.

Oplæsning starter nu sætningsvist under tekstgenereringen. Lyscirklen ligger fast bag de scrollende beskeder og vibrerer ved afspilning. Brug `Opdater.command` fra den nye download til at opdatere en eksisterende Mac-installation; både backend og brugerflade skal opdateres. Se [Mac-vejledningen](docs/mac-update.md).

## Samtaletilstand med mikrofon

Klik **Start samtale**, og tillad mikrofonen i browseren. Tal normalt, og hold en kort pause, når du er færdig. Appen sender optagelsen til Groq Whisper, viser din transskriberede besked og svarer med din Fish-stemme. Når oplæsningen og de ventende lydsegmenter er færdige, åbnes mikrofonen automatisk igen. Standardsproget for svaret er fortsat engelsk; vælg Auto, Dansk eller English for selve transskriptionen.

- Mikrofonen er slukket før start. Ingen browser-speech-recognition eller ekstra provider bruges.
- Mikrofonsporet er dæmpet under transskription/svar/afspilning; det er en samtale på skift, ikke samtidig fuld-duplex tale som en realtime-telefonforbindelse. **Afbryd og tal** stopper det aktuelle svar og åbner mikrofonen igen.
- **Send nu** sender den aktuelle optagelse manuelt, hvis automatisk pausegenkendelse ikke passer til din måde at tale på.
- **Afslut samtale** stopper optagelse, frigiver mikrofonen, annullerer ventende transskription og stopper afspilning. Skift af samtale, faneskift/skjult fane og lukning af siden afslutter også mikrofontilstanden.
- Optagelser gemmes ikke på disk. De behandles i RAM og sendes til Groq over HTTPS. Godkendt transskriberet tekst bliver en normal besked i SQLite. Serverens idempotency-cache beholder kun transskriptionstekst/hash i en 30-minutters genbrugsperiode (udløbne poster fjernes ved næste forespørgsel), med en fast kapacitetsgrænse.
- Der sendes efter ca. 950 ms stilhed efter registreret tale (mindst ca. 220 ms lyd over tærsklen). Tavshed sendes ikke automatisk. Optagelser afgrænses til 60 sekunder; tavse optagelser fornyes lokalt efter 20 sekunder. Headset og et roligt rum kan hjælpe ved støj. Optagelser over 8 MiB afvises som standard.
- Funktionen kræver en opdateret browser med MediaRecorder, Web Audio og mikrofonadgang samt en sikker adresse: HTTPS eller lokal loopback. Safari vælger MP4, Chromium vælger normalt WebM/Opus. Mikrofonforløbet testes i Chromium med simuleret input og simulerede providers. Rigtig Safari/mikrofon samt genkendelseskvalitet verificeres først på din Mac.
- Transskription bruger din eksisterende Groq-nøgle og Groqs særskilte talekvote. Ingen ny betalingsplan aktiveres af appen. Requests efter tvetydige fejl genforsøges ikke automatisk.

Det nye sort/orange design er inspireret af referencebilledet. Energikuglen tegnes lokalt med Canvas, uden eksterne billeder eller scripts, reagerer på både mikrofon og Fish-afspilning og bliver bag chatten ved scroll. Reduceret bevægelse giver et stillestående billede.

Mikrofon og energianimation indlæses nu som valgfrie moduler: en manglende eller ikke-understøttet ekstrafunktion kan ikke blokere tekstchatten. Dekorative lag opsnapper aldrig klik. Hvis siden viser Forbinder efter en opdatering, stop den gamle server med Control+C, start Start.command igen og genindlæs browseren. Mac-opdateringen kontrollerer nu serverporten, før programfiler overskrives; Mac-starten kontrollerer porten, før databasen åbnes.
