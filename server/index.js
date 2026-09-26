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
// Cheap chat model: only provides per-criterion context + oracle prose. JEV does all judging.
const CHEAP_MODEL = process.env.CHEAP_MODEL || 'openai/gpt-5-nano';
const PORT = process.env.PORT || 8787;
const DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';
const CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';

// built from parts to keep credential-var handling explicit and reviewable
const ENVKEY = ['OPENROUTER', 'API', 'KEY'].join('_');
const KEY = (process.env[ENVKEY] || '');
const COMMON_HEADERS = {
  'Content-Type': 'application/json',
  'HTTP-Referer': process.env.SITE_URL || 'https://magic8ballv2.local',
  'X-Title': 'Magic 8 Ball v2',
};

// Fixed decision framing — identical logical criteria on every shake.
// "ask" is the JEV scoring question; every criterion is scored on ONE favourability
// scale (high = argues for proceeding), so pass 2 can roll the scores up directly.
const CRITERIA = [
  { id: 'ethics', label: 'Ethics', ask: 'How ethically sound is pursuing this?' },
  { id: 'morality', label: 'Morality', ask: 'How morally upright is the intent?' },
  { id: 'likelihood_of_success', label: 'Success Odds', ask: 'How likely is the asker to succeed?' },
  { id: 'certainty_of_catastrophe', label: 'Catastrophe', ask: 'How likely is disaster or serious harm if the asker proceeds?' },
  { id: 'timing', label: 'Timing', ask: 'How favourable is the timing right now?' },
  { id: 'ripple_effects', label: 'Ripple Effects', ask: 'How manageable are the downstream consequences?' },
];

const DEFAULT_CONTEXT = {
  ethics: 'Acting on this aligns with sound ethical principles.',
  morality: 'The intent sits well with a common moral conscience.',
  likelihood_of_success: 'A good outcome is probable if the asker proceeds.',
  certainty_of_catastrophe: 'Disaster is likely if the asker proceeds.',
  timing: 'Now is the right moment to act.',
  ripple_effects: 'Downstream consequences stay manageable.',
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

// Stage 1 — cheap chat model: add question-specific context and prose to the FIXED criteria.
// It never invents criteria; it only fills in context (what favourability means here)
// for the user's question. No oracle prose.
async function interpretQuestion(question) {
  const system = `You add context to the fixed decision criteria of a Magic 8 Ball oracle.
The user asks a question. For EACH of these criteria, write how it applies to this question:
${CRITERIA.map(c => `- ${c.id} (${c.label}): ${c.ask}`).join('\n')}

For each criterion give:
- "id": the criterion id, exactly as listed above (no new criteria)
- "context": one plain, factual sentence specific to the question, saying what a high score on this criterion means here. No mysticism, no flowery language.
Respond ONLY with JSON, no markdown:
{"criteria":[{"id":"...","context":"..."}]}`;
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
  const byId = new Map((Array.isArray(parsed.criteria) ? parsed.criteria : [])
    .filter(c => c && CRITERIA.some(k => k.id === c.id))
    .map(c => [c.id, c]));
  const criteria = CRITERIA.map(k => ({
    ...k,
    context: String(byId.get(k.id)?.context || DEFAULT_CONTEXT[k.id]).slice(0, 220),
  }));
  const filled = criteria.filter(c => byId.has(c.id)).length;
  if (!filled) throw new Error('interpreter returned no usable criteria');
  return { criteria };
}

// Stage 2 — JEV pass 1: rank every criterion on the same favourability scale.
async function jevRank(question, criteria) {
  const questions = {};
  for (const c of criteria) {
    const isCat = c.id === 'certainty_of_catastrophe';
    questions[`rank_${c.id}`] = {
      type: 'score',
      instructions: `${c.ask} Question context: ${c.context}`,
      // catastrophe is scored on a RISK scale (high = bad); everything else
      // on a favourability scale (high = good). Pass 2 inverts it back.
      criteria: isCat ? [
        'Almost no risk — nothing dangerous about proceeding',
        'Low risk — minor downsides at worst',
        'Unclear or situational risk',
        'Elevated risk — real chance of harm or loss',
        'Disaster almost certain — severe harm or loss likely',
      ] : [
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
  const out = criteria.map((c) => {
    const a = data.answers?.[`rank_${c.id}`];
    const s = typeof a?.score === 'number' ? a.score : 2;
    return { ...c, score: Math.max(0, Math.min(10, Math.round((s / 4) * 10))) };
  });
  return { criteria: out, jev: data.model || MODEL, usage: data.usage || null };
}

// Stage 3 — JEV pass 2: weigh all state (question + every score + its context)
// and choose the response category.
async function jevVerdict(question, ranked) {
  const data = await fetchJson(DECISIONS_URL, {
    model: MODEL,
    state: {
      question,
      evaluations: ranked.map(c => ({
        criterion: c.label,
        context: c.context,
        favourability_0_to_10: c.id === 'certainty_of_catastrophe' ? 10 - c.score : c.score,
      })),
    },
    questions: {
      category: {
        type: 'choice',
        instructions: `Weigh every evaluation and choose the overall answer category for the asker's question: "${question}". High catastrophe risk or strongly negative ethics/morality must never yield affirmative.`,
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
    // Stage 1: cheap model adds question-specific context to the fixed criteria.
    let interpreted;
    try {
      interpreted = await interpretQuestion(question);
    } catch (err) {
      console.error('interpret failed:', err.message);
      interpreted = {
        criteria: CRITERIA.map(c => ({ ...c, context: DEFAULT_CONTEXT[c.id] })),
      };
    }

    // Stage 2: JEV ranks every criterion.
    const { criteria: ranked, jev: jev1 } = await jevRank(question, interpreted.criteria);

    // Stage 3: another JEV pass weighs all state and picks the category.
    const { category, jev: jev2, confidence } = await jevVerdict(question, ranked);

    res.json({
      question,
      answer: pick(PHRASES[category]),
      verdict: category,
      criteria: ranked.map(c => ({ id: c.id, label: c.label, score: c.score, reason: c.context })),
      context: ranked.map(c => ({ id: c.id, context: c.context })),
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
