// Voice notes → text, on the server, with a proper speech-to-text model.
//
// The browser records the audio (MediaRecorder: webm/opus on Android & desktop Chrome,
// mp4/AAC on iPhone) and uploads it in segments of up to ~25 seconds. Providers:
//   openai  — gpt-4o-mini-transcribe (default). Accepts long files; takes a "prompt" we fill
//             with the workspace's names and products so they come out spelled right.
//   sarvam  — Saaras v3, built for Indian languages and Hinglish ("codemix" keeps mixed
//             Hindi-English as spoken). Its synchronous API takes clips under 30 seconds,
//             which is why the browser sends ≤25-second segments.
// With no provider configured, the app falls back to the browser's own speech recognition.
import { env } from "../env.js";

export class TranscribeError extends Error {}

export function transcribeProvider(): "openai" | "sarvam" | "" {
  const want = env.transcribeProvider;
  if (want === "openai" && env.openaiKey) return "openai";
  if (want === "sarvam" && env.sarvamKey) return "sarvam";
  if (!want) return env.openaiKey ? "openai" : env.sarvamKey ? "sarvam" : "";
  return "";
}

const EXT: Record<string, string> = { webm: "webm", ogg: "ogg", mp4: "mp4", m4a: "m4a", mpeg: "mp3", mp3: "mp3", wav: "wav", aac: "aac" };
function fileName(mime: string) {
  const sub = (mime.split("/")[1] || "").split(";")[0].toLowerCase();
  return "voice." + (EXT[sub] || "webm");
}

/** Price of `seconds` of audio, in USD. */
export function transcribeCostUsd(provider: string, model: string, seconds: number) {
  if (provider === "sarvam") return (seconds / 3600) * env.sarvamInrPerHour / env.usdInr; // ₹ per audio hour
  const perMin = /gpt-4o-transcribe|whisper/.test(model) && !/mini/.test(model) ? 0.006 : 0.003;
  return (seconds / 60) * perMin;
}

export async function transcribe(audio: Buffer, mime: string, opts: { prompt?: string } = {}): Promise<{ text: string; provider: string; model: string }> {
  const provider = transcribeProvider();
  if (!provider) throw new TranscribeError("No transcription provider is configured.");
  const type = (mime || "audio/webm").split(";")[0];
  const fd = new FormData();
  fd.append("file", new Blob([new Uint8Array(audio)], { type }), fileName(type));
  let res: Response, model: string;
  if (provider === "openai") {
    model = env.openaiTranscribeModel;
    fd.append("model", model);
    fd.append("response_format", "json");
    if (opts.prompt) fd.append("prompt", opts.prompt.slice(0, 900));
    res = await fetch(`${env.openaiBaseUrl}/audio/transcriptions`, { method: "POST", headers: { authorization: `Bearer ${env.openaiKey}` }, body: fd });
  } else {
    model = "saaras:v3";
    fd.append("model", model);
    fd.append("mode", env.sarvamMode);
    res = await fetch(`${env.sarvamBaseUrl}/speech-to-text`, { method: "POST", headers: { "api-subscription-key": env.sarvamKey }, body: fd });
  }
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("[voice] transcription failed", provider, res.status, JSON.stringify(data).slice(0, 300));
    throw new TranscribeError("Couldn't transcribe that.");
  }
  const text = String(data.text ?? data.transcript ?? "").trim();
  return { text, provider, model };
}
