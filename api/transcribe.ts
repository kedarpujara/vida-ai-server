// api/transcribe.ts  (ESM)
import type { VercelRequest, VercelResponse } from "@vercel/node";
import formidable, { File as FormidableFile } from "formidable";
import fs from "fs";
import OpenAI from "openai";

export const config = {
  api: { bodyParser: false }, // required for formidable
};

// CORS (for web builds)
function setCors(res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Parse multipart form and normalize files.audio to a single file
function parseAudioFile(req: VercelRequest): Promise<FormidableFile> {
  return new Promise((resolve, reject) => {
    const form = formidable({
      multiples: false,
      maxFileSize: 50 * 1024 * 1024,
      keepExtensions: true,
    });

    form.parse(req as any, (err, _fields, files) => {
      if (err) return reject(err);
      const f: any = (files as any).audio;
      const audio: FormidableFile | undefined = Array.isArray(f) ? f[0] : f;
      if (!audio) return reject(new Error("Missing 'audio' file field"));
      resolve(audio);
    });
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ message: "Method not allowed" });

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ message: "Server misconfigured: OPENAI_API_KEY not set" });
  }

  try {
    const audio = await parseAudioFile(req);

    // 1) Transcribe with Whisper
    const stream = fs.createReadStream(audio.filepath);
    const tr: any = await openai.audio.transcriptions.create({
      file: stream as any,
      model: "whisper-1",
    });
    const text = (tr?.text || "").trim();

    // 2) Auto-tags with GPT
    const tagPrompt = `Extract 3–7 concise hashtags that capture mood, themes, and activities from the journal entry.

Rules:
- lowercase
- single words only (no spaces)
- prefix with "#"
- avoid duplicates
- keep them general (e.g., #happy, #stress, #creative, #exercise)

Return ONLY a JSON array of strings.

Entry:
---
${text}
---`;

    const tagResp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: [
        { role: "system", content: "Return valid JSON only." },
        { role: "user", content: tagPrompt },
      ],
    });

    let tags: string[] = [];
    try {
      const raw = tagResp.choices?.[0]?.message?.content?.trim() || "[]";
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        tags = parsed
          .filter((t: unknown): t is string => typeof t === "string")
          .map((t) => t.trim().toLowerCase())
          .map((t) => (t.startsWith("#") ? t : `#${t}`))
          .filter((t) => /^#[a-z0-9_-]{2,30}$/.test(t))
          .slice(0, 10);
      }
    } catch {
      tags = [];
    }

    return res.status(200).json({ text, tags });
  } catch (err: any) {
    console.error("[/api/transcribe] error:", err?.message || err);
    return res.status(500).json({ message: err?.message || "transcription failed" });
  }
}
