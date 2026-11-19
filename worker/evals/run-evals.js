#!/usr/bin/env node
// Manual regression eval harness - NOT part of the vitest suite, NOT run in
// CI, NOT triggered automatically by anything. Run it by hand before a risky
// change: a model swap, a prompt rewrite, a retrieval/reranking change, a
// swapped PDF/chunking library, etc. See CLAUDE.md / worker/evals/README.md
// (if present) for the full rationale.
//
// Usage:
//   node evals/run-evals.js [--model=SLUG] [--judge-model=SLUG] [--no-judge]
//                           [--feature-changed="what changed"] [--worker-url=URL]
//                           [--admin-key=KEY] [--out-dir=DIR]
//
// --model          Model slug to test generation with, overriding the live
//                   config for this run only (never touches production
//                   traffic/config). Defaults to the worker's configured
//                   evalModelSlug (Settings tab) if set, else errors.
// --judge-model     Model slug used to GRADE answers. Deliberately defaults
//                   to a different model than generation (see judgeModel
//                   below) to avoid a model grading its own homework.
// --no-judge        Skip the LLM judge entirely and use a cheap, literal
//                   substring check (case.cheapKeywords) instead. Zero extra
//                   LLM calls - use this for a quick sanity pass; the judge
//                   is the authoritative default because it checks meaning,
//                   not exact wording.
// --feature-changed Free-text label stored in the report, e.g.
//                   --feature-changed="switched chat model to X". Lets you
//                   grep report history for what caused a result to change.
// --worker-url      Required (or set EVAL_WORKER_URL): the STAGING worker URL.
//                   Production is refused unless --allow-prod is also passed.
// --admin-key       Falls back to ADMIN_API_KEY from the environment or
//                   worker/.dev.vars.
// --out-dir         Defaults to evals/results/ (gitignored).
// --case=id1,id2    Run only the listed case ids from the cases file.
// --suite=NAME      Which suite to run: "golden" (default, golden-cases.json)
//                   or "client" (client-papers-cases.json: the client's
//                   official Science and Maths papers). Shortcuts:
//                   npm run eval:golden / npm run eval:client.
// --cases=FILE      Any other cases file (overrides --suite).
// --reference-dir   Folder holding the official PDFs named in a
//                   questionPaper case's "referenceFiles" (or set
//                   EVAL_REFERENCE_DIR). Default: evals/reference-papers/
//                   (gitignored - the client's PDFs are not committed).
// --reference-judge-model  Model for the reference check (default
//                   openai/gpt-4.1: gpt-4o-mini gave many wrong verdicts
//                   when checking paper answers).
//
// questionPaper cases may carry "referenceFiles": [paper.pdf, key.pdf] and
// "maxWrongAnswers". Then, besides the marks check and any factChecks, the
// generated paper + answer key are (1) checked structurally (one answer per
// question, no blank/placeholder answers, no duplicate questions, no mark
// tags like [1] in question text) and (2) compared by the reference judge
// with the official paper and key: a reused question's answer must agree
// with the official key, a changed or new question's answer must be correct.
//
// Case modes (golden-cases.json "mode" field): "chat" (/chat, answerStyle=auto -
// strictly grounded, no model override support issue here since /chat honors
// modelOverride), "explain" (/explain, Concept Explainer - note: /explain has
// no modelOverride or admin-key gate, so this mode always reflects whatever
// model is live in production config, not --model), "questionPaper"
// (/question-paper/generate + /answer-key, deliberately allowed to fall back
// to general syllabus knowledge where source text is thin - see
// questionPaperGeneration.ts).

const fs = require("fs");
const path = require("path");

// A different vendor/family than the default generation model (OpenAI) and
// the default question-paper enrichment model, chosen for the same reason
// documented in llm.ts: a model shouldn't grade its own homework. Already
// proven reachable via OpenRouter elsewhere in this codebase (ingestion
// enrichment uses the same slug).
const JUDGE_MODEL_DEFAULT = "openai/gpt-4o-mini";
// Evals run against STAGING. The golden PDFs live there, and the production
// worker is only reachable with an explicit --allow-prod (see docs/ENVIRONMENTS.md).
const PROD_WORKER_URL = "https://edu-live-worker.buildminds-co-in.workers.dev";

function parseArgs(argv) {
  const args = {};
  for (const raw of argv) {
    const m = raw.match(/^--([a-zA-Z-]+)(?:=(.*))?$/);
    if (!m) continue;
    const key = m[1];
    args[key] = m[2] === undefined ? true : m[2];
  }
  return args;
}

// Reads KEY=VALUE lines from worker/.dev.vars for secrets not already in
// process.env - same convention wrangler itself uses for local dev.
function loadDevVars() {
  const varsPath = path.join(__dirname, "..", ".dev.vars");
  if (!fs.existsSync(varsPath)) return {};
  const out = {};
  for (const line of fs.readFileSync(varsPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return out;
}

function parseLlmJsonLoose(raw) {
  const trimmed = raw.trim();
  const attempts = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) attempts.push(fenced[1]);
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) attempts.push(trimmed.slice(first, last + 1));
  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate);
    } catch (_) {
      // try next candidate
    }
  }
  throw new Error(`judge returned unparseable JSON: ${raw.slice(0, 200)}`);
}

async function callOpenRouter(openrouterKey, model, system, user, maxTokens) {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openrouterKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: maxTokens,
    }),
  });
  if (!response.ok) {
    throw new Error(`OpenRouter call failed (${response.status}): ${await response.text()}`);
  }
  const body = await response.json();
  const content = body.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenRouter call returned no content");
  return content;
}

const JUDGE_SYSTEM_PROMPT =
  "You are grading a student-facing answer for factual correctness against a list of key facts. " +
  "Each key fact must be correctly conveyed IN MEANING - paraphrasing, reordering, different wording, or " +
  "extra correct detail all count as a pass. Only fail if a key fact is actually missing, contradicted, or " +
  "replaced with something factually wrong. Do not fail for missing elaboration, missing citations, " +
  "formatting differences, or brevity. Reply with ONLY a JSON object: " +
  '{"pass": boolean, "reason": "one short sentence"}.';

async function judge(openrouterKey, judgeModel, keyFacts, answerText) {
  const user =
    `Key facts the answer must correctly convey:\n${keyFacts.map((f) => `- ${f}`).join("\n")}\n\n` +
    `Actual answer:\n${answerText || "(empty)"}`;
  const raw = await callOpenRouter(openrouterKey, judgeModel, JUDGE_SYSTEM_PROMPT, user, 150);
  const parsed = parseLlmJsonLoose(raw);
  return { pass: parsed.pass === true, reason: typeof parsed.reason === "string" ? parsed.reason : "" };
}

function cheapCheck(keywords, text) {
  const haystack = (text || "").toLowerCase();
  const missing = (keywords || []).filter((kw) => !haystack.includes(kw.toLowerCase()));
  return { pass: missing.length === 0, reason: missing.length ? `missing: ${missing.join(", ")}` : "all keywords present" };
}

async function grade(mode, { keyFacts, cheapKeywords, answerText, openrouterKey, judgeModel }) {
  if (mode === "cheap") return cheapCheck(cheapKeywords, answerText);
  return judge(openrouterKey, judgeModel, keyFacts, answerText);
}

async function runChatCase(workerUrl, adminKey, modelOverride, testCase) {
  const response = await fetch(`${workerUrl}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(adminKey ? { "x-admin-key": adminKey } : {}) },
    body: JSON.stringify({
      question: testCase.question,
      answerStyle: "auto",
      ...(modelOverride ? { modelOverride } : {}),
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `/chat failed (${response.status})`);
  return { answerText: body.answer || "", raw: body };
}

// /explain has no modelOverride support (explain.ts always uses the live
// config's provider/model) and no admin-key gate, unlike /chat and
// /question-paper/generate - so modelOverride is accepted here only to keep
// the call signature consistent with the other run*Case functions, and is
// silently ignored.
async function runExplainCase(workerUrl, _adminKey, _modelOverride, testCase) {
  const response = await fetch(`${workerUrl}/explain`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ concept: testCase.concept }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `/explain failed (${response.status})`);
  // Combine every prose/structured field the student actually sees - a fact
  // could legitimately land in "definition" or a table cell instead of
  // simpleExplanation, and the judge should see all of it.
  const tableText = body.table
    ? [body.table.headers?.join(" | "), ...(body.table.rows || []).map((r) => r.join(" | "))]
        .filter(Boolean)
        .join("\n")
    : "";
  const combinedText = [
    body.simpleExplanation,
    Array.isArray(body.steps) ? body.steps.join(" ") : "",
    body.formula,
    body.definition,
    tableText,
    body.realWorldExample,
  ]
    .filter(Boolean)
    .join("\n");
  return { answerText: combinedText, raw: body };
}

async function runQuestionPaperCase(workerUrl, adminKey, modelOverride, testCase) {
  const genResponse = await fetch(`${workerUrl}/question-paper/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(adminKey ? { "x-admin-key": adminKey } : {}) },
    body: JSON.stringify({
      subject: testCase.subject,
      chapterFilenames: testCase.chapterFilenames,
      marksTotal: testCase.marksTotal,
      ...(modelOverride ? { modelOverride } : {}),
    }),
  });
  const genBody = await genResponse.json().catch(() => ({}));
  if (!genResponse.ok) throw new Error(genBody.error || `/question-paper/generate failed (${genResponse.status})`);

  const akResponse = await fetch(`${workerUrl}/question-paper/${encodeURIComponent(genBody.id)}/answer-key`, {
    method: "POST",
    headers: { ...(adminKey ? { "x-admin-key": adminKey } : {}) },
  });
  const akBody = await akResponse.json().catch(() => ({}));
  if (!akResponse.ok) throw new Error(akBody.error || `/answer-key failed (${akResponse.status})`);

  const paperText = JSON.stringify(genBody.paper);
  const answerKeyText = (akBody.answerKey?.entries || []).map((e) => e.answer).join("\n");
  return {
    paperId: genBody.id,
    paper: genBody.paper,
    entries: akBody.answerKey?.entries || [],
    marksTotal: genBody.paper?.marksTotal ?? 0,
    combinedText: `${paperText}\n\n${answerKeyText}`,
  };
}

const REFERENCE_JUDGE_MODEL_DEFAULT = "openai/gpt-4.1";
const MARK_TAG = /\[(?:\d+\s*(?:½)?|½)(?:\s*[+×x]\s*[\d½]+)*\]/;

function flattenQuestions(paper) {
  const out = [];
  for (const section of paper?.sections || []) {
    (section.questions || []).forEach((q, i) => out.push({ section: section.section, questionIndex: i, ...q }));
  }
  return out;
}

function findEntry(entries, q) {
  return entries.find((e) => e.section === q.section && e.questionIndex === q.questionIndex);
}

// Deterministic checks that need no model: every question has one usable
// answer, no question appears twice, no marking-scheme tags leaked in.
function structuralChecks(paper, entries) {
  const questions = flattenQuestions(paper);
  const problems = [];
  if (entries.length !== questions.length) {
    problems.push(`answer key has ${entries.length} entries for ${questions.length} questions`);
  }
  const seen = new Map();
  for (const q of questions) {
    const label = `${q.section} Q${q.questionIndex + 1}`;
    const entry = findEntry(entries, q);
    if (!entry || !String(entry.answer || "").replace(/[-–—\s.]/g, "")) problems.push(`${label}: missing or placeholder answer`);
    if (MARK_TAG.test(q.text || "")) problems.push(`${label}: mark tag in question text`);
    // Whole text: assertion-reason questions share a long "Directions: ..."
    // opening, so comparing only a prefix flagged different questions.
    const norm = String(q.text || "").toLowerCase().replace(/\s+/g, " ").trim();
    if (seen.has(norm)) problems.push(`${label}: duplicate of ${seen.get(norm)}`);
    else seen.set(norm, label);
  }
  return problems;
}

async function pdfText(filePath) {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const doc = await getDocumentProxy(new Uint8Array(fs.readFileSync(filePath)));
  const { text } = await extractText(doc, { mergePages: true });
  return Array.isArray(text) ? text.join("\n") : text;
}

const REFERENCE_JUDGE_SYSTEM =
  "You check a generated CBSE class 10 exam paper and its answer key against the OFFICIAL source paper and " +
  "OFFICIAL answer key. The official text was extracted from PDFs, so maths symbols may be garbled; read it sensibly. " +
  "For every generated question: (1) if it is the same as a source question (same wording, numbers, options), its " +
  "answer must agree with the official key - compare the CONTENT of the chosen option, not just its letter, because " +
  "options may have been reordered; (2) if it was changed or is new, its answer must be correct by standard CBSE " +
  "class 10 knowledge; (3) if it reuses a question the official key marks as flawed (no correct option), report it " +
  "under flawedReused. Report ONLY real errors: a wrong option, wrong final value or unit, or a statement that " +
  "contradicts the official key or the science. Do NOT report wording, brevity, formatting, missing step marks, or " +
  "an alternative correct method. Reply with ONLY a JSON object: " +
  '{"checked": number, "reused": number, "wrong": [{"ref": "section and question number", "question": "short", ' +
  '"given": "short", "expected": "short", "reason": "short"}], "flawedReused": [{"ref": "...", "note": "short"}]}';

async function referenceJudge(openrouterKey, model, officialPaper, officialKey, paper, entries) {
  const lines = flattenQuestions(paper).map((q) => {
    const entry = findEntry(entries, q);
    const table = q.table ? `\n   Table: ${JSON.stringify(q.table)}` : "";
    return (
      `[${q.section} Q${q.questionIndex + 1}] (${q.marks} marks, ${q.questionType})\n   ${q.text}${table}\n` +
      `   ANSWER GIVEN: ${entry ? entry.answer : "(none)"}`
    );
  });
  const user =
    `OFFICIAL QUESTION PAPER:\n${officialPaper}\n\n=====\nOFFICIAL ANSWER KEY:\n${officialKey}\n\n=====\n` +
    `GENERATED PAPER WITH ITS ANSWER KEY:\n${lines.join("\n\n")}`;
  const raw = await callOpenRouter(openrouterKey, model, REFERENCE_JUDGE_SYSTEM, user, 4000);
  const parsed = parseLlmJsonLoose(raw);
  return {
    checked: Number(parsed.checked) || 0,
    reused: Number(parsed.reused) || 0,
    wrong: Array.isArray(parsed.wrong) ? parsed.wrong : [],
    flawedReused: Array.isArray(parsed.flawedReused) ? parsed.flawedReused : [],
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const devVars = loadDevVars();

  const workerUrl = (args["worker-url"] || process.env.EVAL_WORKER_URL || "").replace(/\/$/, "");
  if (!workerUrl) {
    console.error("No worker URL. Pass --worker-url=<staging worker URL> or set EVAL_WORKER_URL.");
    process.exit(1);
  }
  if (workerUrl === PROD_WORKER_URL && !args["allow-prod"]) {
    console.error("Refusing to run evals against production. Use the staging worker, or pass --allow-prod deliberately.");
    process.exit(1);
  }
  const adminKey = args["admin-key"] || process.env.ADMIN_API_KEY || devVars.ADMIN_API_KEY || "";
  const openrouterKey = process.env.OPENROUTER_API_KEY || devVars.OPENROUTER_API_KEY || "";
  const gradeMode = args["no-judge"] ? "cheap" : "judge";
  const featureChanged = args["feature-changed"] || null;

  const judgeModel = args["judge-model"] || JUDGE_MODEL_DEFAULT;

  let modelOverride = typeof args.model === "string" ? args.model : null;
  if (!modelOverride && adminKey) {
    try {
      const cfgResponse = await fetch(`${workerUrl}/admin/config`, { headers: { "x-admin-key": adminKey } });
      const cfgBody = await cfgResponse.json().catch(() => ({}));
      if (cfgResponse.ok && cfgBody.config?.evalModelSlug) modelOverride = cfgBody.config.evalModelSlug;
    } catch (err) {
      console.warn(`Could not fetch evalModelSlug from /admin/config: ${err.message}`);
    }
  }
  if (!modelOverride) {
    console.error(
      "No model specified. Pass --model=<slug>, or set 'Eval model (slug)' in the dashboard's Settings > Evals card."
    );
    process.exit(1);
  }
  if (gradeMode === "judge" && !openrouterKey) {
    console.error("OPENROUTER_API_KEY not found (env or worker/.dev.vars) - needed for LLM-judge grading. Use --no-judge to skip it.");
    process.exit(1);
  }

  const SUITES = { golden: "golden-cases.json", client: "client-papers-cases.json" };
  const suite = typeof args.suite === "string" ? args.suite : "golden";
  if (typeof args.cases !== "string" && !SUITES[suite]) {
    console.error(`Unknown --suite=${suite}. Use one of: ${Object.keys(SUITES).join(", ")}.`);
    process.exit(1);
  }
  const casesPath =
    typeof args.cases === "string" ? path.resolve(args.cases) : path.join(__dirname, SUITES[suite]);
  const golden = JSON.parse(fs.readFileSync(casesPath, "utf8"));
  const referenceDir =
    args["reference-dir"] || process.env.EVAL_REFERENCE_DIR || path.join(__dirname, "reference-papers");
  const referenceJudgeModel = args["reference-judge-model"] || REFERENCE_JUDGE_MODEL_DEFAULT;
  const referenceTextCache = new Map();
  const readReference = async (name) => {
    const file = path.join(referenceDir, name);
    if (!fs.existsSync(file)) {
      throw new Error(`official PDF not found: ${file} (put the four client PDFs in evals/reference-papers/, or pass --reference-dir)`);
    }
    if (!referenceTextCache.has(name)) referenceTextCache.set(name, await pdfText(file));
    return referenceTextCache.get(name);
  };
  // --case=id1,id2 runs only those cases (ids as in golden-cases.json).
  if (typeof args.case === "string") {
    const wanted = new Set(args.case.split(",").map((s) => s.trim()).filter(Boolean));
    golden.cases = golden.cases.filter((c) => wanted.has(c.id));
    const missingIds = [...wanted].filter((id) => !golden.cases.some((c) => c.id === id));
    if (missingIds.length) {
      console.error(`Unknown case id(s): ${missingIds.join(", ")}`);
      process.exit(1);
    }
  }
  // Fail fast, before any paid generation: every official PDF the selected
  // cases need must exist (only needed when grading with the judge).
  if (gradeMode === "judge") {
    const needed = [...new Set(golden.cases.flatMap((c) => c.referenceFiles || []))];
    const missing = needed.filter((name) => !fs.existsSync(path.join(referenceDir, name)));
    if (missing.length) {
      console.error(
        `Missing official PDFs in ${referenceDir}: ${missing.join(", ")}. ` +
          "Put them there (evals/reference-papers/ by default) or pass --reference-dir. " +
          "Use --no-judge to run without them."
      );
      process.exit(1);
    }
  }
  const results = [];

  console.log(`Running ${golden.cases.length} eval case(s) from ${path.basename(casesPath)} against ${workerUrl}`);
  console.log(`  model under test: ${modelOverride}`);
  console.log(`  grading: ${gradeMode === "judge" ? `LLM judge (${judgeModel})` : "cheap keyword fallback"}`);
  if (featureChanged) console.log(`  feature changed: ${featureChanged}`);
  console.log("");

  for (const testCase of golden.cases) {
    process.stdout.write(`  [${testCase.id}] `);
    try {
      if (testCase.mode === "chat") {
        const { answerText } = await runChatCase(workerUrl, adminKey, modelOverride, testCase);
        const verdict = await grade(gradeMode, {
          keyFacts: testCase.keyFacts,
          cheapKeywords: testCase.cheapKeywords,
          answerText,
          openrouterKey,
          judgeModel,
        });
        results.push({ id: testCase.id, mode: "chat", pass: verdict.pass, reason: verdict.reason, answerText });
        console.log(verdict.pass ? "PASS" : `FAIL - ${verdict.reason}`);
      } else if (testCase.mode === "explain") {
        const { answerText } = await runExplainCase(workerUrl, adminKey, modelOverride, testCase);
        const verdict = await grade(gradeMode, {
          keyFacts: testCase.keyFacts,
          cheapKeywords: testCase.cheapKeywords,
          answerText,
          openrouterKey,
          judgeModel,
        });
        results.push({ id: testCase.id, mode: "explain", pass: verdict.pass, reason: verdict.reason, answerText });
        console.log(verdict.pass ? "PASS" : `FAIL - ${verdict.reason}`);
      } else if (testCase.mode === "questionPaper") {
        const { paperId, paper, entries, marksTotal, combinedText } = await runQuestionPaperCase(
          workerUrl,
          adminKey,
          modelOverride,
          testCase
        );
        const marksOk = marksTotal >= (testCase.minMarksTotal ?? testCase.marksTotal);
        if (!marksOk) {
          results.push({
            id: testCase.id,
            mode: "questionPaper",
            pass: false,
            reason: `generated only ${marksTotal}/${testCase.marksTotal} marks (minimum ${testCase.minMarksTotal})`,
          });
          console.log(`FAIL - under-generated (${marksTotal}/${testCase.marksTotal} marks)`);
          continue;
        }
        let allSubPass = true;
        const subResults = [];
        let reference = null;
        if (Array.isArray(testCase.referenceFiles) && testCase.referenceFiles.length === 2) {
          const structural = structuralChecks(paper, entries);
          // --no-judge: structural checks only; the full paper and key are
          // saved in the report so they can be graded afterwards.
          const ref =
            gradeMode === "judge"
              ? await referenceJudge(
                  openrouterKey,
                  referenceJudgeModel,
                  ...(await Promise.all(testCase.referenceFiles.map(readReference))),
                  paper,
                  entries
                )
              : { checked: 0, reused: 0, wrong: [], flawedReused: [], notGraded: true, paper, entries };
          const maxWrong = testCase.maxWrongAnswers ?? 0;
          reference = { paperId, structural, ...ref, maxWrongAnswers: maxWrong };
          const structuralPass = structural.length === 0;
          const answersPass = ref.wrong.length <= maxWrong;
          subResults.push({ id: "structure", pass: structuralPass, reason: structural.join("; ") || "ok" });
          subResults.push({
            id: "answers-vs-official-key",
            pass: answersPass,
            reason: ref.notGraded
              ? "not graded (--no-judge); paper and key saved in the report"
              : `${ref.wrong.length} wrong of ${ref.checked} checked (${ref.reused} reused from the source)`,
          });
          if (!structuralPass || !answersPass) allSubPass = false;
        }
        for (const fc of testCase.factChecks || []) {
          const verdict = await grade(gradeMode, {
            keyFacts: fc.keyFacts,
            cheapKeywords: fc.cheapKeywords,
            answerText: combinedText,
            openrouterKey,
            judgeModel,
          });
          subResults.push({ id: fc.id, pass: verdict.pass, reason: verdict.reason });
          if (!verdict.pass) allSubPass = false;
        }
        results.push({ id: testCase.id, mode: "questionPaper", pass: allSubPass, marksTotal, factChecks: subResults, reference });
        console.log(
          allSubPass
            ? `PASS (${marksTotal} marks, ${subResults.length} checks)`
            : `FAIL - ${subResults
                .filter((r) => !r.pass)
                .map((r) => `${r.id}: ${r.reason}`)
                .join(" | ")}`
        );
        for (const w of reference?.wrong || []) {
          console.log(`      wrong ${w.ref}: gave "${w.given}", expected "${w.expected}" (${w.reason})`);
        }
        for (const f of reference?.flawedReused || []) {
          console.log(`      note: flawed source question reused - ${f.ref}: ${f.note}`);
        }
      }
    } catch (err) {
      results.push({ id: testCase.id, mode: testCase.mode, pass: false, reason: `error: ${err.message}` });
      console.log(`ERROR - ${err.message}`);
    }
  }

  const passCount = results.filter((r) => r.pass).length;
  console.log(`\n${passCount}/${results.length} passed`);

  const outDir = args["out-dir"] || path.join(__dirname, "results");
  fs.mkdirSync(outDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = path.join(outDir, `${timestamp}.json`);
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        workerUrl,
        casesFile: path.basename(casesPath),
        modelUnderTest: modelOverride,
        gradeMode,
        judgeModel: gradeMode === "judge" ? judgeModel : null,
        featureChanged,
        passCount,
        totalCount: results.length,
        results,
      },
      null,
      2
    )
  );
  console.log(`Report written to ${outPath}`);

  if (passCount < results.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
