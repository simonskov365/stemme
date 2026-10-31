import { z } from "zod";
import { AppError } from "./errors.js";
import { Store, id, now } from "./store.js";
import { fingerprint } from "./orchestrator.js";
export type Tool = {
  name: string;
  description: string;
  schema: z.ZodType;
  timeout: number;
  kind: "read-only" | "state-changing";
  handler: (args: any, signal: AbortSignal) => Promise<unknown>;
};
export class Tools {
  private registry = new Map<string, Tool>();
  constructor(
    private store: Store,
    private enabled: string[],
  ) {
    this.register({
      name: "clock",
      description: "Read the current UTC time",
      schema: z.object({}).strict(),
      timeout: 1000,
      kind: "read-only",
      handler: async () => ({ utc: now() }),
    });
  }
  register(tool: Tool) {
    if (this.registry.has(tool.name)) throw new Error("Duplicate tool");
    this.registry.set(tool.name, tool);
  }
  list() {
    return [...this.registry.values()]
      .filter((t) => this.enabled.includes(t.name))
      .map((t) => ({
        name: t.name,
        description: t.description,
        classification: t.kind,
        timeoutMs: t.timeout,
        inputSchema: z.toJSONSchema(t.schema),
      }));
  }
  propose(owner: string, name: string, args: unknown, requestId: string) {
    const tool = this.registry.get(name);
    if (!tool || !this.enabled.includes(name))
      throw new AppError("TOOL_DISABLED", "Tool is not enabled", 403);
    const parsed = tool.schema.safeParse(args);
    if (!parsed.success)
      throw new AppError(
        "INVALID_TOOL_ARGUMENTS",
        "Tool arguments do not match the schema",
      );
    const hash = fingerprint({ name, args: parsed.data });
    const prior = this.store.one(
      "SELECT * FROM tool_actions WHERE owner=? AND request_key=?",
      owner,
      requestId,
    );
    if (prior) {
      if (prior.fingerprint !== hash)
        throw new AppError(
          "IDEMPOTENCY_CONFLICT",
          "Action request ID has different arguments",
          409,
        );
      return this.view(prior);
    }
    const aid = id();
    this.store.run(
      "INSERT INTO tool_actions VALUES(?,?,?,?,?,?,0,?,?,?)",
      aid,
      owner,
      requestId,
      hash,
      name,
      JSON.stringify(parsed.data),
      "proposed",
      null,
      now(),
    );
    return this.get(owner, aid);
  }
  private row(owner: string, aid: string) {
    const r = this.store.one(
      "SELECT * FROM tool_actions WHERE id=? AND owner=?",
      aid,
      owner,
    );
    if (!r || r.name === "speech")
      throw new AppError("NOT_FOUND", "Action not found", 404);
    return r;
  }
  private view(r: Record<string, any>) {
    return {
      id: r.id,
      name: r.name,
      args: JSON.parse(r.args),
      fingerprint: r.fingerprint,
      approved: !!r.approved,
      status: r.status,
      result: r.result ? JSON.parse(r.result) : null,
    };
  }
  get(owner: string, aid: string) {
    return this.view(this.row(owner, aid));
  }
  approve(owner: string, aid: string, hash: string) {
    const r = this.row(owner, aid);
    if (r.fingerprint !== hash)
      throw new AppError(
        "APPROVAL_MISMATCH",
        "Approval must match the exact action and arguments",
        409,
      );
    if (r.status !== "proposed")
      throw new AppError("ACTION_STARTED", "Action already started", 409);
    this.store.run("UPDATE tool_actions SET approved=1 WHERE id=?", aid);
    return this.get(owner, aid);
  }
  async execute(owner: string, aid: string) {
    const r = this.row(owner, aid),
      tool = this.registry.get(r.name);
    if (!tool || !this.enabled.includes(r.name))
      throw new AppError("TOOL_DISABLED", "Tool disabled", 403);
    if (r.status !== "proposed") return this.get(owner, aid); // At-most-once even after crash or ambiguous failure.
    if (tool.kind === "state-changing" && !r.approved)
      throw new AppError(
        "APPROVAL_REQUIRED",
        "Explicit approval of this action fingerprint is required",
        403,
      );
    const parsed = tool.schema.safeParse(JSON.parse(r.args));
    if (!parsed.success)
      throw new AppError(
        "INVALID_TOOL_ARGUMENTS",
        "Stored action arguments are invalid",
      );
    this.store.run("UPDATE tool_actions SET status='running' WHERE id=?", aid);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        tool.handler(parsed.data, controller.signal),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("timeout"));
          }, tool.timeout);
        }),
      ]);
      this.store.run(
        "UPDATE tool_actions SET status='completed',result=? WHERE id=?",
        JSON.stringify({ ok: true, data: result }),
        aid,
      );
    } catch {
      this.store.run(
        "UPDATE tool_actions SET status='failed',result=? WHERE id=?",
        JSON.stringify({
          ok: false,
          error: {
            code: "TOOL_FAILED",
            message:
              "Tool failed or timed out; outcome may be unknown. It will not be retried.",
          },
        }),
        aid,
      );
    } finally {
      clearTimeout(timer);
    }
    return this.get(owner, aid);
  }
}
