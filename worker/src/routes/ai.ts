import { Hono } from "hono";
import type { Env, UserPayload } from "../types";
import { authRequired } from "../middleware/auth";
import * as settingDB from "../db/setting";

type AIApp = { Bindings: Env; Variables: { user: UserPayload } };

export const aiRoutes = new Hono<AIApp>();

const MAX_AUDIO_SIZE_BYTES = 25 * 1024 * 1024;

aiRoutes.post("/transcribe", authRequired, async (c) => {
  const contentType = c.req.header("content-type") || "";

  if (!c.env.AI) {
    return c.json({ error: "AI binding not configured" }, 501);
  }

  let audioData: ArrayBuffer;
  let requestedLanguage = "";
  if (contentType.includes("multipart/form-data")) {
    const formData = await c.req.formData();
    const file = formData.get("file") as File | null;
    if (!file) return c.json({ error: "No audio file provided" }, 400);
    if (file.size > MAX_AUDIO_SIZE_BYTES) {
      return c.json({ error: "Audio file exceeds the 25MB limit" }, 413);
    }
    audioData = await file.arrayBuffer();
    if (audioData.byteLength > MAX_AUDIO_SIZE_BYTES) {
      return c.json({ error: "Audio file exceeds the 25MB limit" }, 413);
    }
    requestedLanguage = String(formData.get("language") || "");
  } else {
    return c.json({ error: "Expected multipart/form-data" }, 400);
  }

  // Get AI settings for model/language config
  let model = "@cf/openai/whisper";
  let language = requestedLanguage;
  const aiSettingRow = await settingDB.getInstanceSetting(c.env.DB, "AI");
  if (aiSettingRow) {
    try {
      const parsed = JSON.parse(aiSettingRow.value);
      if (parsed.transcription?.model) model = parsed.transcription.model;
      if (!language && parsed.transcription?.language) language = parsed.transcription.language;
    } catch {}
  }

  const payload: Record<string, unknown> = {
    audio: [...new Uint8Array(audioData)],
  };
  if (language) {
    payload.language = language;
  }

  const result = await c.env.AI.run(model as any, payload as any);

  return c.json({ text: (result as any).text || "" });
});
