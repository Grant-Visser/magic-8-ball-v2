import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

const app = express();
app.use(cors());
app.use(express.json());

// JEV LATEST = the TypeSafe decision model (currently 1.13) via the Decisions API.
const MODEL = process.env.JEV_MODEL || '~typesafe/jev-latest';
// Cheap chat model: writes the decision criteria + oracle prose. JEV does all judging.
const CHEAP_MODEL = process.env.CHEAP_MODEL || 'openai/gpt-5-nano';
const PORT = process.env.PORT || 8787;
const DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';
const CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';

// built from parts to keep credential-var handling explicit and reviewable
const ENVKEY = ['OPENROUTER', 'API', 'KEY'].join('_');
const KEY = process.env[ENVKEY] || '';
const COMMON_HEADERS = {
  'Content-Type': 'application/json',
  'HTTP-Referer': process.env.SITE_URL || 'https://magic8ballv2.local',
  'X-Title': 'Magic 8 Ball v2',
};

const PHRASES = {
  affirmative: [
    'It is certain.', 'It is decidedly so.', 'Without a doubt.', 'Yes definitely.',
    'You may rely on it.', 'As I see it, yes.', 'Most likely.', 'Outlook good.',
    'Yes.', 'Signs point to yes.',
  ],
  neutral: [
    'Reply hazy, try again.', 'Ask again later.', 'Better not tell you now.',
    'Cannot predict now.', 'Concentrate and ask again.',
  ],
  negative: [
    "Don't count on it.", 'My reply is no.', 'My sources say no.',
    'Outlook not so good.', 'Very doubtful.',
  ],
};

const DEFAULT_CRITERIA = [
  { id: 'ethics', label: 'Ethics', description: 'Acting on this aligns with sound ethical principles.', note: 'The scales of right and wrong are being read.' },
  { id: 'morality', label: 'Morality', description: 'The intent sits well with a common moral conscience.', note: 'The conscience stirs or rests.' },
  { id: 'success_odds', label: 'Success Odds', description: 'A good outcome is probable if the asker proceeds.', note: 'Fortune weighs the odds.' },
  { id: 'catastrophe', label: 'Catastrophe', description: 'Disaster is likely if things go wrong.', note: 'Thunder gathers on the horizon.' },
  { id: 'timing', label: 'Timing', description: 'Now is the right moment to act.', note: 'The hour is read from the stars.' },
  { id: 'ripple_effects', label: 'Ripple Effects', description: 'Downstream consequences stay manageable.', note: 'Ripples cross the still water.' },
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

async function fetchJson(url, body, timeoutMs = 25000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { ...COMMON_HEADERS, Authorization: `Bearer ${KEY}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      throw new Error(`HTTP ${r.status}: ${text.slice(0, 300)}`);
    }
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

// Stage 1 — cheap chat model: interpret the question into decision criteria + prose.
async function interpretQuestion(question) {
  const system = `You are the question interpreter for a Magic 8 Ball oracle.
Given the user's question, design 4-6 decision criteria that a mystical judge should weigh to answer it.
For each criterion give:
- "id": short snake_case identifier
- "label": short Title Case name
- "description": one sentence saying what a HIGH score on this criterion means for this specific question
- "note": one cryptic oracle-style line (max ~80 chars) about this criterion, shown to the asker
Also give "prelude": one cryptic mystical line (max ~90 chars) about the question's stakes, shown before the verdict.
Respond ONLY with JSON, no markdown:
{"prelude":"...","criteria":[{"id":"...","label":"...","description":"...","note":"..."}]}`;
  const data = await fetchJson(CHAT_URL, {
    model: CHEAP_MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: question },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.9,
    max_tokens: 3000,
    reasoning: { effort: 'low' },
  });
  const raw = data?.choices?.[0]?.message?.content || '';
  const parsed = JSON.parse(raw.replace(/```json\s*|```\s*/g, '').trim());
  const criteria = (Array.isArray(parsed.criteria) ? parsed.criteria : [])
    .filter(c => c && c.label)
    .slice(0, 6)
    .map(c => ({
      id: String(c.id || c.label).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'criterion',
      label: String(c.label).slice(0, 40),
      description: String(c.description || c.label).slice(0, 200),
      note: String(c.note || '').slice(0, 120),
    }));
  if (!criteria.length) throw new Error('interpreter returned no criteria');
  return { prelude: String(parsed.prelude || '').slice(0, 140), criteria };
}

// Stage 2 — JEV pass 1: rank every criterion on a favourability scale.
async function jevRank(question, criteria) {
  const questions = {};
  for (const c of criteria) {
    questions[`rank_${c.id}`] = {
      type: 'score',
      instructions: `How favourable is ${c.label} for the asker proceeding? ${c.description}`,
      criteria: [
        'Very unfavourable — strongly argues against proceeding',
        'Unfavourable — leans against proceeding',
        'Mixed or unclear',
        'Favourable — leans toward proceeding',
        'Very favourable — strongly argues for proceeding',
      ],
    };
  }
  const data = await fetchJson(DECISIONS_URL, {
    model: MODEL,
    state: { question },
    questions,
  });
  const out = criteria.map((c, i) => {
    const a = data.answers?.[`rank_${c.id}`];
    const s = typeof a?.score === 'number' ? a.score : 2;
    return { ...c, score: Math.max(0, Math.min(10, Math.round((s / 4) * 10))) };
  });
  return { criteria: out, jev: data.model || MODEL, usage: data.usage || null };
}

// Stage 3 — JEV pass 2: weigh all state and choose the response category.
async function jevVerdict(question, ranked) {
  const data = await fetchJson(DECISIONS_URL, {
    model: MODEL,
    state: {
      question,
      evaluations: ranked.map(c => ({ criterion: c.label, favourability_0_to_10: c.score })),
    },
    questions: {
      category: {
        type: 'choice',
        instructions: `Weigh every evaluation and choose the overall answer category for the asker's question: "${question}". High catastrophe or strongly negative ethics/morality must never yield affirmative.`,
        criteria: {
          affirmative: 'The ask should go ahead — the signs favour it.',
          neutral: 'It is unclear, badly timed, or genuinely undecidable — the ball withholds.',
          negative: 'Advise against proceeding — the signs oppose it.',
        },
      },
    },
  });
  const choice = data.answers?.category?.choice;
  if (!PHRASES[choice]) throw new Error(`unexpected JEV category: ${choice}`);
  return { category: choice, jev: data.model || MODEL, confidence: data.answers?.category?.confidence, usage: data.usage || null };
}

app.post('/api/ask', async (req, res) => {
  const question = (req.body?.question || '').trim();
  if (!question) return res.status(400).json({ error: 'The ball needs a question.' });
  if (question.length > 500) return res.status(400).json({ error: 'Keep it under 500 characters — even mystics have limits.' });

  try {
    // Stage 1: cheap model interprets the question into criteria + prose.
    let interpreted;
    try {
      interpreted = await interpretQuestion(question);
    } catch (err) {
      console.error('interpret failed:', err.message);
      interpreted = { prelude: 'The mists settle around a familiar shape.', criteria: DEFAULT_CRITERIA };
    }

    // Stage 2: JEV ranks every criterion.
    const { criteria: ranked, jev: jev1 } = await jevRank(question, interpreted.criteria);

    // Stage 3: another JEV pass weighs all state and picks the category.
    const { category, jev: jev2, confidence } = await jevVerdict(question, ranked);

    res.json({
      question,
      answer: pick(PHRASES[category]),
      verdict: category,
      summary: interpreted.prelude,
      criteria: ranked.map(c => ({ id: c.id, label: c.label, score: c.score, reason: c.note || c.description })),
      confidence,
      model: `${jev2} + ${CHEAP_MODEL}`,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'The ball took too long to answer. Shake again.' });
    }
    console.error('Ask failed:', err);
    res.status(500).json({ error: 'Something went wrong inside the ball.' });
  }
});

// serve the built frontend in production
const distDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'client', 'dist');
app.use(express.static(distDir));
app.get(/^\/(?!api).*/, (req, res) => res.sendFile(path.join(distDir, 'index.html')));
app.listen(PORT, () => {
  console.log(`🔮 Magic 8 Ball v2 listening on http://localhost:${PORT} (decisions: ${MODEL}, interpreter: ${CHEAP_MODEL})`);
});
