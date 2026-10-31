export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};
export interface TextProvider {
  stream(messages: ChatMessage[], signal: AbortSignal): AsyncIterable<string>;
}
export interface SpeechProvider {
  synthesize(text: string, signal: AbortSignal): Promise<Uint8Array>;
}
