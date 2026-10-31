/** Durable SSE reader: reconnect with the last event the caller accepted. */
export async function readEvents(response, onEvent, signal) {
  if (!response.ok || !response.body)
    throw new Error("Forbindelsen til svaret blev afbrudt.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        let id = 0,
          type = "message";
        const data = [];
        for (const line of frame.split("\n")) {
          if (line.startsWith("id: ")) id = Number(line.slice(4));
          if (line.startsWith("event: ")) type = line.slice(7);
          if (line.startsWith("data: ")) data.push(line.slice(6));
        }
        if (id && data.length && !signal.aborted) {
          if (
            (await onEvent({ id, type, data: JSON.parse(data.join("\n")) })) ===
            false
          )
            return;
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
