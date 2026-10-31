import { z } from "zod";
const bool = z.enum(["true", "false"]).transform((v) => v === "true");
const schema = z.object({
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  API_TOKEN: z.string().min(32).optional(),
  OWNER_ID: z.string().default("local-user"),
  GROQ_API_KEY: z.string().min(1).optional(),
  GROQ_MODEL: z.string().min(1).optional(),
  GROQ_TRANSCRIPTION_MODEL: z.string().min(1).default("whisper-large-v3-turbo"),
  TRANSCRIPTION_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .max(25 * 1024 * 1024)
    .default(8 * 1024 * 1024),
  SPEECH_ENABLED: bool.default(false),
  FISH_API_KEY: z.string().min(1).optional(),
  FISH_MODEL: z.string().min(1).optional(),
  FISH_VOICE_ID: z.string().min(1).optional(),
  DATABASE_PATH: z.string().default("data/stemme.sqlite"),
  ALLOWED_ORIGINS: z.string().default("http://localhost:5173"),
  REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(300000)
    .default(60000),
  CONTEXT_TOKENS: z.coerce.number().int().min(1024).max(131072).default(8192),
  OUTPUT_TOKENS: z.coerce.number().int().min(1).max(32768).default(1024),
  AUDIO_TTL_SECONDS: z.coerce.number().int().min(10).max(3600).default(300),
  LOG_LEVEL: z
    .enum(["silent", "error", "warn", "info", "debug"])
    .default("info"),
  ENABLED_TOOLS: z.string().default(""),
  ASSISTANT_NAME: z.string().max(100).default("Stemme"),
  SYSTEM_INSTRUCTIONS_FILE: z.string().default("assistant.md"),
});
export type Config = z.infer<typeof schema>;
export function config(env: NodeJS.ProcessEnv = process.env): Config {
  const r = schema.safeParse(env);
  if (!r.success)
    throw new Error(
      "Invalid configuration: " +
        r.error.issues.map((i) => i.path.join(".")).join(", "),
    );
  const c = r.data;
  if (!["127.0.0.1", "::1", "localhost"].includes(c.HOST) && !c.API_TOKEN)
    throw new Error(
      "Remote binding requires API_TOKEN (at least 32 characters) and a TLS reverse proxy",
    );
  if (
    c.SPEECH_ENABLED &&
    (!c.FISH_API_KEY || !c.FISH_MODEL || !c.FISH_VOICE_ID)
  )
    throw new Error(
      "Speech requires FISH_API_KEY, FISH_MODEL and FISH_VOICE_ID",
    );
  if (Boolean(c.GROQ_API_KEY) !== Boolean(c.GROQ_MODEL))
    throw new Error("Set both GROQ_API_KEY and GROQ_MODEL");
  if (c.OUTPUT_TOKENS >= c.CONTEXT_TOKENS / 2)
    throw new Error("OUTPUT_TOKENS must be less than half CONTEXT_TOKENS");
  return c;
}
