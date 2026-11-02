import { ChatGroq } from "@langchain/groq";
import { StateGraph, Annotation, START, END } from "@langchain/langgraph";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

type Turn = { question: string; answer: string };
const State = Annotation.Root({
  input: Annotation<any>(),
  output: Annotation<any>(),
});

function model() {
  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey) {
    throw new Error(
      "GROQ_API_KEY is not configured. Add it to .env.local or your deployment environment variables.",
    );
  }

  return new ChatGroq({
    apiKey,
    model: process.env.GROQ_MODEL || "openai/gpt-oss-120b",
    temperature: 0.2,
  });
}

function parseJson(content: unknown): any {
  const text =
    typeof content === "string" ? content : JSON.stringify(content);
  const clean = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");

  return JSON.parse(clean);
}

async function runWorkflow(input: any) {
  const graph = new StateGraph(State)
    .addNode("process", async (state) => {
      const data = state.input;
      const llm = model();
      let output: any;

      if (data.action === "resume") {
        const prompt = `Extract structured resume details. Return ONLY valid JSON with keys candidateName (string, empty if not clearly present) and resume (object with summary, skills array, projects array, certifications array, experience string). Do not invent details. Resume text:
${String(data.resumeText).slice(0, 18000)}`;

        try {
          output = parseJson((await llm.invoke(prompt)).content);
        } catch {
          throw new Error(
            "Could not parse the resume details. Please try another PDF.",
          );
        }

        if (!output.resume || typeof output.resume !== "object") {
          throw new Error(
            "The resume details were incomplete. Please try another PDF.",
          );
        }
      } else if (data.action === "prepare") {
        const difficulty = ["easy", "moderate", "hard"].includes(
          String(data.difficulty || "").toLowerCase(),
        )
          ? String(data.difficulty).toLowerCase()
          : "moderate";
        const prompt = `Prepare a realistic mock interview. Return ONLY valid JSON with keys jobDescription and questions.

For a technical interview, questions must be an array of exactly five strings tailored to the resume and job description. The requested difficulty is ${difficulty.toUpperCase()}; calibrate all five technical questions to this level. Easy questions should focus on core concepts and straightforward applications. Moderate questions should require practical application, trade-offs, or multi-step reasoning. Hard questions should involve deeper design decisions, edge cases, or advanced reasoning appropriate to the candidate's experience. Do not exceed the selected difficulty.
For an HR interview, return an empty questions array; the app supplies those questions locally.

Candidate background: ${JSON.stringify(data.resume)}
Interview type: ${data.interviewType}
Role: ${data.role || ""}
Pasted job description: ${data.jobDescription || ""}

If a full job description is pasted, cleanly normalize it. If only a role is provided, write a concise, plausible job description.`;

        try {
          output = parseJson((await llm.invoke(prompt)).content);
        } catch {
          throw new Error(
            "The model returned an unreadable interview setup. Please try again.",
          );
        }

        output.resume = data.resume;
        output.candidateName = data.candidateName || "";
        output.difficulty = difficulty;

        if (data.interviewType === "HR") {
          const questions = [
            "Where do you see yourself in 5 years?",
            "Tell me about a conflict or mistake.",
            "What are your weaknesses?",
            "Tell me about yourself.",
            "Why do you want to work at this company?",
            "How do you handle disagreement with a technical decision or team member?",
            "Describe a project you are most proud of.",
            "Tell me about a time you had to learn a new tool or technology quickly.",
          ];

          // Shuffle locally so the model does not choose the HR questions.
          for (let i = questions.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [questions[i], questions[j]] = [questions[j], questions[i]];
          }

          output.questions = questions.slice(0, 5);
        }

        if (!Array.isArray(output.questions) || output.questions.length !== 5) {
          throw new Error(
            "The model did not create five interview questions. Please try again.",
          );
        }
      } else if (data.action === "answer") {
        const turns: Turn[] = Array.isArray(data.turns) ? data.turns : [];
        const questionIndex = Math.max(
          0,
          Math.min(4, Number(data.questionIndex) || 0),
        );
        const currentQuestion = String(data.currentQuestion || "").trim();
        const answer = String(data.answer || "").trim();
        const questions: string[] = Array.isArray(data.questions)
          ? data.questions
          : [];

        if (!currentQuestion || !questions.length) {
          throw new Error("The current interview question is missing.");
        }

        if (questionIndex >= 5) {
          throw new Error("This interview already has five questions.");
        }

        /*
         * A clear pass is not treated as an incomplete answer. The candidate
         * may say "I don't know", "I don't remember", "skip", or a similar
         * phrase and the interview advances to the next prepared question.
         */
        const passPattern =
          /\b(i\s*(?:do\s*not|don't|dont)\s*(?:know|remember)|no\s*idea|not\s*sure|i\s*cannot\s*answer|i\s*can't\s*answer|skip(?:\s*this)?|pass(?:\s*this)?)\b/i;
        const isPass = passPattern.test(answer);
        const followUpCount = Math.max(0, Number(data.followUpCount) || 0);

        let satisfactory = isPass;
        let nextQuestion = "";
        let feedback = "";

        if (!isPass) {
          const prompt = `You are a professional, supportive ${data.interviewType} interviewer.

Role and job description:
${data.jobDescription}

Candidate background:
${JSON.stringify(data.resume)}

The five prepared questions, in fixed order:
${JSON.stringify(questions)}

Earlier question and answer turns:
${JSON.stringify(turns)}

Current question (keep this exact question if asking a follow-up):
${currentQuestion}

Candidate's latest answer:
${answer.slice(0, 5000)}

Decide whether the answer substantially addresses the current question.

Rules:
- If the answer is blank, unrelated, or clearly does not answer the question, mark satisfactory false and ask one brief follow-up about the SAME question. Do not ask a new prepared question in that case.
- If the answer addresses the question well enough for practice, mark satisfactory true and move to the next prepared question. Do not ask the current question again just to seek a perfect answer.
- A satisfactory answer must advance immediately. Do not ask a follow-up after an answer that addresses the question.
- You may ask at most one follow-up for a prepared question. If the candidate answers that follow-up, move to the next prepared question even if the explanation is still imperfect.
- If the candidate explicitly says they do not know, do not ask them to try again. The application handles clear "I don't know", "I don't remember", "skip", or "pass" responses as a pass and advances automatically.
- Do not change the wording of the next prepared question.
- Keep feedback to one short acknowledgement. Do not reveal private reasoning.

This is prepared question ${questionIndex + 1} of 5.

Return ONLY valid JSON:
{"satisfactory": boolean, "feedback": "one short acknowledgement", "followUp": "brief same-question follow-up or empty string"}`;

          try {
            output = parseJson((await llm.invoke(prompt)).content);
          } catch {
            throw new Error("Could not process that answer. Please try again.");
          }

          satisfactory = Boolean(output.satisfactory) || followUpCount >= 1;
          feedback = String(output.feedback || "");
          if (!output.satisfactory && followUpCount >= 1) {
            feedback = "Thanks for explaining. Let’s move to the next question.";
          }
        } else {
          feedback = "Thanks for letting me know. Let’s move to the next question.";
        }

        const nextIndex = satisfactory ? questionIndex + 1 : questionIndex;
        const complete = satisfactory && nextIndex >= 5;

        if (complete) {
          nextQuestion = "";
        } else if (satisfactory) {
          // The prepared sequence is the source of truth for the next question.
          nextQuestion = String(questions[nextIndex] || "");
        } else {
          // On an insufficient answer, retain the same question and request
          // only a focused follow-up. Fall back to repeating it if needed.
          nextQuestion =
            String(output?.followUp || "").trim() || currentQuestion;
        }

        output = {
          satisfactory,
          feedback,
          complete,
          questionIndex: nextIndex,
          followUpCount: satisfactory ? 0 : followUpCount + 1,
          nextQuestion,
        };
      } else if (data.action === "results") {
        const prompt = `You are an experienced interview coach. Review this ${data.interviewType} interview for the role described here: ${data.jobDescription}.

Candidate background:
${JSON.stringify(data.resume)}

Question and answer turns:
${JSON.stringify(data.turns)}

Give practical feedback grounded in the answers. Treat answers like "I don't know" as a valid choice to move on, but explain in the feedback that the candidate should prepare that topic if relevant. The score is an estimated interview readiness score, not a real hiring probability. Identify only substantial grammar problems; ignore minor slips.

Return ONLY valid JSON:
{"score": integer from 0 to 100, "headline": string, "strengths": string[], "improvements": string[], "grammarIssues": string[], "summary": string}

Keep the tone professional and constructive. Do not claim to know the actual hiring outcome.`;

        try {
          output = parseJson((await llm.invoke(prompt)).content);
        } catch {
          throw new Error("Could not create the interview report. Please try again.");
        }

        output.score = Math.max(0, Math.min(100, Number(output.score) || 0));
      } else {
        throw new Error("Unknown interview action.");
      }

      return { output };
    })
    .addEdge(START, "process")
    .addEdge("process", END)
    .compile();

  return (await graph.invoke({ input, output: null })).output;
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const result = await runWorkflow(body);
    return NextResponse.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected server error.";
    const status = message.includes("GROQ_API_KEY") ? 503 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
