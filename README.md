# Interview Ready

A voice-first interview practice app. Candidates upload a PDF resume, add a job description or role, and complete a five-question HR or technical mock interview. Voice and chat share the same transcript; results include an estimated readiness score, answer feedback, and significant grammar issues.

## Requirements

- Node.js 20 or newer
- npm
- A Groq API key ([console.groq.com/keys](https://console.groq.com/keys))
- A modern browser with microphone permission for voice mode (Chrome or Edge recommended)

## Run locally

1. Install dependencies: `npm install`
2. Copy `.env.example` to `.env.local` and add your `GROQ_API_KEY`.
3. Start the app: `npm run dev`
4. Open `http://localhost:3000`.

The API key stays on the server. Never add it to a `NEXT_PUBLIC_` variable or commit `.env.local`.

## Deploy

### Vercel

Import the repository in Vercel. It detects Next.js from `vercel.json`. Add `GROQ_API_KEY` (and optionally `GROQ_MODEL`) under Project Settings → Environment Variables, then deploy.

### Netlify

Import the repository in Netlify. The included `netlify.toml` uses Netlify's Next.js runtime plugin. Add `GROQ_API_KEY` (and optionally `GROQ_MODEL`) under Site configuration → Environment variables, then deploy.

For either host, redeploy after changing environment variables. Microphone access requires HTTPS in production; the browser permits localhost during local development.

## What is included

- PDF text extraction in the browser with `pdfjs-dist`; scanned/image-only PDFs need OCR and are identified as unsupported by the text extractor.
- Resume detail extraction and job description parsing/generation through a LangGraph workflow and Groq chat model.
- HR questions randomly selected from the supplied set of eight without asking the LLM to choose them; technical questions tailored to the resume and role.
- A standalone Python `random.sample` helper for HR questions at `scripts/select_hr_questions.py`. The deployed Node serverless endpoint uses an equivalent local shuffle so both Vercel and Netlify can run the same Next.js app without a separate Python runtime.
- Five-question interview with voice input, spoken interviewer prompts, live transcript, and chat/voice switching.
- A candidate can speak while the interviewer is speaking. The interviewer audio continues; captured speech is queued and sent after playback finishes.
- Interview data stored in browser local storage for this session/device. Each turn sends the complete interview transcript to the server to preserve context.
- Final result includes a rough AI readiness estimate, reasons, improvements, and significant grammar feedback. The score is a coaching estimate, not a real hiring probability.

## Notes and limitations

- Voice input uses the browser's Web Speech Recognition API, which is not available in every browser or locale. Chat mode remains available if recognition is unavailable.
- Browser speech recognition is not a guaranteed archival recording. The app stores recognized text, not raw microphone audio. The current design queues speech recognized during AI playback and submits it after the AI finishes.
- Resume extraction is text based. Scanned PDFs require an OCR service to be added.
- The browser local-storage session is not a user account or cross-device database. Add authentication and a database before using this as a multi-user production service.
- Treat uploaded resumes and generated feedback as sensitive personal data. This starter keeps the PDF in the browser and sends extracted resume text and interview answers to the configured Groq API for model processing.

## Project structure

```text
app/
  api/interview/route.ts  LangGraph + Groq endpoint
  globals.css             Responsive application styles
  layout.tsx              Root layout
  page.tsx                Resume, setup, interview, and results experience
scripts/
  select_hr_questions.py  Python random.sample helper for HR question sets
```
