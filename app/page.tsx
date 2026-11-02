"use client";

import { useEffect, useRef, useState } from "react";

type Turn = { question: string; answer: string };
type Setup = { candidateName: string; resume: { summary?: string; skills?: string[]; projects?: string[]; certifications?: string[]; experience?: string }; jobDescription: string; questions: string[] };
type Report = { score: number; headline: string; strengths: string[]; improvements: string[]; grammarIssues: string[]; summary: string };
type Stage = "upload" | "setup" | "interview" | "results";

async function api(payload: unknown) {
  const response = await fetch("/api/interview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const data = await response.json();
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
  const [aiSpeaking, setAiSpeaking] = useState(false);
  const [queuedSpeech, setQueuedSpeech] = useState("");
  const [report, setReport] = useState<Report | null>(null);
  const [clock, setClock] = useState(0);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const queuedSpeechRef = useRef("");
  const aiSpeakingRef = useRef(false);
  const busyRef = useRef(false);
  const recognitionRef = useRef<any>(null);
  const micActiveRef = useRef(false);
  const manualStopRef = useRef(false);
  const finalTranscriptRef = useRef("");
  const interimTranscriptRef = useRef("");
  const micStartingRef = useRef(false);
  const recognitionRestartRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const manualStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const speechRunRef = useRef(0);
  const draftRef = useRef("");
  const submitAnswerRef = useRef<(text: string) => void>(() => undefined);

  useEffect(() => { const timer = window.setInterval(() => setClock((value) => value + 1), 1000); return () => window.clearInterval(timer); }, []);
  useEffect(() => { busyRef.current = Boolean(busy); }, [busy]);
  useEffect(() => { transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: "smooth" }); }, [turns, currentQuestion]);
  useEffect(() => () => {
    micActiveRef.current = false;
    if (recognitionRestartRef.current) clearTimeout(recognitionRestartRef.current);
    if (manualStopTimerRef.current) clearTimeout(manualStopTimerRef.current);
    try { recognitionRef.current?.stop(); } catch { /* recognition may already be stopped */ }
    window.speechSynthesis?.cancel();
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

  function browserVoice(text: string) {
    return new Promise<void>((resolve, reject) => {
      if (!("speechSynthesis" in window)) {
        reject(new Error("Speech synthesis is unavailable."));
        return;
      }
      const synth = window.speechSynthesis;
      const utterance = new SpeechSynthesisUtterance(text);
      const voices = synth.getVoices();
      utterance.voice = voices.find((voice) => /natural|online|neural|aria|jenny|samantha|google us english/i.test(voice.name) && voice.lang.toLowerCase().startsWith("en"))
        || voices.find((voice) => voice.lang.toLowerCase().startsWith("en"))
        || null;
      utterance.rate = 0.96;
      utterance.pitch = 1;
      utterance.onend = () => resolve();
      utterance.onerror = () => reject(new Error("Device speech failed."));
      synth.speak(utterance);
    });
  }

  function say(text: string) {
    if (!text.trim()) return;
    if (!("speechSynthesis" in window)) {
      setError("This browser does not provide speech output. The interviewer question is still shown in the transcript.");
      return;
    }
    const run = ++speechRunRef.current;
    window.speechSynthesis.cancel();
    aiSpeakingRef.current = true;
    setAiSpeaking(true);
    browserVoice(text).then(() => finishSpeech(run)).catch(() => {
      if (run !== speechRunRef.current) return;
      setError("The device could not play speech. The question is still shown in the transcript.");
      finishSpeech(run);
    });
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
      setReport(result); setStage("results"); setBusy(""); window.speechSynthesis?.cancel();
      localStorage.setItem("interview-ready-session", JSON.stringify({ setup, turns: finalTurns, report: result, interviewType }));
    } catch (e) { setBusy(""); setError(e instanceof Error ? e.message : "Could not prepare the report."); }
  }

  function toggleMic() {
    if (listening) {
      manualStopRef.current = true;
      micActiveRef.current = false;
      if (recognitionRestartRef.current) clearTimeout(recognitionRestartRef.current);
      try { recognitionRef.current?.stop(); } catch { handleRecognizedAnswer(); }
      manualStopTimerRef.current = setTimeout(() => {
        if (manualStopRef.current) handleRecognizedAnswer();
      }, 700);
      return;
    }
    if (micStartingRef.current) return;
    if (!window.isSecureContext) {
      setError("Microphone access requires HTTPS, or localhost while developing.");
      return;
    }
    const Recognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!Recognition) {
      setError("Live speech recognition isn't supported in this browser. Try the latest Chrome or Edge, or switch to chat mode.");
      return;
    }

    const recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.lang = navigator.language.toLowerCase().startsWith("en")
      ? navigator.language
      : "en-US";
    recognitionRef.current = recognition;
    micActiveRef.current = true;
    manualStopRef.current = false;
    finalTranscriptRef.current = "";
    interimTranscriptRef.current = "";
    draftRef.current = "";
    setDraft("");
    micStartingRef.current = true;
    setMicStarting(true);
    setError("");
    recognition.onstart = () => {
      micStartingRef.current = false;
      setMicStarting(false);
      setListening(true);
    };
    recognition.onresult = (event: any) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0]?.transcript || "";
        if (result.isFinal) finalTranscriptRef.current += `${text} `;
        else interim += text;
      }
      interimTranscriptRef.current = interim;
      const transcript = `${finalTranscriptRef.current} ${interimTranscriptRef.current}`.trim();
      if (!transcript) return;
      if (aiSpeakingRef.current || busyRef.current) {
        queuedSpeechRef.current = transcript;
        setQueuedSpeech(transcript);
      } else {
        draftRef.current = transcript;
        setDraft(transcript);
      }
    };
    recognition.onerror = (event: any) => {
      const reason = String(event.error || "");
      if (reason === "no-speech") return;
      micActiveRef.current = false;
      micStartingRef.current = false;
      setMicStarting(false);
      setListening(false);
      if (reason === "not-allowed" || reason === "service-not-allowed") {
        setError("The browser blocked microphone access. Allow it for this site in the address-bar or site settings, then reload and try again.");
      } else if (reason === "audio-capture") {
        setError("The browser could not access a microphone. Check the selected input device and system microphone permission.");
      } else if (reason === "network") {
        setError("The browser speech service is unavailable. Check your connection, or switch to chat mode.");
      } else {
        setError(`Microphone recognition stopped (${reason || "unknown error"}). Check browser microphone permission and try again.`);
      }
    };
    recognition.onend = () => {
      if (manualStopRef.current) {
        if (manualStopTimerRef.current) clearTimeout(manualStopTimerRef.current);
        manualStopRef.current = false;
        micActiveRef.current = false;
        setListening(false);
        handleRecognizedAnswer();
        return;
      }
      if (micActiveRef.current) {
        if (recognitionRestartRef.current) clearTimeout(recognitionRestartRef.current);
        recognitionRestartRef.current = setTimeout(() => {
          if (!micActiveRef.current) return;
          try { recognition.start(); }
          catch {
            micActiveRef.current = false;
            setListening(false);
            setError("Speech recognition ended. Tap the mic to start it again, or switch to chat mode.");
          }
        }, 250);
      } else {
        setListening(false);
      }
    };

    try {
      recognition.start();
    } catch (e) {
      micActiveRef.current = false;
      micStartingRef.current = false;
      setMicStarting(false);
      setListening(false);
      setError(e instanceof Error ? `Could not start speech recognition: ${e.message}` : "Could not start speech recognition. Check microphone permission and try again.");
    }
  }

  function handleRecognizedAnswer() {
    manualStopRef.current = false;
    micActiveRef.current = false;
    setListening(false);
    const transcript = `${finalTranscriptRef.current} ${interimTranscriptRef.current}`.trim();
    finalTranscriptRef.current = "";
    interimTranscriptRef.current = "";
    draftRef.current = "";
    setDraft("");
    if (!transcript) {
      setError("I didn't catch any speech. Check your microphone input, speak after tapping the mic, then tap it again to submit.");
      return;
    }
    if (aiSpeakingRef.current || busyRef.current) {
      queuedSpeechRef.current = transcript;
      setQueuedSpeech(transcript);
    } else {
      setError("");
      submitAnswerRef.current(transcript);
    }
  }

  function restart() {
    micActiveRef.current = false; manualStopRef.current = false; try { recognitionRef.current?.stop(); } catch { /* recognition may already be stopped */ } if (recognitionRestartRef.current) clearTimeout(recognitionRestartRef.current); speechRunRef.current += 1; window.speechSynthesis?.cancel(); aiSpeakingRef.current = false; queuedSpeechRef.current = ""; localStorage.removeItem("interview-ready-session");
    setStage("upload"); setBusy(""); setResumeText(""); setResumeFile(""); setCandidateName(""); setParsedResume(null); setSetup(null); setTurns([]); setFollowUpCount(0); setReport(null); setError(""); setQueuedSpeech(""); setListening(false);
  }

  const minutes = String(Math.floor(clock / 60)).padStart(2, "0");
  const seconds = String(clock % 60).padStart(2, "0");
  if (busy && busy !== "Reviewing your answer") return <main className="loading"><div className="loading-card"><div className="brand-mark">IR</div><p className="eyebrow">INTERVIEW READY</p><h1>{busy}</h1><p className="muted">{busy === "Reading your resume" ? "Extracting resume text and identifying your experience" : busy === "Preparing your interview" ? "Matching the role with your background" : busy === "Reviewing your answer" ? "Saving your response and preparing the next question" : "Reviewing your answers and preparing coaching notes"}</p><div className="progress-track"><span style={{ width: `${progress}%` }} /></div><div className="progress-caption"><span>{busy === "Reading your resume" ? (progress < 35 ? "Reading PDF text" : progress < 75 ? "Processing skills and projects" : "Adding experience and certifications") : progress < 35 ? "Reading your context" : progress < 75 ? "Preparing the next step" : "Almost ready"}</span><strong>{progress}%</strong></div><div className="secure-note">Your resume is processed as text for this interview.</div></div></main>;

  return <main className="app-shell">
    <header className="topbar"><a className="brand" href="#" onClick={(e) => { e.preventDefault(); if (stage !== "upload") restart(); }}><span className="brand-mark">IR</span><span>interview<span className="brand-light">ready</span></span></a><div className="top-meta"><span className="privacy"><i /> online</span><span className="top-divider" /> <span>Built for your next step</span></div></header>
    {error && <div className="error-banner" role="alert">{error}<button onClick={() => setError("")}>Dismiss</button></div>}

    {stage === "upload" && <section className="hero page-width"><div className="hero-copy"><div className="eyebrow"><span className="eyebrow-line" /> YOUR NEXT INTERVIEW STARTS HERE</div><h1>Show up ready.<br /><em>Leave nothing to chance.</em></h1><p className="hero-intro">congrats broo interview sigtha, baa nin knowledge test madko - upload your resume with the job description and attend an ai interview.</p><div className="hero-checks"><span><b>01</b> Share your resume</span><span><b>02</b> Choose a role</span><span><b>03</b> Practice out loud</span></div></div><div className="upload-card"><div className="card-kicker">LET’S GET STARTED</div><h2>Bring your experience<br />into the room.</h2><p>Upload your resume and we’ll shape a practice interview around what you’ve actually done.</p><label className="dropzone"><input type="file" accept="application/pdf,.pdf" onChange={(e) => void onUpload(e.target.files?.[0])} /><span className="upload-icon"><svg viewBox="0 0 24 24"><path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M5 14v5h14v-5" /></svg></span><strong>Choose a PDF resume</strong><span className="muted small">or drag and drop it here</span><span className="file-limit">PDF format · Text-based PDFs work best</span></label><div className="card-footer"><span className="shield">◈</span> Your resume stays in this browser session</div></div><div className="hero-orbit orbit-one"/><div className="hero-orbit orbit-two"/></section>}

    {stage === "setup" && <section className="setup-layout page-width"><div className="setup-aside"><div className="eyebrow"><span className="eyebrow-line" /> STEP 02 — SESSION SETUP</div><h1>Make it feel like<br /><em>the real thing.</em></h1><p>Tell us what you’re preparing for. Your interview will be tailored to your background and the role.</p><div className="resume-chip"><span className="pdf-badge">PDF</span><div><strong>{resumeFile}</strong><small>Resume ready</small></div><button onClick={restart} aria-label="Change resume">↺</button></div><div className="aside-foot">GOOD PREPARATION CHANGES EVERYTHING <span>✳</span></div></div><div className="setup-card"><div className="card-kicker">YOUR PRACTICE SESSION</div><h2>Let’s set the scene.</h2><p className="setup-greeting">{candidateName ? `Hey ${candidateName}, ` : "Hey, "}what role are you getting ready for?</p><label className="field-label" htmlFor="role">TARGET ROLE <span>OPTIONAL IF YOU ADD A JOB DESCRIPTION</span></label><input id="role" value={role} onChange={(e) => setRole(e.target.value)} placeholder="e.g. Product Designer, Backend Engineer" /><label className="field-label" htmlFor="type">INTERVIEW STYLE</label><div className="select-wrap"><select id="type" value={interviewType} onChange={(e) => setInterviewType(e.target.value)}><option>Technical</option><option>HR</option></select><span>⌄</span></div>{interviewType === "Technical" && <><label className="field-label" htmlFor="difficulty">QUESTION DIFFICULTY</label><div className="select-wrap"><select id="difficulty" value={difficulty} onChange={(e) => setDifficulty(e.target.value)}><option value="easy">Easy</option><option value="moderate">Moderate</option><option value="hard">Hard</option></select><span>⌄</span></div></>}<label className="field-label" htmlFor="jd">JOB DESCRIPTION <span>PASTE THE FULL DESCRIPTION OR LEAVE BLANK</span></label><textarea id="jd" value={jobDescription} onChange={(e) => setJobDescription(e.target.value)} placeholder="Paste the job description here, or enter a role above and we’ll prepare one for you." rows={5} /><button className="primary-button" disabled={!role.trim() && !jobDescription.trim()} onClick={() => void startInterview()}>Prepare my interview <span>→</span></button><div className="button-caption">5 tailored questions · about 10 minutes</div></div></section>}

    {stage === "interview" && <section className="interview-layout page-width"><div className="interview-head"><div><div className="eyebrow"><span className="eyebrow-line" /> LIVE PRACTICE</div><h1>Your practice <em>room.</em></h1></div><div className="interview-stats"><span><small>FORMAT</small>{interviewType} interview</span><span><small>QUESTION</small>{Math.min(questionIndex + 1, 5)} <i>of 5</i></span><span className="timer"><small>SESSION</small>{minutes}:{seconds}</span></div></div><div className="interview-grid"><div className="coach-card"><div className="coach-top"><span className="live-dot" /> YOUR INTERVIEWER <span className="coach-tag">AI COACH</span></div><div className={`coach-avatar ${aiSpeaking ? "speaking" : ""}`}><div className="avatar-core"><span>IR</span></div><i className="ring ring-a"/><i className="ring ring-b"/><i className="ring ring-c"/></div><h2>{micStarting ? "Starting your microphone" : aiSpeaking ? "Listening as you speak" : "Take your time."}</h2><p>{aiSpeaking ? "Your response is being captured. I’ll finish this question, then listen." : micStarting ? "Waiting for microphone access." : listening ? "Your microphone is on. Speak naturally when you’re ready." : "Answer as you would in the room. There’s no rush."}</p><div className="waveform" aria-hidden="true">{Array.from({ length: 31 }, (_, i) => <i key={i} style={{ height: `${10 + ((i * 17 + 13) % 25)}px` }} />)}</div><div className="voice-controls"><button className={`mic-button ${listening ? "mic-active" : ""}`} disabled={micStarting} onClick={toggleMic} aria-label={listening ? "Stop recording" : "Start recording"}><svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0013 0M12 18v3m-4 0h8"/></svg></button><span>{micStarting ? "STARTING..." : listening ? "TAP TO FINISH SPEAKING" : "TAP TO SPEAK"}</span></div><p className="voice-hint">{aiSpeaking ? "Speak now; your words will be sent when the interviewer finishes." : "Tap the mic, speak, then tap it again to send. You can also switch to chat."}</p></div><div className="conversation-card"><div className="conversation-top"><div><div className="card-kicker">SESSION TRANSCRIPT</div><h2>Your conversation</h2></div><div className="mode-switch"><button className={mode === "voice" ? "selected" : ""} onClick={() => setMode("voice")}>◖ Voice</button><button className={mode === "chat" ? "selected" : ""} onClick={() => setMode("chat")}>▤ Chat</button></div></div><div className="transcript" ref={transcriptRef}>{turns.map((turn, i) => <div className="turn-pair" key={i}><div className="message interviewer"><span className="speaker-label">INTERVIEWER</span><p>{turn.question}</p></div><div className="message candidate"><span className="speaker-label">YOU · RESPONSE {i + 1}</span><p>{turn.answer}</p></div></div>)}<div className="message interviewer"><span className="speaker-label">INTERVIEWER</span><p>{currentQuestion}</p></div>{queuedSpeech && <div className="message candidate"><span className="speaker-label">YOU · CAPTURING</span><p>{queuedSpeech}</p></div>}{draft && !aiSpeaking && <div className="message candidate draft"><span className="speaker-label">YOU · LIVE TRANSCRIPTION</span><p>{draft}</p></div>}</div>{mode === "chat" && <form className="chat-input" onSubmit={(e) => { e.preventDefault(); void sendAnswer(draft); }}><textarea value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Type your answer here…" rows={2} /><button disabled={!draft.trim()}>Send <span>↑</span></button></form>}<div className="conversation-foot"><span><i /> CONVERSATION SAVED ON THIS DEVICE</span><button onClick={() => void finishInterview()}>End interview <span>→</span></button></div></div></div></section>}

    {stage === "results" && report && <section className="results-layout page-width"><div className="results-heading"><div className="eyebrow"><span className="eyebrow-line" /> YOUR INTERVIEW DEBRIEF</div><h1>Good work. Now <em>get sharper.</em></h1><p>A coaching snapshot based on your answers for {role || "your target role"}.</p></div><div className="score-card"><div className="score-metric"><div className="score-number">{report.score}<span>/100</span></div><div className="score-scale"><span>BUILDING</span><span>ON TRACK</span><span>STRONG</span><i style={{ left: `${report.score}%` }} /></div></div><div className="score-copy"><div className="card-kicker">ESTIMATED INTERVIEW READINESS</div><h2>{report.headline}</h2><p>{report.summary}</p><small>This is an AI coaching estimate, not a prediction of a hiring decision.</small></div><div className="score-decoration">✳</div></div><div className="feedback-grid"><article className="feedback-card"><div className="feedback-icon green">↗</div><div className="card-kicker">WHAT’S WORKING</div><h3>Build on these strengths.</h3><ul>{report.strengths.map((item, i) => <li key={i}>{item}</li>)}</ul></article><article className="feedback-card"><div className="feedback-icon amber">✳</div><div className="card-kicker">ROOM TO GROW</div><h3>Make your next answer stronger.</h3><ul>{report.improvements.map((item, i) => <li key={i}>{item}</li>)}</ul></article><article className="feedback-card"><div className="feedback-icon blue">Aa</div><div className="card-kicker">COMMUNICATION</div><h3>Clarity and language.</h3>{report.grammarIssues.length ? <ul>{report.grammarIssues.map((item, i) => <li key={i}>{item}</li>)}</ul> : <p className="empty-feedback">No significant grammar patterns stood out. Keep your answers clear and structured.</p>}</article></div><div className="results-actions"><button className="primary-button" onClick={restart}>Practice again <span>→</span></button><span>{turns.length} answers reviewed · {interviewType} interview</span></div></section>}
    <footer className="site-footer">
  <span>INTERVIEW READY <i>✳</i></span>
  <span>Made by CHANDANMHJ.</span>
  <span>please visit - <a href="https://chandanmhj.in" target="_blank" rel="noopener noreferrer">chandanmhj.in</a></span>
</footer>
  </main>;
}
