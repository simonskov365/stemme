# API v1

All routes start with `/v1`. JSON request bodies use `Content-Type: application/json`; audio downloads return binary `audio/mpeg`. IDs are UUID strings; pagination cursors and SSE event IDs are integers. All routes, including audio, health and SSE, require `Authorization: Bearer <API_TOKEN>` when configured. The single authenticated principal is the server's `OWNER_ID`. Client-provided owner fields are rejected or ignored; no route can select another owner.

Errors use `{ "error": { "code": "STABLE_CODE", "message": "Readable message", "requestId": "uuid" } }`. Codes include `VALIDATION_ERROR`, `NOT_FOUND`, `UNAUTHORIZED`, `ORIGIN_FORBIDDEN`, `HOST_FORBIDDEN`, `RATE_LIMITED`, `TEXT_NOT_CONFIGURED`, `SPEECH_DISABLED`, `IDEMPOTENCY_CONFLICT`, `CONTEXT_LIMIT`, `OUTPUT_LIMIT`, `TEXT_INTERRUPTED`, `TEXT_PROVIDER_ERROR`, `PROVIDER_AUTH`, `TIMEOUT`, `APPROVAL_REQUIRED`, `APPROVAL_MISMATCH`. Raw provider errors and credentials are not forwarded. Unknown IDs and objects owned by another principal both produce 404. Invalid UUIDs produce 400.

## Conversations and history

| Method and path | Request | Result |
| --- | --- | --- |
| `POST /conversations` | `{ "title"?: string }`, default `New conversation`, 1–200 characters | 201 conversation |
| `GET /conversations?limit=50&after=0` | limit 1–100, nonnegative row cursor | `{items: Conversation[]}` |
| `PATCH /conversations/:cid` | `{ "title"?: string, "memoryEnabled"?: boolean }` | updated conversation |
| `DELETE /conversations/:cid` | none | 204; stops work and removes related data |
| `GET /conversations/:cid/messages?limit=50&after=0` | same pagination | `{items: Message[]}` in insertion order |

Conversation: `{id, owner, title, memory_enabled: 0|1, created_at}`. List responses also contain `cursor`. Message: `{id, conversation_id, turn_id, owner, role: "user"|"assistant", content, status, created_at, cursor}`. Timestamps are ISO UTC. Pass the last item's `cursor` as `after` for the next page; an empty page ends pagination. Message status is `running`, `completed`, `cancelled`, `interrupted` or `failed`. User messages remain completed even if the associated assistant response fails.

Deleting a conversation deletes its turns, messages, derived summaries and replay events (SQL foreign-key cascades), and invalidates its transient audio. Explicitly saved long-term memories are independent and remain until deleted through the memory API. Tool actions are independent audit records and remain in SQLite. There is no recording storage.

## Turns and speech

| Method and path | Request | Result |
| --- | --- | --- |
| `POST /conversations/:cid/turns` | `{requestId, message, text?: true, speech?: false}` | 202 `{turnId,responseId,status,eventsUrl}` |
| `GET /turns/:tid` | none | persisted turn |
| `GET /turns/:tid/events?after=0` | optional `Last-Event-ID` header, which overrides `after` | SSE stream, replay then live |
| `POST /turns/:tid/cancel` | none | persisted turn after cancellation |
| `POST /turns/:tid/speech` | `{requestId}` | 202 `{turnId,responseId,requestId,status}` |
| `GET /audio/:aid` | none | 200 MP3 bytes; 404 after expiry/cancellation/restart |

`requestId`: 1–100 ASCII letters, digits, underscores or hyphens; use a client UUID. `message`: trimmed nonempty string, at most 32,000 characters and the configured conservative context byte limit. Unknown fields are rejected. `text` and `speech` are independent: `text=true,speech=false` produces text; both true produce text followed by speech; both false save only the user's message. For `text=false,speech=true`, use the existing-response speech endpoint instead (the turn endpoint returns `USE_RESPONSE_SPEECH`). It speaks the completed assistant message linked by the turn's `response_id`. Cancel that same turn to stop pending speech. Separate speech requests do not generate new text.

Repeated turn requests with the same owner/conversation/requestId and identical normalized body return the same turn. A changed body produces 409. Speech requests with the same turn/requestId never regenerate audio, even after expiration or failure: use a **new** requestId only for an intentional new chargeable request. There is no automatic provider retry after an ambiguous failure. Initial explicit Groq 429 rejections retry at most twice with capped delay (250–5000 ms), within the turn deadline. No 5xx, network-error, partial-stream or Fish Audio retries.

Persisted turn: `{id, conversation_id, owner, request_key, fingerprint, response_id, status, speech_status, created_at}`. GET `/turns/:tid` additionally includes `event_cursor` (latest persisted SSE event id) and `speech_cursor` (latest separate speech start, or 0 for the initial streamed speech). Capture `event_cursor` before a new speech-only POST and subscribe after that cursor so old terminal events do not end the new audio subscription. Text status is `running|completed|cancelled|interrupted|failed`; speech status additionally includes `disabled`. Starting a new message in the same conversation interrupts running text or speech. Already completed text stays completed when speech is stopped or fails. A provider output-limit finish is a failed/partial response, not false completion. After restart, in-progress work becomes interrupted and is never automatically recharged.

## SSE protocol

Each event is one SSE frame:

```text
id: 42
event: text.updated
data: {"conversationId":"...","turnId":"...","responseId":"...","delta":"Hello"}

```

All event payloads contain `conversationId`, `turnId`, `responseId`. IDs are persisted, globally increasing within the database; gaps are allowed. Preserve the most recent successfully processed event ID for reconnection. Replay is durable until conversation deletion. The stream remains open after completion to allow separate speech requests. Close it when finished; connections have a five-minute maximum lifetime and 15-second comment heartbeats. Slow consumers are disconnected and can replay. Disconnecting a stream does **not** cancel generation or retry a provider call.

| Event | Additional payload / meaning |
| --- | --- |
| `turn.started` | stable turn and response identifiers |
| `text.updated` | `delta`: append exactly once |
| `text.completed` | full displayed text is persisted |
| `speech.batch` | `speechId`: new audio batch, including for separate speech requests |
| `speech.started` | `requestId`: separate speech job started |
| `audio.available` | `audioId,speechId,sequence,totalSegments,url,contentType,expiresAt` |
| `speech.failed` | `error:{code,message}`; text remains usable |
| `speech.finished` | `speechId,totalSegments,speechStatus`: final audio count after the sentence queue drains |
| `speech.completed` | `speechStatus`: separate speech job finished; can be `failed` |
| `tool.activity` | `actionId,name,status`: explicitly proposed tool action |
| `turn.completed` | `textStatus,speechStatus`; speech may be failed independently |
| `turn.cancelled` | active work explicitly cancelled |
| `turn.interrupted` | replaced by a newer message or service shutdown |
| `audio.cancelled` | completed turn's queued audio invalidated on explicit cancel |
| `turn.failed` | `error:{code,message},textStatus`; partial or completed text remains in history |

Audio generation starts with the first stable sentence while text generation continues. A single sequential speech queue preserves sentence order without blocking text. The first segment is short (up to about 240 characters); later sentences are grouped toward 180–450 characters, with long sentences split at complete word boundaries. Raw token fragments, incomplete Markdown links and fenced code blocks are not spoken. Markdown is cleaned only for speech. `totalSegments` on `audio.available` is `null` because the response is still being written; `speech.finished` provides the final segment count. Provider latency and gaps between independently synthesized segments remain possible. If text generation subsequently fails, pending speech is aborted and transient audio is invalidated; the frontend also stops buffered playback. Audio already heard cannot be recalled. Each URL contains one independently playable MP3 file (not arbitrary MP3 byte fragments). Sequence starts at zero **per speechId**. Files live in memory, not on disk, for `AUDIO_TTL_SECONDS` (default 300); total buffered audio is capped at 64 MiB, each provider segment at 8 MiB. Expired audio can still appear in replay events: fetch can return 404. IDs and metadata persist, bytes do not. Cancel removes bytes immediately; restart loses all bytes. No binary audio is encoded into SSE.

## Memory

| Method and path | Request | Result |
| --- | --- | --- |
| `GET /memories` | none | `{items: Memory[]}` for this owner |
| `POST /memories` | `{content,source,approved:true}` | 201 memory |
| `PATCH /memories/:mid` | same full body | updated memory |
| `DELETE /memories/:mid` | none | 204 |

Memory: `{id,owner,content,source,created_at,updated_at}`. Content is 1–2000 characters, source 1–300. No implicit memory extraction exists. Only call write endpoints following an explicit user request or an approval in your interface; `approved:true` is mandatory. Enable use independently per conversation with `memoryEnabled:true`; default false. To stop using all memories, disable memory in each relevant conversation, or delete the memories. At most the latest 20 approved memories enter context. Changing or disabling memory takes effect on the next turn, not an already submitted provider request. A pattern filter rejects common credential assignments; it cannot identify every arbitrary password. Never ask users to store credentials here. Provider keys are never read into memory automatically.

Context counts UTF-8 bytes plus overhead as a conservative token upper estimate, subtracting output allowance and headroom. It preserves recent messages, includes only completed assistant responses, and adds a size-bounded **lossy excerpt digest** of older content when space remains. This is not a semantic LLM summary. Digests are explicitly marked derived/error-prone/untrusted and stored separately. Too-large system, memory or latest-message content fails with `CONTEXT_LIMIT`. Set `CONTEXT_TOKENS` to the selected model's actual context capacity or lower; the backend cannot discover model-specific limits without your configuration.

## Tools

| Method and path | Request | Result |
| --- | --- | --- |
| `GET /tools` | none | `{items:[{name,description,classification,timeoutMs,inputSchema}]}` |
| `POST /tool-actions` | `{name,args,requestId,turnId?}` | proposed action |
| `GET /tool-actions/:aid` | none | action |
| `POST /tool-actions/:aid/approve` | `{fingerprint,approved:true}` | approved exact action |
| `POST /tool-actions/:aid/execute` | none | result or current action |

Action: `{id,name,args,fingerprint,approved,status,result}`. Result is `{ok:true,data}` or `{ok:false,error:{code,message}}`. Status: `proposed|running|completed|failed`. Default registry is empty to clients; enable `clock` in `ENABLED_TOOLS` to expose the harmless `{}`-input UTC-time tool. Arbitrary tool names/arguments are refused. Only server-registered tools can execute. State-changing tools require an approval bound to persisted action ID, owner, name and argument hash. UI must show the exact stored args before approval. Model prose never counts as approval. Execution is at-most-once: a timeout/crash may have an unknown external outcome and must be reconciled manually; the same action never runs again. A handler must respect AbortSignal; a timeout is not rollback. Do not add a shell tool or unrestricted URL/filesystem handler. `turnId` only associates a proposal activity event; tools do not automatically enter model context or generate follow-up answers.

## Health and limits

`GET /health` returns `{status:"ok",providers:{text:"configured-unverified"|"not-configured",speech:"configured-unverified"|"disabled"},transcription:"configured-unverified"|"not-configured"}`. No live provider calls occur. Request body cap: 64 KiB. Global limit: 120 requests/minute/IP; turn creation: 20/minute/IP; separate speech: 10/minute/IP. Trusted proxies are not enabled by default. Keep one backend process per SQLite file; startup recovery assumes exclusive application ownership.

## Microphone transcription

`POST /v1/transcriptions` accepts a raw audio body with Content-Type `audio/webm`, `audio/mp4`, `audio/ogg`, `audio/wav` or `audio/mpeg` (codec parameters allowed). Authentication/ownership is the same single server principal as other API routes. Required header: `X-Request-Id: <UUID>`. Optional header: `X-Audio-Language: da|en`; omit for automatic recognition. File signatures and maximum size (default `TRANSCRIPTION_MAX_BYTES=8388608`) are validated before the provider call. JSON/base64 uploads are not accepted.

Successful response: `{text:"recognized words",requestId:"uuid"}`. It does not create a conversation or message. The frontend separately submits the transcript through the existing turn endpoint. Provider: Groq `/openai/v1/audio/transcriptions`, multipart fields `file`, `model` (configured `GROQ_TRANSCRIPTION_MODEL`, default `whisper-large-v3-turbo`), `response_format=json`, and optional `language`. No provider retry occurs. Empty recognition returns `NO_SPEECH` (422); other codes include `INVALID_AUDIO` (415), `AUDIO_LIMIT` (413), `TRANSCRIPTION_BUSY` (429), `TRANSCRIPTION_NOT_CONFIGURED` (503), `TRANSCRIPTION_CANCELLED` (408) and `TRANSCRIPTION_PROVIDER_ERROR` (502).

A repeated request with the same owner/id/type/language/audio hash returns the original in-flight/result/error while in the bounded 30-minute cache. Different data gives 409. Failed or ambiguous calls are not re-executed under the same key. Cache is in-memory and lost on restart; it is not a durable exactly-once guarantee. Keep the same request id for uncertain outcomes and reconcile instead of blindly resubmitting after server restart. At most two transcription requests run concurrently and 256 cache entries are retained. Endpoint limit: 10 requests/minute/IP, independently of Groq's speech quota. Client disconnection aborts pending provider work. Raw audio buffers are transient; the cache retains only text, hash and status until expiry/next cleanup. No transcription/audio files are written.

## Kontinuitetsdokument / Nyra

Se [Nyra-API og dataregler](nyra.md). GET /v1/health inkluderer nu assistantName (den aktive godkendte profils navn eller det konfigurerede standardnavn). Profilen er uafhængig af samtalernes opt-in til manuelt gemte minder. Aktive profiler anvender begrænsede, lokale søgeuddrag i genereringskonteksten; rå kildeinstruktioner er aldrig værktøjsautorisation. Præcise sync up/sync mood-beskeder genlæser en aktiv Google-kilde før svargenerering; ingen modelkald starter, hvis den anmodede sync fejler.
