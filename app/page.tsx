"use client";

import { useEffect, useRef, useState } from "react";

type Turn = { question: string; answer: string };
type Setup = { candidateName: string; resume: { summary?: string; skills?: string[]; projects?: string[]; certifications?: string[]; experience?: string }; jobDescription: string; questions: string[] };
type Report = { score: number; headline: string; strengths: string[]; improvements: string[]; grammarIssues: string[]; summary: string };
type Stage = "upload" | "setup" | "interview" | "results";

async function api(payload: unknown) {
  const response = await fetch("/api/interview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const raw = await response.text();
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    const detail = raw.trim().slice(0, 300) || "The server returned an empty response.";
    throw new Error(`Interview service returned HTTP ${response.status}: ${detail}`);
  }
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data;
}

async function extractPdf(file: File) {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjs.version}/pdf.worker.min.mjs`;
  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  let text = "";
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map((item: any) => item.str || "").join(" ") + "\n";
  }
  return text.trim();
}

function splitSpeech(text: string, limit = 180) {
  const words = text.trim().split(/\s+/);
  const chunks: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > limit && current) { chunks.push(current); current = word; }
    else current = next;
  }
  if (current) chunks.push(current);
  return chunks;
}

export default function Home() {
  const [stage, setStage] = useState<Stage>("upload");
  const [busy, setBusy] = useState("");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [resumeText, setResumeText] = useState("");
  const [resumeFile, setResumeFile] = useState("");
  const [candidateName, setCandidateName] = useState("");
  const [parsedResume, setParsedResume] = useState<Setup["resume"] | null>(null);
  const [jobDescription, setJobDescription] = useState("");
  const [role, setRole] = useState("");
  const [interviewType, setInterviewType] = useState("Technical");
  const [difficulty, setDifficulty] = useState("moderate");
  const [setup, setSetup] = useState<Setup | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [currentQuestion, setCurrentQuestion] = useState("");
  const [questionIndex, setQuestionIndex] = useState(0);
  const [followUpCount, setFollowUpCount] = useState(0);
  const [mode, setMode] = useState<"voice" | "chat">("voice");
  const [draft, setDraft] = useState("");
  const [listening, setListening] = useState(false);
  const [micStarting, setMicStarting] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [aiSpeaking, setAiSpeaking] = useState(false);
  const [queuedSpeech, setQueuedSpeech] = useState("");
  const [report, setReport] = useState<Report | null>(null);
  const [clock, setClock] = useState(0);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const queuedSpeechRef = useRef("");
  const aiSpeakingRef = useRef(false);
  const busyRef = useRef(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaChunksRef = useRef<Blob[]>([]);
  const micStartingRef = useRef(false);
  const discardRecordingRef = useRef(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const speechRunRef = useRef(0);
  const draftRef = useRef("");
  const submitAnswerRef = useRef<(text: string) => void>(() => undefined);

  useEffect(() => { const timer = window.setInterval(() => setClock((value) => value + 1), 1000); return () => window.clearInterval(timer); }, []);
  useEffect(() => { busyRef.current = Boolean(busy); }, [busy]);
  useEffect(() => { transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: "smooth" }); }, [turns, currentQuestion]);
  useEffect(() => () => {
    discardRecordingRef.current = true;
    if (mediaRecorderRef.current?.state === "recording") mediaRecorderRef.current.stop();
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    audioRef.current?.pause();
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
  }, []);
  useEffect(() => {
    if (!busy) return;
    setProgress(6);
    const id = window.setInterval(() => setProgress((value) => Math.min(92, value + Math.max(1, Math.round((94 - value) / 13)))), 420);
    return () => window.clearInterval(id);
  }, [busy]);

  function finishSpeech(run: number) {
    if (run !== speechRunRef.current) return;
    aiSpeakingRef.current = false;
    setAiSpeaking(false);
    const pending = queuedSpeechRef.current.trim();
    if (pending) {
      queuedSpeechRef.current = "";
      setQueuedSpeech("");
      submitAnswerRef.current(pending);
    }
  }

  function say(text: string) {
    const chunks = splitSpeech(text);
    if (!chunks.length) return;
    const run = ++speechRunRef.current;
    audioRef.current?.pause();
    aiSpeakingRef.current = true;
    setAiSpeaking(true);

    void (async () => {
      for (let i = 0; i < chunks.length; i++) {
        if (run !== speechRunRef.current) return;
        try {
          await playGroqChunk(chunks[i], run);
        } catch (error) {
          if (run !== speechRunRef.current) return;
          setError(error instanceof Error ? `Server voice failed: ${error.message}. The question remains in the transcript.` : "Server voice failed. The question remains in the transcript.");
          break;
        }
      }
      finishSpeech(run);
    })();
  }

  async function playGroqChunk(text: string, run: number) {
    const response = await fetch("/api/interview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "speak", text }),
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.error || "Server speech could not generate audio.");
    }
    const url = URL.createObjectURL(await response.blob());
    if (run !== speechRunRef.current) { URL.revokeObjectURL(url); return; }
    const audio = new Audio(url);
    audioRef.current = audio;
    audioUrlRef.current = url;
    try {
      await new Promise<void>((resolve, reject) => {
        audio.onended = () => resolve();
        audio.onpause = () => resolve();
        audio.onerror = () => reject(new Error("Audio playback failed."));
        audio.play().catch(reject);
      });
    } finally {
      if (audioUrlRef.current === url) {
        audioRef.current = null;
        audioUrlRef.current = null;
        URL.revokeObjectURL(url);
      }
    }
  }

  async function onUpload(file?: File) {
    if (!file) return;
    setError("");
    if (file.type !== "application/pdf") { setError("Please choose a PDF resume."); return; }
    setBusy("Reading your resume"); setProgress(5);
    try {
      const text = await extractPdf(file);
      if (text.length < 80) throw new Error("This PDF has little or no selectable text. Scanned resumes need OCR; try a text-based PDF for this starter.");
      setProgress(45);
      const parsed = await api({ action: "resume", resumeText: text });
      setResumeText(text); setResumeFile(file.name); setCandidateName(parsed.candidateName || ""); setParsedResume(parsed.resume); setProgress(100);
      window.setTimeout(() => { setBusy(""); setStage("setup"); }, 500);
    } catch (e) { setBusy(""); setError(e instanceof Error ? e.message : "Could not read that PDF."); }
  }

  async function startInterview() {
    setError(""); setBusy("Preparing your interview");
    try {
      const result = await api({ action: "prepare", resume: parsedResume, candidateName, role, jobDescription, interviewType, difficulty });
      setSetup(result); setTurns([]); setQuestionIndex(0); setFollowUpCount(0); setCurrentQuestion(result.questions[0]); setClock(0); setStage("interview"); setBusy("");
      localStorage.setItem("interview-ready-session", JSON.stringify({ setup: result, turns: [], interviewType }));
      say(result.questions[0]);
    } catch (e) { setBusy(""); setError(e instanceof Error ? e.message : "Could not prepare the interview."); }
  }

  async function sendAnswer(value: string) {
    const answer = value.trim();
    if (!answer || !setup || busy) return;
    draftRef.current = ""; setDraft(""); setError("");
    const updated = [...turns, { question: currentQuestion, answer }];
    setTurns(updated); setBusy("Reviewing your answer");
    try {
      const result = await api({ action: "answer", interviewType, jobDescription: setup.jobDescription, resume: setup.resume, questions: setup.questions, turns, answer, currentQuestion, questionIndex, followUpCount });
      setBusy("");
      if (result.complete) { await finishInterview(updated); return; }
      setTurns(updated); setQuestionIndex(result.questionIndex); setFollowUpCount(result.followUpCount || 0); setCurrentQuestion(result.nextQuestion); localStorage.setItem("interview-ready-session", JSON.stringify({ setup, turns: updated, questionIndex: result.questionIndex, followUpCount: result.followUpCount || 0, currentQuestion: result.nextQuestion, interviewType })); say(result.nextQuestion);
    } catch (e) { setBusy(""); setError(e instanceof Error ? e.message : "Could not submit that answer."); setTurns(turns); }
  }
  submitAnswerRef.current = (value: string) => { void sendAnswer(value); };

  async function finishInterview(finalTurns = turns) {
    if (!setup) return;
    setBusy("Preparing your interview report");
    try {
      const result = await api({ action: "results", interviewType, jobDescription: setup.jobDescription, resume: setup.resume, turns: finalTurns });
      setReport(result); setStage("results"); setBusy("");
      localStorage.setItem("interview-ready-session", JSON.stringify({ setup, turns: finalTurns, report: result, interviewType }));
    } catch (e) { setBusy(""); setError(e instanceof Error ? e.message : "Could not prepare the report."); }
  }

  async function transcribeRecording(blob: Blob) {
    setTranscribing(true);
    try {
      const form = new FormData();
      const extension = blob.type.includes("mp4") ? "m4a" : blob.type.includes("ogg") ? "ogg" : "webm";
      form.append("audio", blob, `interview-answer.${extension}`);
      const response = await fetch("/api/interview", { method: "POST", body: form });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Speech transcription failed.");
      const transcript = String(result.text || "").trim();
      if (!transcript) throw new Error("I couldn't hear clear speech in that recording. Please try again, or use chat mode.");
      if (aiSpeakingRef.current || busyRef.current) {
        queuedSpeechRef.current = transcript;
        setQueuedSpeech(transcript);
      } else {
        setError("");
        submitAnswerRef.current(transcript);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not transcribe that recording.");
    } finally {
      setTranscribing(false);
    }
  }

  function toggleMic() {
    if (listening) {
      const recorder = mediaRecorderRef.current;
      if (recorder?.state === "recording") recorder.stop();
      setListening(false);
      return;
    }
    if (transcribing || micStartingRef.current) return;
    if (!window.isSecureContext) {
      setError("Microphone access requires HTTPS, or localhost while developing.");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("Microphone recording is unavailable in this browser. Try Chrome or Edge, or switch to chat mode.");
      return;
    }

    micStartingRef.current = true;
    setMicStarting(true);
    setError("");
    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        mediaStreamRef.current = stream;
        const mimeType = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find((type) => MediaRecorder.isTypeSupported(type));
        const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
        mediaChunksRef.current = [];
        recorder.ondataavailable = (event) => { if (event.data.size > 0) mediaChunksRef.current.push(event.data); };
        recorder.onerror = () => setError("Microphone recording failed. Check browser and system microphone permissions.");
        recorder.onstop = () => {
          setListening(false);
          const blob = new Blob(mediaChunksRef.current, { type: recorder.mimeType || "audio/webm" });
          mediaChunksRef.current = [];
          stream.getTracks().forEach((track) => track.stop());
          mediaStreamRef.current = null;
          mediaRecorderRef.current = null;
          if (discardRecordingRef.current) { discardRecordingRef.current = false; return; }
          if (blob.size === 0) setError("No audio was captured. Check your microphone and try again.");
          else void transcribeRecording(blob);
        };
        mediaRecorderRef.current = recorder;
        recorder.start(250);
        setListening(true);
      } catch (e) {
        mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
        mediaStreamRef.current = null;
        const name = e instanceof DOMException ? e.name : "";
        if (name === "NotAllowedError" || name === "SecurityError") setError("Microphone permission was blocked. Allow microphone access in your browser site settings, then try again.");
        else if (name === "NotFoundError") setError("No microphone was found. Connect or enable a microphone and try again.");
        else setError("Could not start the microphone. Check that it is connected and available to the browser.");
      } finally {
        micStartingRef.current = false;
        setMicStarting(false);
      }
    })();
  }

  function restart() {
    if (mediaRecorderRef.current?.state === "recording") { discardRecordingRef.current = true; mediaRecorderRef.current.stop(); } speechRunRef.current += 1; audioRef.current?.pause(); if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current); mediaStreamRef.current?.getTracks().forEach((track) => track.stop()); aiSpeakingRef.current = false; queuedSpeechRef.current = ""; localStorage.removeItem("interview-ready-session");
    setStage("upload"); setBusy(""); setResumeText(""); setResumeFile(""); setCandidateName(""); setParsedResume(null); setSetup(null); setTurns([]); setFollowUpCount(0); setReport(null); setError(""); setQueuedSpeech(""); setListening(false);
  }

  const minutes = String(Math.floor(clock / 60)).padStart(2, "0");
  const seconds = String(clock % 60).padStart(2, "0");
  if (busy && busy !== "Reviewing your answer") return <main className="loading"><div className="loading-card"><div className="brand-mark">IR</div><p className="eyebrow">INTERVIEW READY</p><h1>{busy}</h1><p className="muted">{busy === "Reading your resume" ? "Extracting resume text and identifying your experience" : busy === "Preparing your interview" ? "Matching the role with your background" : busy === "Reviewing your answer" ? "Saving your response and preparing the next question" : "Reviewing your answers and preparing coaching notes"}</p><div className="progress-track"><span style={{ width: `${progress}%` }} /></div><div className="progress-caption"><span>{busy === "Reading your resume" ? (progress < 35 ? "Reading PDF text" : progress < 75 ? "Processing skills and projects" : "Adding experience and certifications") : progress < 35 ? "Reading your context" : progress < 75 ? "Preparing the next step" : "Almost ready"}</span><strong>{progress}%</strong></div><div className="secure-note">Your resume is processed as text for this interview.</div></div></main>;

  return <main className="app-shell">
    <header className="topbar"><a className="brand" href="#" onClick={(e) => { e.preventDefault(); if (stage !== "upload") restart(); }}><span className="brand-mark">IR</span><span>interview<span className="brand-light">ready</span></span></a><div className="top-meta"><span className="privacy"><i />SESSION ONLINE</span><span className="top-divider" /> <span>Built for your next step</span></div></header>
    {error && <div className="error-banner" role="alert">{error}<button onClick={() => setError("")}>Dismiss</button></div>}

    {stage === "upload" && <section className="hero page-width"><div className="hero-copy"><div className="eyebrow"><span className="eyebrow-line" /> YOUR NEXT INTERVIEW STARTS HERE</div><h1>Show up ready.<br /><em>Leave nothing to chance.</em></h1><p className="hero-intro">focused practice session, built around your experience and the role you want (try maadroo).</p><div className="hero-checks"><span><b>01</b> Share your resume</span><span><b>02</b> Choose a role</span><span><b>03</b> Practice out loud</span></div></div><div className="upload-card"><div className="card-kicker">LET’S GET STARTED</div><h2>Bring your experience<br />into the room.</h2><p>Upload your resume and we’ll shape a practice interview around what you’ve actually done.</p><label className="dropzone"><input type="file" accept="application/pdf,.pdf" onChange={(e) => void onUpload(e.target.files?.[0])} /><span className="upload-icon"><svg viewBox="0 0 24 24"><path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M5 14v5h14v-5" /></svg></span><strong>Choose a PDF resume</strong><span className="muted small">or drag and drop it here</span><span className="file-limit">PDF format · Text-based PDFs work best</span></label><div className="card-footer"><span className="shield">◈</span> Your resume stays in this browser session</div></div><div className="hero-orbit orbit-one"/><div className="hero-orbit orbit-two"/></section>}

    {stage === "setup" && <section className="setup-layout page-width"><div className="setup-aside"><div className="eyebrow"><span className="eyebrow-line" /> STEP 02 — SESSION SETUP</div><h1>Make it feel like<br /><em>the real thing.</em></h1><p>Tell us what you’re preparing for. Your interview will be tailored to your background and the role.</p><div className="resume-chip"><span className="pdf-badge">PDF</span><div><strong>{resumeFile}</strong><small>Resume ready</small></div><button onClick={restart} aria-label="Change resume">↺</button></div><div className="aside-foot">GOOD PREPARATION CHANGES EVERYTHING <span>✳</span></div></div><div className="setup-card"><div className="card-kicker">YOUR PRACTICE SESSION</div><h2>Let’s set the scene.</h2><p className="setup-greeting">{candidateName ? `Hey ${candidateName}, ` : "Hey, "}what role are you getting ready for?</p><label className="field-label" htmlFor="role">TARGET ROLE <span>OPTIONAL IF YOU ADD A JOB DESCRIPTION</span></label><input id="role" value={role} onChange={(e) => setRole(e.target.value)} placeholder="e.g. Product Designer, Backend Engineer" /><label className="field-label" htmlFor="type">INTERVIEW STYLE</label><div className="select-wrap"><select id="type" value={interviewType} onChange={(e) => setInterviewType(e.target.value)}><option>Technical</option><option>HR</option></select><span>⌄</span></div>{interviewType === "Technical" && <><label className="field-label" htmlFor="difficulty">QUESTION DIFFICULTY</label><div className="select-wrap"><select id="difficulty" value={difficulty} onChange={(e) => setDifficulty(e.target.value)}><option value="easy">Easy</option><option value="moderate">Moderate</option><option value="hard">Hard</option></select><span>⌄</span></div></>}<label className="field-label" htmlFor="jd">JOB DESCRIPTION <span>PASTE THE FULL DESCRIPTION OR LEAVE BLANK</span></label><textarea id="jd" value={jobDescription} onChange={(e) => setJobDescription(e.target.value)} placeholder="Paste the job description here, or enter a role above and we’ll prepare one for you." rows={5} /><button className="primary-button" disabled={!role.trim() && !jobDescription.trim()} onClick={() => void startInterview()}>Prepare my interview <span>→</span></button><div className="button-caption">5 tailored questions · about 10 minutes</div></div></section>}

    {stage === "interview" && <section className="interview-layout page-width"><div className="interview-head"><div><div className="eyebrow"><span className="eyebrow-line" /> LIVE PRACTICE</div><h1>Your practice <em>room.</em></h1></div><div className="interview-stats"><span><small>FORMAT</small>{interviewType} interview</span><span><small>QUESTION</small>{Math.min(questionIndex + 1, 5)} <i>of 5</i></span><span className="timer"><small>SESSION</small>{minutes}:{seconds}</span></div></div><div className="interview-grid"><div className="coach-card"><div className="coach-top"><span className="live-dot" /> YOUR INTERVIEWER <span className="coach-tag">AI COACH</span></div><div className={`coach-avatar ${aiSpeaking ? "speaking" : ""}`}><div className="avatar-core"><span>IR</span></div><i className="ring ring-a"/><i className="ring ring-b"/><i className="ring ring-c"/></div><h2>{micStarting ? "Connecting your microphone" : transcribing ? "Transcribing your answer" : aiSpeaking ? "Listening as you speak" : "Take your time."}</h2><p>{aiSpeaking ? "Your response is being captured. I’ll finish this question, then listen." : micStarting ? "Allow microphone access if your browser asks." : transcribing ? "Sending the recording for transcription." : listening ? "Your microphone is on. Speak naturally when you’re ready." : "Answer as you would in the room. There’s no rush."}</p><div className="waveform" aria-hidden="true">{Array.from({ length: 31 }, (_, i) => <i key={i} style={{ height: `${10 + ((i * 17 + 13) % 25)}px` }} />)}</div><div className="voice-controls"><button className={`mic-button ${listening ? "mic-active" : ""}`} disabled={micStarting || transcribing} onClick={toggleMic} aria-label={listening ? "Stop recording" : "Start recording"}><svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0013 0M12 18v3m-4 0h8"/></svg></button><span>{micStarting ? "CONNECTING..." : transcribing ? "TRANSCRIBING..." : listening ? "TAP TO FINISH SPEAKING" : "TAP TO SPEAK"}</span></div><p className="voice-hint">{aiSpeaking ? "Speak now; your words will be sent when the interviewer finishes." : "Tap the mic, speak, then tap it again to send. You can also switch to chat."}</p></div><div className="conversation-card"><div className="conversation-top"><div><div className="card-kicker">SESSION TRANSCRIPT</div><h2>Your conversation</h2></div><div className="mode-switch"><button className={mode === "voice" ? "selected" : ""} onClick={() => setMode("voice")}>◖ Voice</button><button className={mode === "chat" ? "selected" : ""} onClick={() => setMode("chat")}>▤ Chat</button></div></div><div className="transcript" ref={transcriptRef}>{turns.map((turn, i) => <div className="turn-pair" key={i}><div className="message interviewer"><span className="speaker-label">INTERVIEWER</span><p>{turn.question}</p></div><div className="message candidate"><span className="speaker-label">YOU · RESPONSE {i + 1}</span><p>{turn.answer}</p></div></div>)}<div className="message interviewer"><span className="speaker-label">INTERVIEWER</span><p>{currentQuestion}</p></div>{queuedSpeech && <div className="message candidate"><span className="speaker-label">YOU · CAPTURING</span><p>{queuedSpeech}</p></div>}{draft && !aiSpeaking && <div className="message candidate draft"><span className="speaker-label">YOU · LIVE TRANSCRIPTION</span><p>{draft}</p></div>}</div>{mode === "chat" && <form className="chat-input" onSubmit={(e) => { e.preventDefault(); void sendAnswer(draft); }}><textarea value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Type your answer here…" rows={2} /><button disabled={!draft.trim()}>Send <span>↑</span></button></form>}<div className="conversation-foot"><span><i /> CONVERSATION SAVED ON THIS DEVICE</span><button onClick={() => void finishInterview()}>End interview <span>→</span></button></div></div></div></section>}

    {stage === "results" && report && <section className="results-layout page-width"><div className="results-heading"><div className="eyebrow"><span className="eyebrow-line" /> YOUR INTERVIEW DEBRIEF</div><h1>Good work. Now <em>get sharper.</em></h1><p>A coaching snapshot based on your answers for {role || "your target role"}.</p></div><div className="score-card"><div className="score-metric"><div className="score-number">{report.score}<span>/100</span></div><div className="score-scale"><span>BUILDING</span><span>ON TRACK</span><span>STRONG</span><i style={{ left: `${report.score}%` }} /></div></div><div className="score-copy"><div className="card-kicker">ESTIMATED INTERVIEW READINESS</div><h2>{report.headline}</h2><p>{report.summary}</p><small>This is an AI coaching estimate, not a prediction of a hiring decision.</small></div><div className="score-decoration">✳</div></div><div className="feedback-grid"><article className="feedback-card"><div className="feedback-icon green">↗</div><div className="card-kicker">WHAT’S WORKING</div><h3>Build on these strengths.</h3><ul>{report.strengths.map((item, i) => <li key={i}>{item}</li>)}</ul></article><article className="feedback-card"><div className="feedback-icon amber">✳</div><div className="card-kicker">ROOM TO GROW</div><h3>Make your next answer stronger.</h3><ul>{report.improvements.map((item, i) => <li key={i}>{item}</li>)}</ul></article><article className="feedback-card"><div className="feedback-icon blue">Aa</div><div className="card-kicker">COMMUNICATION</div><h3>Clarity and language.</h3>{report.grammarIssues.length ? <ul>{report.grammarIssues.map((item, i) => <li key={i}>{item}</li>)}</ul> : <p className="empty-feedback">No significant grammar patterns stood out. Keep your answers clear and structured.</p>}</article></div><div className="results-actions"><button className="primary-button" onClick={restart}>Practice again <span>→</span></button><span>{turns.length} answers reviewed · {interviewType} interview</span></div></section>}
    <footer className="site-footer">
  <span>INTERVIEW READY <i>✳</i></span>
  <span>Made by CHANDANMHJ.</span>
  <span>please visit - <a href="https://chandanmhj.in" target="_blank" rel="noopener noreferrer">chandanmhj.in</a></span>
</footer>
  </main>;
}
