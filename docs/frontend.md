# Connect your interface

A ready-to-use Danish interface is now included in `public/` and served at `/` by `npm start`. The guide below remains useful for connecting a different interface. No separate frontend server/build is required for the included interface.

Your interface owns microphone access, playback, and UI. The server accepts text only; there is no transcription endpoint. Use JSON fetches for commands and SSE fetch streaming for events. Keep Groq/Fish keys on the server. In a remote deployment, an authenticated backend-for-frontend should hold server credentials rather than shipping a shared API token in public JavaScript.

## Minimal flow

```js
const base = 'http://127.0.0.1:3000'; // local development only
const headers = { 'Content-Type': 'application/json' };
// If API_TOKEN is configured, add Authorization: Bearer <your local token>.
async function json(path, body, method = 'POST') {
  const response = await fetch(base + path, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  if (!response.ok) throw await response.json();
  return response.status === 204 ? undefined : response.json();
}
const conversation = await json('/v1/conversations', { title: 'My assistant' });
const turn = await json(`/v1/conversations/${conversation.id}/turns`, {
  requestId: crypto.randomUUID(), message: 'Hej! Svar kort på dansk.', text: true, speech: false
});
// Persist turn.turnId, turn.responseId and turn.eventsUrl before subscribing.
```

Use the same requestId and identical body when a POST's network result is uncertain. Never assign a new ID automatically to retry a chargeable operation. Restore history after a refresh, then resume event replay from your last processed cursor. Deduplicate events by event ID and do not append replayed deltas to an already fully hydrated response. A simple strategy is to rebuild a response from replay starting at 0; alternatively keep a cursor **together with** the exact text assembled through that cursor.

## SSE consumer (browser fetch, supports authorization)

Native EventSource cannot set an Authorization header. Use fetch streaming when a bearer token is configured. This reader handles UTF-8 boundaries, multiline data and incomplete frames; backend frames use LF delimiters.

```js
async function consumeSSE(path, { after = 0, signal, onEvent, authorization }) {
  const response = await fetch(base + path, {
    signal,
    headers: {
      ...(authorization ? { Authorization: authorization } : {}),
      'Last-Event-ID': String(after)
    }
  });
  if (!response.ok) throw await response.json();
  if (!response.body) throw new Error('No stream');
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        let id, type = 'message';
        const data = [];
        for (const line of frame.split('\n')) {
          if (line.startsWith('id: ')) id = Number(line.slice(4));
          if (line.startsWith('event: ')) type = line.slice(7);
          if (line.startsWith('data: ')) data.push(line.slice(6));
        }
        if (id !== undefined && id > after && data.length) {
          await onEvent({ id, type, data: JSON.parse(data.join('\n')) });
          after = id; // persist only after successful processing
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return after;
}
```

Keep the last successfully processed ID in your own state inside `onEvent` as well, so it survives exceptions or disconnection. Reconnect with capped backoff only for transport failures; a stream disconnect does not authorize a new turn request. The server closes connections after five minutes. Close your reader once the expected terminal event is handled (abort its fetch controller). Closing SSE leaves the generation running; POST cancellation to actually stop server work.

## Text and audio state

Maintain `activeConversationId`, `activeTurnId`, `activeResponseId`, `activeSpeechId`, last event ID, next audio sequence and a playback queue. Every event has conversation/turn/response identifiers: discard events whose IDs no longer match the active answer.

- Append `text.updated.delta` to the response identified by `responseId`.
- On `speech.batch`, switch to its `speechId` and reset audio sequencing for that batch.
- On `audio.available`, check all IDs, then GET `url` with the same authentication headers. It returns a complete `audio/mpeg` segment. Fetch as Blob, create an object URL and play in `sequence` order, keyed by `(responseId,speechId,sequence)`. Recheck active IDs **after** asynchronous download before enqueueing. Respect browser autoplay rules; playback should follow a user gesture.
- `text.completed` means text is durable; optional speech may still run. `speech.failed` does not erase displayed text. `turn.completed` includes both statuses. `turn.failed` can still leave useful partial text, or completed text if only speech timed out.
- Explicit separate speech: POST `/v1/turns/:tid/speech` with a new requestId, then subscribe/reuse the turn event stream. Track `speech.batch` and finish on `speech.completed` or cancellation. For a first request, opening/replaying from 0 is safe if you deduplicate and keep speech batches separate; otherwise resume from your saved event cursor.
- After downloading/playing a segment, revoke its object URL when no longer needed. Expired URLs return 404; do not automatically regenerate chargeable speech.

To stop or interrupt an answer, **first** pause current playback, clear its source, discard queued segments, revoke their object URLs, abort pending audio fetches and invalidate local response/batch IDs. Then POST `/v1/turns/:tid/cancel`. Do the same immediately when starting another message, even if the old turn is already completed on the server. Server cancellation cannot stop audio already downloaded or buffered in the browser. Handle `turn.cancelled`, `turn.interrupted` and `audio.cancelled` by clearing local playback state as well.

## User-controlled memory and tools

Show memory changes for explicit user confirmation; then call memory writes with `approved:true` and a human-readable `source` such as `User requested this on 2026-10-31`. Memory use is off per conversation until toggled with `{memoryEnabled:true}`. Provide inspect, edit, delete and disable controls using the documented endpoints. Do not save credentials or let model text silently create memories.

For future tools, list `/v1/tools`, render known schemas, then propose a tool action. Present its **stored exact name and arguments** for approval. Send the returned fingerprint to `/approve` only after the user confirms that action, then `/execute`. Read-only tools need no approval; state-changing tools are refused without it. On timeout/unknown outcome, reconcile the external system before proposing anything new. Model statements are not action results. Default clock example has no external side effects. The registry deliberately does not assume your selected Groq model supports tools or structured outputs.
