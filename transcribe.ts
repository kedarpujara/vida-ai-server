import { IncomingForm } from "formidable";
import fs from "fs";
import OpenAI from "openai";

export const config = {
  api: {
    bodyParser: false
  }
};

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const form = new IncomingForm();
  form.parse(req, async (err, fields, files) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: "Error parsing file" });
    }

    try {
      const filePath = files.audio[0].filepath;
      const transcription = await openai.audio.transcriptions.create({
        file: fs.createReadStream(filePath),
        model: "gpt-4o-mini-transcribe"
      });

      const tags = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{
          role: "user",
          content: `Extract 3-5 short hashtag-style mood/activity tags from this text: "${transcription.text}"`
        }],
        max_tokens: 50
      });

      res.status(200).json({
        transcription: transcription.text,
        tags: tags.choices[0].message.content
      });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Error during transcription" });
    }
  });
}