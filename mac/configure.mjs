import { writeFileSync } from "node:fs";
const groq = process.env.STEMME_SETUP_GROQ_KEY ?? "";
const fish = process.env.STEMME_SETUP_FISH_KEY ?? "";
if (
  !/^gsk_[A-Za-z0-9_-]+$/.test(groq) ||
  (fish && !/^sk-fish-[A-Za-z0-9_-]+$/.test(fish))
) {
  console.error(
    "Nøglernes format kunne ikke valideres. Ingen fil blev skrevet.",
  );
  process.exit(1);
}
const config = [
  "HOST=127.0.0.1",
  "PORT=3000",
  "OWNER_ID=local-user",
  `GROQ_API_KEY=${groq}`,
  "GROQ_MODEL=openai/gpt-oss-20b",
  "GROQ_TRANSCRIPTION_MODEL=whisper-large-v3-turbo",
  `SPEECH_ENABLED=${Boolean(fish)}`,
  ...(fish
    ? [
        `FISH_API_KEY=${fish}`,
        "FISH_MODEL=s2.1-pro-free",
        "FISH_VOICE_ID=4f553d53658c4908b5f244345486d80d",
      ]
    : []),
  "DATABASE_PATH=data/stemme.sqlite",
  "ALLOWED_ORIGINS=http://127.0.0.1:3000,http://localhost:3000",
  "REQUEST_TIMEOUT_MS=120000",
  "CONTEXT_TOKENS=8192",
  "OUTPUT_TOKENS=1024",
  "AUDIO_TTL_SECONDS=300",
  "LOG_LEVEL=info",
  "ENABLED_TOOLS=",
  "ASSISTANT_NAME=Stemme",
  "SYSTEM_INSTRUCTIONS_FILE=assistant.md",
  "",
].join("\n");
try {
  writeFileSync(".env", config, { mode: 0o600, flag: "wx" });
  console.log("API-nøgler er gemt lokalt i en privat .env-fil.");
} catch {
  console.error(
    "Konfigurationsfilen kunne ikke oprettes. En eksisterende fil bliver aldrig overskrevet.",
  );
  process.exit(1);
}
