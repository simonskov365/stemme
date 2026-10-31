import { readEvents } from "./stream.js";
let voice;
const $ = (id) => document.getElementById(id);
const state = {
  token: "",
  conversations: [],
  conversation: null,
  messages: [],
  active: null,
  generation: 0,
  ready: false,
  speech: false,
  voiceAvailable: false,
  transcription: false,
  pending: null,
  posting: false,
  navigating: false,
  selection: 0,
};
const player = $("player");
const errorMessages = {
  TEXT_NOT_CONFIGURED: "Tekstsvar er ikke konfigureret på serveren endnu.",
  SPEECH_DISABLED: "Talte svar er slået fra på serveren.",
  PROVIDER_AUTH: "Serveren kunne ikke godkendes hos teksttjenesten.",
  RATE_LIMITED:
    "Der er sendt for mange forespørgsler. Vent lidt, og prøv igen.",
  OUTPUT_LIMIT: "Svaret nåede sin længdegrænse. Den modtagne tekst er gemt.",
  TIMEOUT: "Svaret tog for lang tid. Den modtagne tekst er gemt.",
  CONTEXT_LIMIT:
    "Samtalen eller beskeden er for lang. Prøv en ny samtale eller en kortere besked.",
  SPEECH_PROVIDER_ERROR:
    "Stemmetjenesten kunne ikke levere lyd. Dit tekstsvar er stadig gemt.",
  NOT_FOUND: "Indholdet findes ikke længere. Lydfiler udløber efter kort tid.",
};
function notify(message, retry = false) {
  $("notice-text").textContent = message;
  $("notice").hidden = false;
  $("retry-send").hidden = !retry;
}
function errorText(e) {
  return (
    errorMessages[e.code] ?? e.message ?? "Noget gik galt. Prøv igen om lidt."
  );
}
function headers(json = false) {
  return {
    ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
    ...(json ? { "Content-Type": "application/json" } : {}),
  };
}
async function api(path, method = "GET", payload) {
  let r;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    r = await fetch(path, {
      signal: controller.signal,
      method,
      headers: headers(payload !== undefined),
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
  } catch {
    throw Object.assign(
      new Error("Forbindelsen blev afbrudt. Prøv igen med samme besked."),
      { network: true },
    );
  } finally {
    clearTimeout(timeout);
  }
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    const e = Object.assign(
      new Error("Serveren kunne ikke gennemføre forespørgslen."),
      data.error ?? {},
      { status: r.status },
    );
    if (r.status === 401) {
      $("settings-dialog").showModal();
      $("api-token").focus();
      throw Object.assign(e, {
        message: "Indtast serverens adgangskode under indstillinger.",
      });
    }
    throw e;
  }
  return r.status === 204 ? null : r.json();
}
async function pages(path) {
  const result = [];
  let after = 0;
  for (;;) {
    const r = await api(`${path}?limit=100&after=${after}`);
    result.push(...r.items);
    if (r.items.length < 100) break;
    after = r.items.at(-1).cursor;
  }
  return result;
}
function connection(text, failed = false) {
  $("connection").replaceChildren();
  const dot = document.createElement("i");
  $("connection").append(dot, document.createTextNode(text));
  $("connection").classList.toggle("error", failed);
}
function controls() {
  $("send").disabled =
    !state.ready ||
    state.posting ||
    state.navigating ||
    !$("message-input").value.trim();
  const a = state.active;
  const busy =
    state.posting ||
    (!!a && (!a.done || a.loading > 0 || a.queue.size > 0 || !!a.currentUrl));
  $("stop-generation").hidden = !busy;
  $("speech-enabled").disabled = !state.speech || !!voice?.enabled;
  $("voice-start").disabled =
    !state.ready ||
    !state.speech ||
    !state.voiceAvailable ||
    !state.transcription;
  $("voice-start").hidden = !!voice?.enabled;
  if (voice?.enabled) voice.update();
  $("rename-chat").hidden = !state.conversation;
  $("delete-chat").hidden = !state.conversation;
  document.body.classList.toggle("in-conversation", state.messages.length > 0);
  const activity =
    !player.paused && !player.ended
      ? "speaking"
      : voice?.enabled && voice.phase === "listening"
        ? "listening"
        : !state.ready
          ? "offline"
          : state.posting || (a && !a.done)
            ? "thinking"
            : "idle";
  document.documentElement.dataset.assistantState = activity;
  $("orb-status").textContent = {
    speaking: "Stemme taler",
    thinking: "Et øjeblik …",
    idle: "Klar til dig",
    offline: "Afventer forbindelse",
    listening: "Jeg lytter",
  }[activity];
}
function scrollBottom() {
  const w = $("workspace");
  w.scrollTop = w.scrollHeight;
}
function nearBottom() {
  const w = $("workspace");
  return w.scrollHeight - w.scrollTop - w.clientHeight < 130;
}
function sidebar(open) {
  $("sidebar").classList.toggle("open", open);
  $("sidebar-shade").hidden = !open;
  $("menu-toggle").setAttribute("aria-expanded", String(open));
}
function renderConversations() {
  $("conversations").replaceChildren();
  $("conversation-count").textContent = String(state.conversations.length);
  if (!state.conversations.length) {
    const p = document.createElement("p");
    p.className = "sidebar-empty";
    p.textContent = "Dine samtaler finder et hjem her.";
    $("conversations").append(p);
  }
  for (const c of [...state.conversations].reverse()) {
    const b = document.createElement("button");
    b.className =
      "conversation-item" + (state.conversation?.id === c.id ? " active" : "");
    b.setAttribute(
      "aria-current",
      state.conversation?.id === c.id ? "page" : "false",
    );
    const title = document.createElement("span");
    title.textContent = c.title;
    b.append(title);
    b.onclick = () =>
      void selectConversation(c).catch((e) => notify(errorText(e)));
    $("conversations").append(b);
  }
}
function updateMessage(m) {
  const el = $("messages").querySelector(`[data-message-id="${m.id}"]`);
  if (!el) return;
  el.querySelector(".message-content").textContent = m.content;
  el.querySelector(".message-content").classList.toggle(
    "pending",
    m.status === "running",
  );
  const meta = el.querySelector(".message-meta");
  meta.replaceChildren();
  const labels = {
    running: "Skriver …",
    cancelled: "Stoppet",
    interrupted: "Afbrudt",
    failed: "Svaret blev ikke afsluttet",
  };
  if (labels[m.status]) {
    const s = document.createElement("span");
    s.textContent = labels[m.status];
    meta.append(s);
  }
  if (
    m.role === "assistant" &&
    m.status === "completed" &&
    m.content &&
    state.speech
  ) {
    const b = document.createElement("button");
    b.className = "message-action";
    b.textContent = "♫ Læs op";
    b.onclick = () => void speakMessage(m).catch((e) => notify(errorText(e)));
    meta.append(b);
  }
}
function renderMessages() {
  $("welcome").hidden = state.messages.length > 0;
  $("messages").hidden = !state.messages.length;
  $("messages").replaceChildren();
  for (const m of state.messages) {
    const el = document.createElement("article");
    el.className = "message " + m.role;
    el.dataset.messageId = m.id;
    const role = document.createElement("div");
    role.className = "message-role";
    role.textContent = m.role === "user" ? "Dig" : "Stemme";
    const content = document.createElement("div");
    content.className = "message-content";
    const meta = document.createElement("div");
    meta.className = "message-meta";
    el.append(role, content, meta);
    $("messages").append(el);
    updateMessage(m);
  }
  $("room-name").textContent =
    state.conversation?.title ?? "Din personlige assistent";
  renderConversations();
  controls();
}
function cleanAudio(a) {
  if (!a) return;
  a.audioController.abort();
  player.pause();
  player.removeAttribute("src");
  player.load();
  resetVoice();
  if (a.currentUrl) URL.revokeObjectURL(a.currentUrl);
  a.currentUrl = null;
  for (const url of a.queue.values()) URL.revokeObjectURL(url);
  a.queue.clear();
  $("audio-tray").hidden = true;
}
function isActive(a) {
  return state.active === a && !a.cancelled;
}
function stopActive(cancel = true) {
  const a = state.active;
  state.generation++;
  if (!a) return;
  a.cancelled = true;
  a.streamController.abort();
  cleanAudio(a);
  state.active = null;
  if (cancel && !a.done && a.turnId)
    void api(`/v1/turns/${a.turnId}/cancel`, "POST").catch((e) =>
      notify(errorText(e)),
    );
  const m = state.messages.find((m) => m.id === a.responseId);
  if (m?.status === "running") {
    m.status = "cancelled";
    updateMessage(m);
  }
  controls();
}
function newActive(turnId, responseId, speechOnly = false) {
  const a = {
    turnId,
    responseId,
    speechOnly,
    streamController: new AbortController(),
    audioController: new AbortController(),
    speechId: null,
    queue: new Map(),
    next: 0,
    currentUrl: null,
    loading: 0,
    done: false,
    cancelled: false,
    cursor: 0,
  };
  state.active = a;
  controls();
  return a;
}
async function playNext(a) {
  if (!isActive(a) || a.currentUrl || !a.queue.has(a.next)) return;
  const url = a.queue.get(a.next);
  a.queue.delete(a.next);
  a.currentUrl = url;
  a.next++;
  player.src = url;
  $("audio-tray").hidden = false;
  $("audio-label").textContent = "Stemme læser op";
  controls();
  try {
    await player.play();
  } catch {
    if (isActive(a))
      $("audio-label").textContent = "Tryk ▶ for at høre svaret";
  }
}
player.addEventListener("ended", () => {
  const a = state.active;
  if (!a) return;
  if (a.currentUrl) URL.revokeObjectURL(a.currentUrl);
  a.currentUrl = null;
  if (!a.queue.size && a.done && a.loading === 0) $("audio-tray").hidden = true;
  void playNext(a);
  controls();
});
player.addEventListener("error", () => {
  if (state.active?.currentUrl)
    notify(
      "Lyden kunne ikke afspilles i browseren. Dit tekstsvar er stadig tilgængeligt.",
    );
});
async function loadAudio(a, data) {
  const batch = a.speechId;
  if (
    !batch ||
    batch !== data.speechId ||
    data.sequence < a.next ||
    a.queue.has(data.sequence)
  )
    return;
  a.loading++;
  controls();
  try {
    const r = await fetch(data.url, {
      headers: headers(),
      signal: a.audioController.signal,
    });
    if (!r.ok) throw new Error("Lydfilen er udløbet eller kunne ikke hentes.");
    const blob = await r.blob();
    if (!isActive(a) || a.speechId !== batch) return;
    const url = URL.createObjectURL(blob);
    a.queue.set(data.sequence, url);
    await playNext(a);
  } catch (e) {
    if (isActive(a) && !a.audioController.signal.aborted) notify(errorText(e));
  } finally {
    a.loading--;
    controls();
  }
}
function applyEvent(a, event) {
  if (!isActive(a) || event.id <= a.cursor) return false;
  const d = event.data;
  if (d.turnId !== a.turnId || d.responseId !== a.responseId) return true;
  a.cursor = event.id;
  const m = state.messages.find((m) => m.id === a.responseId);
  const follow = nearBottom();
  if (event.type === "text.updated" && m && !a.speechOnly) {
    m.content += d.delta;
    updateMessage(m);
  }
  if (event.type === "text.completed" && m && !a.speechOnly) {
    m.status = "completed";
    updateMessage(m);
  }
  if (event.type === "speech.batch") {
    cleanAudio(a);
    a.audioController = new AbortController();
    a.speechId = d.speechId;
    a.next = 0;
  }
  if (event.type === "audio.available") void loadAudio(a, d);
  if (event.type === "speech.failed") {
    voice?.stop();
    notify("Talte svar kunne ikke genereres. Du kan stadig læse svaret.");
  }
  const terminal =
    [
      "turn.cancelled",
      "turn.interrupted",
      "turn.failed",
      "audio.cancelled",
    ].includes(event.type) ||
    (!a.speechOnly && event.type === "turn.completed") ||
    (a.speechOnly &&
      ["speech.completed", "speech.finished"].includes(event.type));
  if (terminal) {
    a.done = true;
    if (
      ["turn.cancelled", "turn.interrupted", "audio.cancelled"].includes(
        event.type,
      )
    ) {
      cleanAudio(a);
      if (m && m.status === "running")
        m.status =
          event.type === "turn.interrupted" ? "interrupted" : "cancelled";
    }
    if (event.type === "turn.failed") {
      voice?.stop();
      if (d.textStatus !== "completed") cleanAudio(a);
      if (m && m.status === "running")
        m.status = d.textStatus === "completed" ? "completed" : "failed";
      notify(
        errorMessages[d.error?.code] ??
          "Svaret blev afbrudt. Den modtagne tekst er gemt.",
      );
    }
    if (event.type === "turn.completed" && m && m.status === "running")
      m.status = "completed";
    if (m) updateMessage(m);
    controls();
    if (follow) scrollBottom();
    return false;
  }
  controls();
  if (follow) scrollBottom();
  return true;
}
async function streamTurn(a) {
  // Transport reconnects only; never repeat a generation POST here.
  for (let attempt = 0; attempt < 4 && isActive(a) && !a.done; attempt++) {
    try {
      const r = await fetch(`/v1/turns/${a.turnId}/events`, {
        headers: { ...headers(), "Last-Event-ID": String(a.cursor) },
        signal: a.streamController.signal,
      });
      if (r.status === 401)
        throw new Error(
          "Serverens adgangskode blev afvist. Åbn indstillinger.",
        );
      await readEvents(r, (e) => applyEvent(a, e), a.streamController.signal);
      if (a.done || !isActive(a)) return;
    } catch (e) {
      if (!isActive(a) || a.streamController.signal.aborted) return;
      if (attempt === 3) {
        notify(
          "Forbindelsen til svaret blev afbrudt. Åbn samtalen igen for at hente det gemte svar.",
        );
        return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
  }
}
async function selectConversation(c) {
  if (state.posting) return;
  voice?.stop();
  stopActive();
  const selection = ++state.selection;
  state.navigating = true;
  controls();
  try {
    state.pending = null;
    $("notice").hidden = true;
    const messages = await pages(`/v1/conversations/${c.id}/messages`);
    if (selection !== state.selection) return;
    state.conversation = c;
    state.messages = messages;
    renderMessages();
    sidebar(false);
    scrollBottom();
    const last = [...messages].reverse().find((m) => m.role === "assistant");
    if (last) {
      const t = await api(`/v1/turns/${last.turn_id}`);
      if (selection !== state.selection) return;
      if (t.status === "running" || t.speech_status === "running") {
        const onlySpeech = t.status === "completed";
        const a = newActive(t.id, t.response_id, onlySpeech);
        if (onlySpeech) a.cursor = t.speech_cursor;
        else last.content = "";
        last.status = t.status === "running" ? "running" : "completed";
        updateMessage(last);
        void streamTurn(a);
      }
    }
  } finally {
    if (selection === state.selection) {
      state.navigating = false;
      controls();
    }
  }
}
async function send(retry = false) {
  const message = $("message-input").value.trim();
  if (state.posting || state.navigating || !state.ready || (!retry && !message))
    return;
  stopActive();
  const generation = state.generation;
  state.posting = true;
  controls();
  $("notice").hidden = true;
  let pending = retry ? state.pending : null;
  try {
    if (!pending) {
      if (!state.conversation) {
        const c = await api("/v1/conversations", "POST", {
          title: message.slice(0, 65),
        });
        state.conversations.push(c);
        state.conversation = c;
      }
      pending = {
        cid: state.conversation.id,
        body: {
          requestId: crypto.randomUUID(),
          message,
          text: true,
          speech: $("speech-enabled").checked,
        },
        optimisticId: crypto.randomUUID(),
      };
      state.pending = pending;
      state.messages.push({
        id: pending.optimisticId,
        role: "user",
        content: message,
        status: "completed",
      });
      renderMessages();
      scrollBottom();
    }
    const turn = await api(
      `/v1/conversations/${pending.cid}/turns`,
      "POST",
      pending.body,
    );
    state.pending = null;
    $("message-input").value = "";
    resize();
    if (generation !== state.generation) {
      void api(`/v1/turns/${turn.turnId}/cancel`, "POST").catch((e) =>
        notify(errorText(e)),
      );
      return;
    }
    let m = state.messages.find((m) => m.id === turn.responseId);
    if (!m) {
      m = {
        id: turn.responseId,
        turn_id: turn.turnId,
        role: "assistant",
        content: "",
        status: "running",
      };
      state.messages.push(m);
    }
    renderMessages();
    scrollBottom();
    const a = newActive(turn.turnId, turn.responseId);
    void streamTurn(a);
  } catch (e) {
    if (generation === state.generation) {
      notify(errorText(e), Boolean(state.pending));
      if (e.status && e.status < 500) {
        state.messages = state.messages.filter(
          (m) => m.id !== pending?.optimisticId,
        );
        state.pending = null;
        renderMessages();
        $("retry-send").hidden = true;
      }
    }
  } finally {
    state.posting = false;
    controls();
  }
}
async function speakMessage(m) {
  if (state.posting) return;
  stopActive();
  const a = newActive(m.turn_id, m.id, true);
  const requestId = crypto.randomUUID();
  try {
    const current = await api(`/v1/turns/${m.turn_id}`);
    a.cursor = current.event_cursor;
    if (!isActive(a)) return;
    await api(`/v1/turns/${m.turn_id}/speech`, "POST", { requestId });
    if (isActive(a)) void streamTurn(a);
    else
      void api(`/v1/turns/${m.turn_id}/cancel`, "POST").catch((e) =>
        notify(errorText(e)),
      );
  } catch (e) {
    if (isActive(a)) {
      a.done = true;
      controls();
      notify(errorText(e));
    }
  }
}
function resize() {
  const t = $("message-input");
  t.style.height = "auto";
  t.style.height = Math.min(t.scrollHeight, 160) + "px";
  controls();
}
$("message-input").addEventListener("input", () => {
  if (state.pending) {
    state.messages = state.messages.filter(
      (m) => m.id !== state.pending.optimisticId,
    );
    state.pending = null;
    renderMessages();
  }
  resize();
});
$("message-input").addEventListener("keydown", (e) => {
  if (
    e.key === "Enter" &&
    !e.shiftKey &&
    !e.isComposing &&
    matchMedia("(min-width:701px)").matches
  ) {
    e.preventDefault();
    void send();
  }
});
$("composer").onsubmit = (e) => {
  e.preventDefault();
  void send();
};
$("retry-send").onclick = () => void send(true);
$("stop-generation").onclick = () => {
  stopActive();
  controls();
};
$("stop-audio").onclick = () => stopActive();
$("new-chat").onclick = () => {
  if (state.posting) return;
  voice?.stop();
  stopActive();
  state.selection++;
  state.navigating = false;
  state.conversation = null;
  state.messages = [];
  state.pending = null;
  $("notice").hidden = true;
  renderMessages();
  sidebar(false);
  $("message-input").focus();
};
$("menu-toggle").onclick = () =>
  sidebar(!$("sidebar").classList.contains("open"));
$("sidebar-shade").onclick = () => sidebar(false);
$("dismiss-notice").onclick = () => {
  $("notice").hidden = true;
};
for (const b of document.querySelectorAll("[data-prompt]"))
  b.onclick = () => {
    $("message-input").value = b.dataset.prompt;
    resize();
    $("message-input").focus();
  };
function ask({ title, description, value, confirm }) {
  return new Promise((resolve) => {
    const dialog = $("confirm-dialog");
    $("confirm-title").textContent = title;
    $("confirm-description").textContent = description;
    $("confirm-submit").textContent = confirm;
    $("confirm-value").hidden = value === undefined;
    $("confirm-label").hidden = value === undefined;
    $("confirm-value").value = value ?? "";
    $("confirm-value").required = value !== undefined;
    $("confirm-value").maxLength = title === "Rediger hukommelse" ? 2000 : 200;
    function finish(result) {
      dialog.close();
      dialog.removeEventListener("cancel", cancel);
      resolve(result);
    }
    function cancel(e) {
      e.preventDefault();
      finish(null);
    }
    dialog.addEventListener("cancel", cancel);
    $("confirm-cancel").onclick = () => finish(null);
    $("confirm-form").onsubmit = (e) => {
      e.preventDefault();
      finish(value === undefined ? true : $("confirm-value").value.trim());
    };
    dialog.showModal();
  });
}
$("rename-chat").onclick = async () => {
  const c = state.conversation;
  if (!c) return;
  const title = await ask({
    title: "Giv samtalen et navn",
    description: "Et navn, der gør den nem at finde igen.",
    value: c.title,
    confirm: "Gem navn",
  });
  if (!title) return;
  try {
    const updated = await api(`/v1/conversations/${c.id}`, "PATCH", { title });
    Object.assign(c, updated);
    if (state.conversation?.id === c.id) renderMessages();
  } catch (e) {
    notify(errorText(e));
  }
};
$("delete-chat").onclick = async () => {
  const c = state.conversation;
  if (!c) return;
  const yes = await ask({
    title: "Slet samtalen?",
    description:
      "Beskederne og tilhørende lyd slettes. Det, du har gemt som hukommelse, beholdes.",
    confirm: "Slet samtale",
  });
  if (!yes) return;
  try {
    if (state.conversation?.id === c.id) stopActive();
    await api(`/v1/conversations/${c.id}`, "DELETE");
    state.conversations = state.conversations.filter((x) => x.id !== c.id);
    if (state.conversation?.id === c.id) {
      state.conversation = null;
      state.messages = [];
    }
    renderMessages();
  } catch (e) {
    notify(errorText(e));
  }
};
async function loadMemories() {
  const { items } = await api("/v1/memories");
  $("memories").replaceChildren();
  $("memory-count").textContent = items.length;
  if (!items.length) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "Intet gemt endnu. Du bestemmer, hvad der skal huskes.";
    $("memories").append(p);
  }
  for (const m of items) {
    const row = document.createElement("div");
    row.className = "memory-item";
    const p = document.createElement("p");
    p.textContent = m.content;
    const edit = document.createElement("button");
    edit.textContent = "Rediger";
    edit.onclick = async () => {
      const value = await ask({
        title: "Rediger hukommelse",
        description: "Den nye tekst gemmes kun med din godkendelse.",
        value: m.content,
        confirm: "Godkend og gem",
      });
      if (!value) return;
      try {
        await api(`/v1/memories/${m.id}`, "PATCH", {
          content: value,
          source: "Brugeren redigerede og godkendte i Stemme",
          approved: true,
        });
        await loadMemories();
      } catch (e) {
        $("settings-feedback").textContent = errorText(e);
      }
    };
    const remove = document.createElement("button");
    remove.textContent = "Slet";
    remove.onclick = async () => {
      try {
        await api(`/v1/memories/${m.id}`, "DELETE");
        await loadMemories();
      } catch (e) {
        $("settings-feedback").textContent = errorText(e);
      }
    };
    row.append(p, edit, remove);
    $("memories").append(row);
  }
}
$("open-settings").onclick = () => {
  $("memory-enabled").disabled = !state.conversation;
  $("memory-enabled").checked = !!state.conversation?.memory_enabled;
  $("memory-hint").hidden = !!state.conversation;
  $("settings-feedback").textContent = "";
  $("settings-dialog").showModal();
  void loadMemories().catch((e) => {
    $("settings-feedback").textContent = errorText(e);
  });
};
$("close-settings").onclick = () => $("settings-dialog").close();
$("memory-enabled").onchange = async () => {
  const c = state.conversation;
  if (!c) return;
  try {
    const updated = await api(`/v1/conversations/${c.id}`, "PATCH", {
      memoryEnabled: $("memory-enabled").checked,
    });
    Object.assign(c, updated);
    $("settings-feedback").textContent = updated.memory_enabled
      ? "Hukommelse bruges fra din næste besked."
      : "Hukommelse er slået fra i denne samtale.";
  } catch (e) {
    $("memory-enabled").checked = !!c.memory_enabled;
    $("settings-feedback").textContent = errorText(e);
  }
};
$("memory-form").onsubmit = async (e) => {
  e.preventDefault();
  const content = $("memory-content").value.trim();
  if (!content) return;
  const button = e.submitter;
  button.disabled = true;
  try {
    await api("/v1/memories", "POST", {
      content,
      source: "Brugeren gemte og godkendte i Stemme",
      approved: true,
    });
    $("memory-content").value = "";
    await loadMemories();
    $("settings-feedback").textContent = "Gemt med din godkendelse.";
  } catch (e) {
    $("settings-feedback").textContent = errorText(e);
  } finally {
    button.disabled = false;
  }
};
$("token-form").onsubmit = async (e) => {
  e.preventDefault();
  state.token = $("api-token").value;
  $("api-token").value = "";
  await initialize();
  if (state.ready) $("settings-dialog").close();
};
async function initialize() {
  try {
    const health = await api("/v1/health");
    state.ready = health.providers.text !== "not-configured";
    state.speech = health.providers.speech !== "disabled";
    state.transcription = health.transcription === "configured-unverified";
    state.conversations = await pages("/v1/conversations");
    connection(
      state.ready ? "Klar til dig" : "Tekst ikke tilsluttet",
      !state.ready,
    );
    if (!state.speech) $("speech-enabled").checked = false;
    renderConversations();
    controls();
    if (!state.ready)
      notify("Tilføj Groq-indstillingerne på serveren for at få tekstsvar.");
    else if (!state.transcription)
      notify(
        "Tekstchat er klar. Mikrofonen kræver den nye server: stop Stemme med Control+C i det gamle Terminal-vindue, og start Start.command igen.",
      );
  } catch (e) {
    state.ready = false;
    connection("Ikke forbundet", true);
    notify(errorText(e));
    controls();
  }
}
void initialize();

// Analyse only the assistant's playback. No microphone access is requested.
let voiceContext, voiceAnalyser, voiceSamples, voiceFrequencies, voiceFrame;
const voiceBars = [...document.querySelectorAll(".orb-wave i")];
let voiceEnvelope = 0;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
async function animateVoice() {
  controls();
  if (reducedMotion.matches) return;
  try {
    if (!voiceContext) {
      const AudioContextClass =
        window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return;
      const context = new AudioContextClass();
      await context.resume();
      if (context.state !== "running") {
        await context.close();
        return;
      }
      const source = context.createMediaElementSource(player);
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      analyser.connect(context.destination);
      voiceContext = context;
      voiceAnalyser = analyser;
      voiceSamples = new Uint8Array(analyser.frequencyBinCount);
      voiceFrequencies = new Uint8Array(analyser.frequencyBinCount);
    } else if (voiceContext.state === "suspended") await voiceContext.resume();
    cancelAnimationFrame(voiceFrame);
    const draw = () => {
      if (
        player.paused ||
        player.ended ||
        document.hidden ||
        reducedMotion.matches
      ) {
        resetVoice();
        return;
      }
      voiceAnalyser.getByteTimeDomainData(voiceSamples);
      const energy = Math.sqrt(
        voiceSamples.reduce((sum, n) => sum + ((n - 128) / 128) ** 2, 0) /
          voiceSamples.length,
      );
      voiceEnvelope = voiceEnvelope * 0.65 + Math.min(1, energy * 6) * 0.35;
      $("voice-orb").style.setProperty("--voice-level", String(voiceEnvelope));
      document
        .querySelector(".main")
        .style.setProperty("--ambient-level", String(voiceEnvelope));
      voiceAnalyser.getByteFrequencyData(voiceFrequencies);
      voiceBars.forEach((bar, index) => {
        const bin = 1 + Math.abs(index - 4) * 4;
        const level = (voiceFrequencies[bin] + voiceFrequencies[bin + 1]) / 510;
        bar.style.setProperty("--band-level", String(level));
      });
      voiceFrame = requestAnimationFrame(draw);
    };
    draw();
  } catch {
    /* Playback remains available when audio analysis is unsupported. */
  }
}
function resetVoice() {
  cancelAnimationFrame(voiceFrame);
  voiceEnvelope = 0;
  $("voice-orb").style.setProperty("--voice-level", "0");
  document.querySelector(".main").style.setProperty("--ambient-level", "0");
  voiceBars.forEach((bar) => bar.style.setProperty("--band-level", "0"));
  controls();
}
player.addEventListener("play", () => {
  void animateVoice();
});
player.addEventListener("pause", resetVoice);
player.addEventListener("ended", resetVoice);
reducedMotion.addEventListener("change", () => {
  if (reducedMotion.matches) resetVoice();
  else if (!player.paused) void animateVoice();
});
document.addEventListener("visibilitychange", () => {
  document
    .querySelector(".main")
    .classList.toggle("motion-paused", document.hidden);
  if (document.hidden) {
    resetVoice();
    voice?.stop();
  } else if (!player.paused) void animateVoice();
});

function setupVoice(ConversationVoice) {
  voice = new ConversationVoice({
    isBusy: () =>
      state.posting ||
      state.navigating ||
      !!state.pending ||
      (!!state.active &&
        (!state.active.done ||
          state.active.loading > 0 ||
          state.active.queue.size > 0 ||
          !!state.active.currentUrl)),
    onState: (phase) => {
      document.documentElement.dataset.voicePhase = phase;
      $("voice-bar").hidden = phase === "off";
      $("voice-start").hidden = phase !== "off";
      $("voice-send-now").hidden = phase !== "listening";
      $("voice-interrupt").hidden = ![
        "waiting",
        "transcribing",
        "sending",
      ].includes(phase);
      $("voice-status").textContent = {
        off: "Mikrofon slukket",
        permission: "Tillad mikrofonen i browseren …",
        listening: "Jeg lytter — hold en kort pause, når du er færdig.",
        transcribing: "Omsætter din tale til tekst …",
        sending: "Sender din besked …",
        waiting: "Mikrofon på pause, mens Stemme svarer.",
      }[phase];
      $("speech-enabled").disabled = !state.speech || phase !== "off";
      if (phase === "listening") {
        document.documentElement.dataset.assistantState = "listening";
        $("orb-status").textContent = "Jeg lytter";
      } else if (phase === "off") {
        document.documentElement.dataset.assistantState = state.ready
          ? "idle"
          : "offline";
      }
    },
    onLevel: (level) =>
      $("voice-orb").style.setProperty("--mic-level", String(level)),
    onError: (message) => notify(message),
    interrupt: () => stopActive(),
    transcribe: async (blob, id, signal) => {
      const language = $("voice-language").value;
      const r = await fetch("/v1/transcriptions", {
        method: "POST",
        headers: {
          ...headers(),
          "Content-Type": blob.type,
          "X-Request-Id": id,
          ...(language === "auto" ? {} : { "X-Audio-Language": language }),
        },
        body: blob,
        signal,
      });
      const data = await r.json();
      if (!r.ok)
        throw new Error(
          {
            NO_SPEECH:
              "Jeg kunne ikke høre en tydelig besked. Start samtalen igen, og prøv at tale tættere på mikrofonen.",
            RATE_LIMITED:
              "Groqs talekvote er midlertidigt nået. Vent lidt, og prøv igen.",
            PROVIDER_AUTH:
              "Groq kunne ikke godkende nøglen til transskription.",
          }[data.error?.code] ??
            "Talen kunne ikke genkendes. Kontrollér forbindelsen og din Groq-kvote.",
        );
      return data.text;
    },
    onTranscript: async (text) => {
      $("message-input").value = text;
      resize();
      $("speech-enabled").checked = true;
      await send();
      if (state.pending || $("message-input").value.trim())
        throw new Error(
          "Beskeden blev ikke sendt. Ret eller prøv den igen i chatfeltet.",
        );
    },
  });
  $("voice-start").onclick = async () => {
    if (!voice || !state.transcription) {
      notify(
        "Genstart Stemme med Start.command for at bruge mikrofonen. Tekstchat virker fortsat.",
      );
      return;
    }
    stopActive();
    $("speech-enabled").checked = true;
    try {
      await voice.start();
    } catch (e) {
      notify(errorText(e));
    }
    controls();
  };
  $("voice-stop").onclick = () => {
    voice.stop();
    stopActive();
    controls();
  };
  $("voice-send-now").onclick = () => voice.sendNow();
  $("voice-interrupt").onclick = () => voice.interrupt();
  window.addEventListener("pagehide", () => voice.stop());
}
// Optional enhancements must never prevent text chat from initializing.
void import("./voice.js?v=voice-hotfix-1")
  .then(({ ConversationVoice }) => {
    setupVoice(ConversationVoice);
    state.voiceAvailable = true;
    controls();
  })
  .catch(() => {
    state.voiceAvailable = false;
    controls();
    $("voice-start").title =
      "Mikrofonmodulet kunne ikke indlæses. Genstart Stemme efter opdatering.";
    notify(
      "Tekstchat kan bruges. Mikrofonmodulet mangler: stop Stemme med Control+C i det gamle Terminal-vindue, og start Start.command igen.",
    );
  });
void import("./orb.js?v=voice-hotfix-1")
  .then(({ mountEnergyOrb }) => {
    try {
      mountEnergyOrb($("voice-orb"), $("energy-canvas"));
    } catch {
      $("voice-orb").classList.remove("energy-ready");
    }
  })
  .catch(() => {
    $("voice-orb").classList.remove("energy-ready");
  });
