// api/transcribe.ts
import type { VercelRequest, VercelResponse } from "@vercel/node";
import formidable, { File as FormidableFile } from "formidable";
import fs from "fs";
import OpenAI from "openai";

/**
 * Vercel API config:
 * - Disable Next.js body parser so we can handle multipart form-data with formidable.
 */
export const config = {
  api: {
    bodyParser: false,
  },
};

// ---- CORS helpers (so browser builds can POST here) ----
function setCors(res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

/**
 * Parse multipart/form-data and return the "audio" file.
 * Works for both single file objects and arrays (some formidable versions use arrays).
 */
function parseAudioFile(req: VercelRequest): Promise<FormidableFile> {
  return new Promise((resolve, reject) => {
    const form = formidable({
      multiples: false,
      maxFileSize: 50 * 1024 * 1024, // 50MB cap (tweak as needed)
      keepExtensions: true,
    });

    form.parse(req as any, (err, _fields, files) => {
      if (err) return reject(err);
      const f: any = (files as any).audio;
      const audio: FormidableFile | undefined = Array.isArray(f) ? f[0] : f;
      if (!audio) return reject(new Error("Missing file field 'audio'."));
      resolve(audio);
    });
  });
}

// ---- OpenAI client ----
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCors(res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ message: "Method not allowed" });
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ message: "Server misconfigured: OPENAI_API_KEY not set" });
  }

  try {
    // 1) Parse the uploaded audio
    const audio = await parseAudioFile(req);

    // 2) Transcribe with Whisper
    const stream = fs.createReadStream(audio.filepath);
    const transcription: any = await openai.audio.transcriptions.create({
      file: stream as any,
      model: "whisper-1",
    });

    const text = (transcription?.text || "").trim();

    // 3) Generate hashtags with GPT
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
      // If parsing fails, just return an empty array; transcript is still valuable
      tags = [];
    }

    return res.status(200).json({ text, tags });
  } catch (err: any) {
    console.error("[/api/transcribe] error:", err?.message || err);
    return res.status(500).json({ message: err?.message || "transcription failed" });
  }
}
