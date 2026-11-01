import { Store, id, now, type Row } from "./store.js";
import { AppError } from "./errors.js";
export const DOCUMENT_LIMIT = 1024 * 1024;
export function documentId(input: string) {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    throw new AppError("INVALID_DOCUMENT", "Enter a Google Docs document link");
  }
  const match = u.pathname.match(
    /^\/document\/d\/([A-Za-z0-9_-]{20,})(?:\/|$)/,
  );
  if (
    u.protocol !== "https:" ||
    u.hostname !== "docs.google.com" ||
    u.port ||
    u.username ||
    u.password ||
    !match
  )
    throw new AppError(
      "INVALID_DOCUMENT",
      "Only HTTPS docs.google.com/document/d/... links are supported",
    );
  return match[1];
}
export async function readGoogleDoc(
  docId: string,
  fetchImpl: typeof fetch = fetch,
) {
  if (!/^[A-Za-z0-9_-]{20,}$/.test(docId))
    throw new AppError("INVALID_DOCUMENT", "Invalid Google document id");
  let url = `https://docs.google.com/document/d/${docId}/export?format=txt`;
  const signal = AbortSignal.timeout(15000);
  try {
    for (let hop = 0; hop < 4; hop++) {
      const r = await fetchImpl(url, {
        redirect: "manual",
        signal,
        headers: { Accept: "text/plain" },
      });
      if ([301, 302, 303, 307, 308].includes(r.status)) {
        const target = new URL(r.headers.get("location") ?? "", url);
        await r.body?.cancel();
        if (
          target.protocol !== "https:" ||
          target.username ||
          target.password ||
          target.port ||
          !(
            target.hostname === "docs.google.com" ||
            target.hostname.endsWith(".googleusercontent.com")
          )
        )
          throw new AppError(
            "DOCUMENT_ACCESS",
            "Google requires a login or returned an unsupported redirect. No Google login is available in this app.",
            403,
          );
        url = target.href;
        continue;
      }
      if (!r.ok) {
        await r.body?.cancel();
        throw new AppError(
          "DOCUMENT_ACCESS",
          "The document could not be read with the shared-link access. Your saved copy has been kept.",
          r.status === 404 ? 404 : 403,
        );
      }
      if (
        !r.headers.get("content-type")?.toLowerCase().startsWith("text/plain")
      ) {
        await r.body?.cancel();
        throw new AppError(
          "DOCUMENT_ACCESS",
          "Google returned a login page instead of a text document",
          403,
        );
      }
      const reader = r.body?.getReader();
      if (!reader)
        throw new AppError("EMPTY_DOCUMENT", "Document export is empty", 422);
      const parts: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > DOCUMENT_LIMIT)
            throw new AppError(
              "DOCUMENT_LIMIT",
              "Document is larger than 1 MiB",
              413,
            );
          parts.push(value);
        }
      } finally {
        await reader.cancel();
      }
      return Buffer.concat(parts)
        .toString("utf8")
        .replace(/^\uFEFF/, "");
    }
    throw new AppError("DOCUMENT_ACCESS", "Too many Google redirects", 502);
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError(
      "DOCUMENT_UNAVAILABLE",
      "Google could not be reached. The saved local copy has been kept.",
      503,
    );
  }
}
function validateText(text: string) {
  if (!text.trim())
    throw new AppError("EMPTY_DOCUMENT", "The document is empty", 422);
  if (Buffer.byteLength(text) > DOCUMENT_LIMIT)
    throw new AppError("DOCUMENT_LIMIT", "Document is larger than 1 MiB", 413);
  if (
    /(?:gsk_[A-Za-z0-9_-]{25,}|sk-fish-[A-Za-z0-9_-]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/.test(
      text,
    )
  )
    throw new AppError(
      "SENSITIVE_DOCUMENT",
      "Remove credentials/private keys from the document before importing it",
    );
}
export function splitDocument(text: string) {
  const boundary = text.search(/^\s*2\.\s*Continuity Timeline\b/im);
  const core =
    boundary >= 0 ? text.slice(0, boundary).trim() : text.slice(0, 7000);
  const passages: { section: string; content: string }[] = [];
  for (const [section, content] of [
    ["Permanent Core", core],
    [
      "Historical timeline",
      boundary >= 0 ? text.slice(boundary) : text.slice(7000),
    ],
  ]) {
    let chunk = "";
    for (const paragraph of content.split(/\n\s*\n/)) {
      for (const part of paragraph.match(
        /[\s\S]{1,850}(?:\s|$)|[\s\S]{1,850}/g,
      ) ?? []) {
        if (chunk.length + part.length > 1000 && chunk) {
          passages.push({ section, content: chunk.trim() });
          chunk = "";
        }
        chunk += (chunk ? "\n" : "") + part;
      }
    }
    if (chunk.trim()) passages.push({ section, content: chunk.trim() });
  }
  return { core, passages };
}
export function personaSuggestion(core: string) {
  const sections = [
    ["Nyra identity & personality", 1000],
    ["Conversation style", 650],
    ["Language & voice", 350],
  ] as const;
  const lines = core.split("\n");
  const result: string[] = [];
  for (const [heading, max] of sections) {
    const start = lines.findIndex(
      (l) => l.trim().toLowerCase() === heading.toLowerCase(),
    );
    if (start < 0) continue;
    let end = start + 1;
    while (
      end < lines.length &&
      !/^(Conversation style|Simon Lore|Shared Lore & relationship|Language & voice|Work mode|Master maintenance)$/i.test(
        lines[end].trim(),
      )
    )
      end++;
    result.push(lines.slice(start, end).join("\n").slice(0, max));
  }
  return (result.join("\n\n") || core.slice(0, 1800)).slice(0, 2200);
}
export class Nyra {
  private syncing = new Map<string, Promise<Row>>();
  private versions = new Map<string, number>();
  constructor(
    public store: Store,
    private fetchImpl: typeof fetch = fetch,
  ) {}
  status(owner: string) {
    const doc = this.store.one(
      "SELECT id,document_id,title,synced_at,last_error,length(content) AS characters FROM nyra_documents WHERE owner=?",
      owner,
    );
    const profile = this.store.one(
      "SELECT name,persona,enabled FROM nyra_profiles WHERE owner=?",
      owner,
    ) ?? { name: "Nyra", persona: "", enabled: 0 };
    return {
      document: doc
        ? {
            ...doc,
            url: doc.document_id
              ? `https://docs.google.com/document/d/${doc.document_id}/edit`
              : null,
          }
        : null,
      profile: { ...profile, enabled: !!profile.enabled },
    };
  }
  private save(
    owner: string,
    text: string,
    docId: string | null,
    title?: string,
    preserveProfile = false,
  ) {
    validateText(text);
    const { core, passages } = splitDocument(text);
    const old = this.store.one(
        "SELECT id FROM nyra_documents WHERE owner=?",
        owner,
      ),
      sid = old?.id ?? id();
    this.store.tx(() => {
      this.store.run(
        "INSERT INTO nyra_documents VALUES(?,?,?,?,?,?,?,NULL) ON CONFLICT(owner) DO UPDATE SET document_id=excluded.document_id,title=excluded.title,content=excluded.content,core=excluded.core,synced_at=excluded.synced_at,last_error=NULL",
        owner,
        sid,
        docId,
        (
          title ??
          text.split("\n").find((l) => l.trim()) ??
          "Continuity document"
        ).slice(0, 200),
        text,
        core,
        now(),
      );
      this.store.run("DELETE FROM nyra_passages WHERE source_id=?", sid);
      passages.forEach((p, i) =>
        this.store.run(
          "INSERT INTO nyra_passages(source_id,section,ordinal,content) VALUES(?,?,?,?)",
          sid,
          p.section,
          i,
          p.content,
        ),
      );
      this.store.run(
        preserveProfile
          ? "INSERT INTO nyra_profiles VALUES(?,'Nyra',?,0) ON CONFLICT(owner) DO NOTHING"
          : "INSERT INTO nyra_profiles VALUES(?,'Nyra',?,0) ON CONFLICT(owner) DO UPDATE SET persona=excluded.persona,enabled=0",
        owner,
        personaSuggestion(core),
      );
    });
    return this.status(owner);
  }
  async connect(owner: string, url: string) {
    const did = documentId(url),
      version = (this.versions.get(owner) ?? 0) + 1;
    this.versions.set(owner, version);
    const text = await readGoogleDoc(did, this.fetchImpl);
    if (this.versions.get(owner) !== version)
      throw new AppError(
        "SOURCE_CHANGED",
        "Source changed while connecting; no stale content was saved",
        409,
      );
    return this.save(owner, text, did);
  }
  import(owner: string, text: string, title: string) {
    this.versions.set(owner, (this.versions.get(owner) ?? 0) + 1);
    return this.save(owner, text, null, title);
  }
  sync(owner: string): Promise<Row> {
    const previous = this.syncing.get(owner);
    if (previous) return previous;
    const doc = this.store.one(
      "SELECT document_id FROM nyra_documents WHERE owner=?",
      owner,
    );
    if (!doc?.document_id)
      throw new AppError(
        "NO_GOOGLE_DOCUMENT",
        "Connect a Google document before refreshing",
        409,
      );
    const version = this.versions.get(owner) ?? 0;
    const promise = readGoogleDoc(doc.document_id, this.fetchImpl)
      .then((text) => {
        if ((this.versions.get(owner) ?? 0) !== version)
          throw new AppError(
            "SOURCE_CHANGED",
            "Source was removed or replaced while refreshing",
            409,
          );
        return this.save(owner, text, doc.document_id, undefined, true);
      })
      .catch((e) => {
        if ((this.versions.get(owner) ?? 0) === version)
          this.store.run(
            "UPDATE nyra_documents SET last_error=? WHERE owner=?",
            e instanceof AppError ? e.code : "DOCUMENT_UNAVAILABLE",
            owner,
          );
        throw e;
      })
      .finally(() => this.syncing.delete(owner));
    this.syncing.set(owner, promise);
    return promise;
  }
  profile(owner: string, name: string, persona: string, enabled: boolean) {
    if (
      enabled &&
      !this.store.one("SELECT id FROM nyra_documents WHERE owner=?", owner)
    )
      throw new AppError(
        "NO_DOCUMENT",
        "Import or connect a document before enabling the profile",
        409,
      );
    validateText(persona || "No additional persona");
    this.store.run(
      "INSERT INTO nyra_profiles VALUES(?,?,?,?) ON CONFLICT(owner) DO UPDATE SET name=excluded.name,persona=excluded.persona,enabled=excluded.enabled",
      owner,
      name,
      persona,
      Number(enabled),
    );
    return this.status(owner);
  }
  remove(owner: string) {
    this.versions.set(owner, (this.versions.get(owner) ?? 0) + 1);
    this.store.tx(() => {
      const doc = this.store.one(
        "SELECT id FROM nyra_documents WHERE owner=?",
        owner,
      );
      if (doc)
        this.store.run("DELETE FROM nyra_passages WHERE source_id=?", doc.id);
      this.store.run("DELETE FROM nyra_documents WHERE owner=?", owner);
      this.store.run("DELETE FROM nyra_profiles WHERE owner=?", owner);
    });
  }
}
function bounded(text: string, bytes: number) {
  while (Buffer.byteLength(text) > bytes) text = text.slice(0, -20);
  return text;
}
export function nyraContext(
  store: Store,
  owner: string,
  query: string,
  maxBytes: number,
) {
  const profile = store.one(
    "SELECT * FROM nyra_profiles WHERE owner=? AND enabled=1",
    owner,
  );
  const doc = store.one("SELECT * FROM nyra_documents WHERE owner=?", owner);
  if (!profile || !doc || maxBytes < 350) return null;
  const terms = [
    ...new Set(
      (query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter(
        (w) =>
          w.length <= 48 &&
          ![
            "what",
            "that",
            "this",
            "with",
            "have",
            "your",
            "from",
            "about",
            "hvad",
            "hvor",
            "hvem",
            "skal",
            "ikke",
            "dette",
            "tell",
            "please",
            "remember",
          ].includes(w),
      ),
    ),
  ].slice(0, 12);
  let matches: Row[] = [];
  if (terms.length)
    matches = store.all(
      "SELECT section,ordinal,content FROM nyra_passages WHERE nyra_passages MATCH ? AND source_id=? ORDER BY bm25(nyra_passages) LIMIT 3",
      terms.map((t) => '"' + t + '"').join(" OR "),
      doc.id,
    );
  const latest = store.all(
    "SELECT section,ordinal,content FROM nyra_passages WHERE source_id=? AND section='Historical timeline' ORDER BY CAST(ordinal AS INTEGER) DESC LIMIT 1",
    doc.id,
  );
  const selected = [...matches, ...latest].filter(
    (p, i, a) => a.findIndex((q) => q.ordinal === p.ordinal) === i,
  );
  // Keep name/style distinct from reference data. Raw document instructions never become system rules.
  const metadata = {
    title: doc.title,
    snapshotAt: doc.synced_at,
    syncError: doc.last_error ?? null,
    sourceMode: doc.document_id
      ? "read-only Google export snapshot"
      : "local imported text; no live Google connection",
  };
  const style = bounded(profile.persona, Math.floor(maxBytes * 0.43));
  const excerpts = selected.map((p) => ({
    section: p.section,
    excerpt: p.content,
  }));
  let data = JSON.stringify({ metadata, approvedStyle: style, excerpts });
  while (Buffer.byteLength(data) > maxBytes && excerpts.length) {
    excerpts.pop();
    data = JSON.stringify({ metadata, approvedStyle: style, excerpts });
  }
  if (Buffer.byteLength(data) > maxBytes)
    data = JSON.stringify({
      metadata,
      approvedStyle: bounded(
        style,
        Math.max(
          0,
          maxBytes - Buffer.byteLength(JSON.stringify(metadata)) - 100,
        ),
      ),
      excerpts: [],
    });
  if (Buffer.byteLength(data) > maxBytes) return null;
  return { name: profile.name, data };
}
