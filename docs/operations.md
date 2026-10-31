# Operations, configuration and verification

## Configuration

See `.env.example` for the complete variable list. Secrets belong only in server-side `.env` (ignored) or injected environment variables. Do not overwrite an existing `.env`, echo secrets to logs, or commit SQLite data. In this cloud environment, runtime variables/secrets can be supplied securely through environment settings. Groq requests go only to `api.groq.com`; Fish requests only to `api.fish.audio`. No arbitrary provider URL is configurable. Allow these domains in restricted network settings for live tests. Documentation additionally uses `console.groq.com` and `docs.fish.audio`; npm packages use the standard npm preset.

`REQUEST_TIMEOUT_MS` is a total turn deadline including speech, default 60 seconds. Long responses with many speech segments may need a longer deadline (maximum 300 seconds). `OUTPUT_TOKENS` controls Groq `max_completion_tokens`; it must be less than half `CONTEXT_TOKENS`. Cap output according to the selected model. No optional temperature, tool or structured-output parameters are sent, because support varies by model. `LOG_LEVEL` controls operational logs; automatic request logging is disabled, request bodies and authorization are redacted, and raw provider error payloads are never logged or returned.

Speech uses the Fish model in the `model` HTTP header, voice ID in the MessagePack field `reference_id`, and `format: mp3`. API keys are bearer headers. Do not use a voice for which you lack permission. No speech recognition assumption is made about Fish or the selected Groq text model. `GROQ_TRANSCRIPTION_MODEL` currently has no runtime effect; adding transcription is a separate feature with its own upload constraints and endpoint.

One process owns the database. Migrations run transactionally at startup and are recorded in `migrations`. WAL and foreign keys are enabled. Do not run multiple server instances against one file, because startup interruption recovery assumes the previous process has stopped. On SIGINT/SIGTERM, connections close and active turns are interrupted; restarting never silently retries them. Back up the database with a SQLite-aware backup or after stopping the service, including/checkpointing WAL as appropriate. Database contents are plaintext local data; use disk encryption and access controls for sensitive conversations.

Long-term memories survive conversation deletion by design. Tool audit records also remain. There is no general tool-audit deletion endpoint yet. Generated audio is memory-only; cancellation, expiry, restart and conversation deletion remove it. Metadata/event URLs can outlive audio bytes. Summary digests are derived and removed with their conversation. No recordings are persisted.

## Official integration references

Verified against official SDK sources on 2026-10-31:

- [Groq text chat documentation](https://console.groq.com/docs/text-chat), [official TypeScript SDK](https://github.com/groq/groq-typescript), [chat completion types](https://github.com/groq/groq-typescript/blob/main/src/resources/chat/completions.ts): streaming delta content, `model`, `max_completion_tokens`, finish reasons, AbortSignal and disabled automatic SDK retries. The installed SDK version is pinned in `package-lock.json`.
- [Fish Audio official Python SDK](https://github.com/fishaudio/fish-audio-python), [TTS HTTP implementation](https://github.com/fishaudio/fish-audio-python/blob/main/src/fishaudio/resources/tts.py), [TTS types](https://github.com/fishaudio/fish-audio-python/blob/main/src/fishaudio/types/tts.py): POST `/v1/tts`, `application/msgpack`, bearer auth, `model` header, `reference_id`, `format: mp3`, `mp3_bitrate`, `normalize`, `latency`.

The documentation websites were blocked by the environment's network policy during verification; the official GitHub SDK sources above were successfully read instead. Current account/model/voice availability and actual MP3 synthesis require a live test after credentials are supplied. No model availability is claimed from SDK types alone.

## Optional live smoke test (uses your API credit)

1. Choose an accessible Groq text model and set `GROQ_API_KEY` plus `GROQ_MODEL` on the server. For speech, set `SPEECH_ENABLED=true` and all three Fish settings. Retain TLS verification and inherited proxy configuration. Build and start from the repository root: `npm run build`, `npm start`.
2. GET `/v1/health`; expect configured-unverified states. This step alone is not API verification. If configured, add `Authorization: Bearer ...` to every request without committing it in scripts or placing it in a URL.
3. Create a conversation:

   ```sh
   curl -sS -X POST http://127.0.0.1:3000/v1/conversations \
     -H 'Content-Type: application/json' -d '{"title":"Live smoke"}'
   ```

4. Replace `CONVERSATION_ID` in the following command with the returned id:

   ```sh
   curl -sS -X POST http://127.0.0.1:3000/v1/conversations/CONVERSATION_ID/turns \
     -H 'Content-Type: application/json' \
     -d '{"requestId":"live-text-1","message":"Sig kort hej på dansk.","text":true,"speech":false}'
   ```

5. GET the returned eventsUrl with `curl -N`. Verify actual `text.updated` frames and `turn.completed`, then GET message history and compare the exact complete text. Stop curl after the terminal event. A turn failure is not a successful smoke test; inspect the stable error code and model access.
6. With Fish configured, POST `/v1/turns/TURN_ID/speech` with `{"requestId":"live-speech-1"}` and reconnect to the turn events. Expect `speech.batch`, ordered `audio.available`, then `speech.completed` with `speechStatus: completed`. Download an audio URL, verify nonempty MP3 in your player, and confirm the spoken voice. Do not assume mocked audio bytes establish decodability or voice correctness.
7. Send a longer answer and cancel while active. Verify text status cancellation or completed text with cancelled speech, absence of late audio, and local playback/queue stopping in your interface. Start another turn and verify old IDs are ignored.
8. Stop/restart the server; history should persist, audio URLs should expire/404, and any previously active work should be interrupted without a new provider call. Delete the smoke conversation. No remote deployment is part of this procedure.

No live provider requests were run during implementation. Automated tests exercise SDK requests with mocked fetch, injected provider streams, database persistence, ownership, deadlines, cancellation/stale audio, ordering, memory deletion, exact-action approval, redaction, bounded 429 retries, non-retry of ambiguous failures, and actual local SSE replay/disconnection.

## Reusable cloud workflow

Use the existing checkout `/workspace/stemme`; each cloud task is isolated, so do not create a worktree unless explicitly requested. Node 24 and dependencies are retained in the environment snapshot; live server processes are not. From the checkout run `npm ci` when dependencies need refreshing, `npm run typecheck`, `npm test`, and `npm run build`. Start using `npm start` or `npm run dev` and validate health plus a representative API operation. Keep the server bound locally for development. Cloud onboarding uses local requests for verification and does not expose a browser preview.
