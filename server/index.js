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
// Cheap chat model: only provides per-criterion context. JEV does all judging.
const CHEAP_MODEL = process.env.CHEAP_MODEL || '~deepseek/deepseek-flash-latest';
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

// Fixed decision framing — 10 scored criteria + 1 noul-style gate.
// scale: 'fav' = high is good (favourability). 'risk' = high is bad (risk level).
// Pass 2 sees risk criteria inverted (10 - risk) so it always reasons in favourability.
// The gate is NEVER a hard veto — its probability is handed to pass 2 to weigh.
const CRITERIA = [
  { id: 'upside', label: 'Upside', scale: 'fav',
    ask: 'How good is the realistic good outcome compared with the cost of trying?',
    desc: 'How good is the realistic good outcome vs the cost of trying?' },
  { id: 'downside_severity', label: 'Downside Severity', scale: 'risk',
    ask: 'How severe is the realistic worst-case outcome?',
    desc: 'How bad is the realistic worst case? High = severe.' },
  { id: 'risk_of_ruin', label: 'Risk of Ruin', scale: 'risk',
    ask: 'If the worst case happens, how unrecoverable is the loss?',
    desc: 'Can the bad case be recovered from, or is it permanent loss? High = unrecoverable.' },
  { id: 'base_rate_odds', label: 'Base-Rate Odds', scale: 'fav',
    ask: 'How often do attempts like this one actually succeed?',
    desc: 'How often do attempts like this actually succeed? Reference-class reality, not vibes.' },
  { id: 'evidence_quality', label: 'Evidence Quality', scale: 'fav',
    ask: 'How much do we actually know about the facts that matter here, versus guessing?',
    desc: 'Are we reasoning from knowledge or guessing?' },
  { id: 'reversibility', label: 'Reversibility', scale: 'fav',
    ask: 'If it goes wrong or the asker changes their mind, how cheaply can they back out?',
    desc: 'One-way door or two-way door? Can you back out cheaply?' },
  { id: 'opportunity_cost', label: 'Opportunity Cost', scale: 'fav',
    ask: 'How acceptable is what the asker gives up by proceeding (time, money, alternatives)?',
    desc: 'What does yes preclude (time, money, alternatives)? High = acceptable.' },
  { id: 'competence', label: 'Competence & Preparation', scale: 'fav',
    ask: "Do the asker's skills, resources and preparation fit this specific pursuit?",
    desc: 'Does the asker have the skill, resources and setup for this specifically?' },
  { id: 'option_value_of_waiting', label: 'Option Value of Waiting', scale: 'fav',
    ask: 'How clearly is acting now better than waiting for more information?',
    desc: 'Would delaying produce better information? High = act now.' },
  { id: 'motivation', label: 'Motivation & Energy', scale: 'fav',
    ask: "How strong are the asker's want and readiness to execute this?",
    desc: 'Does the asker actually want this, and are they in a state to execute?' },
];

const GATE = {
  id: 'ethics_legality', label: 'Ethics & Legality',
  ask: 'Is pursuing this impermissible, illegal, or seriously unethical?',
  desc: 'Impermissible or illegal? Weighed by the final pass, never a hard veto.',
};

const FAV_SCALE = [
  'Very unfavourable — strongly argues against proceeding',
  'Unfavourable — leans against proceeding',
  'Mixed or unclear',
  'Favourable — leans toward proceeding',
  'Very favourable — strongly argues for proceeding',
];
const RISK_SCALE = [
  'Almost none — negligible severity or fully recoverable',
  'Low — minor or easily recovered',
  'Unclear or situational',
  'Elevated — serious harm, loss, or hard to undo',
  'Severe — disaster, permanent loss, or unrecoverable',
];

const DEFAULT_CONTEXT = {
  upside: 'The realistic good outcome clearly outweighs the cost of trying.',
  downside_severity: 'The realistic worst case is serious if the asker proceeds.',
  risk_of_ruin: 'The worst case would be permanent or unrecoverable loss.',
  base_rate_odds: 'Attempts like this usually succeed.',
  evidence_quality: 'We are reasoning from solid knowledge rather than guessing.',
  reversibility: 'The asker can back out cheaply if it goes wrong.',
  opportunity_cost: 'What is given up by proceeding is acceptable.',
  competence: 'The asker has the skill, resources and preparation for this.',
  option_value_of_waiting: 'Acting now is clearly better than waiting.',
  motivation: 'The asker wants this and is in a state to execute.',
  ethics_legality: 'Pursuing this is impermissible, illegal, or seriously unethical.',
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

async function fetchJson(url, body, timeoutMs = 35000) {
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

// Stage 1 — cheap chat model: adds question-specific context to the FIXED criteria.
// It never invents criteria; it only fills in context for the user's question.
async function interpretQuestion(question) {
  const system = `You add context to the fixed decision criteria of a Magic 8 Ball oracle.
The user asks a question. For EACH of these criteria, write how it applies to this question:
${CRITERIA.map(c => `- ${c.id} (${c.label}): ${c.ask}`).join('\n')}
- ${GATE.id} (${GATE.label}): ${GATE.ask}

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
  });
  const raw = data?.choices?.[0]?.message?.content || '';
  const parsed = JSON.parse(raw.replace(/```json\s*|```\s*/g, '').trim());
  const allIds = [...CRITERIA.map(c => c.id), GATE.id];
  const byId = new Map((Array.isArray(parsed.criteria) ? parsed.criteria : [])
    .filter(c => c && allIds.includes(c.id))
    .map(c => [c.id, c]));
  const criteria = CRITERIA.map(k => ({
    ...k,
    context: String(byId.get(k.id)?.context || DEFAULT_CONTEXT[k.id]).slice(0, 220),
  }));
  const gate = {
    ...GATE,
    context: String(byId.get(GATE.id)?.context || DEFAULT_CONTEXT[GATE.id]).slice(0, 220),
  };
  const filled = criteria.filter(c => byId.has(c.id)).length + (byId.has(GATE.id) ? 1 : 0);
  if (!filled) throw new Error('interpreter returned no usable criteria');
  return { criteria, gate };
}

// Stage 2 — JEV pass 1: score every criterion + the impermissibility noul.
async function jevRank(question, criteria, gate) {
  const questions = {};
  for (const c of criteria) {
    questions[`rank_${c.id}`] = {
      type: 'score',
      instructions: `${c.ask} Question context: ${c.context}`,
      criteria: c.scale === 'risk' ? RISK_SCALE : FAV_SCALE,
    };
  }
  questions[`gate_${GATE.id}`] = {
    type: 'noul',
    instructions: `${GATE.ask} Question context: ${gate.context}`,
    criteria: {
      true: 'Impermissible, illegal, or seriously unethical to pursue',
      false: 'Permissible and within ordinary moral bounds',
    },
  };
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
  const gateNoul = data.answers?.[`gate_${GATE.id}`]?.noul;
  const gateScore = typeof gateNoul === 'number'
    ? Math.max(0, Math.min(10, Math.round(gateNoul * 10)))
    : 5;
  return { criteria: out, gateScore, gateNoul: typeof gateNoul === 'number' ? gateNoul : null, jev: data.model || MODEL, usage: data.usage || null };
}

// Stage 3 — JEV pass 2: weigh all state (question + every score + its context +
// the gate probability) and choose the response category. The gate is a factor,
// never a hard veto.
async function jevVerdict(question, ranked, gate, gateScore) {
  const data = await fetchJson(DECISIONS_URL, {
    model: MODEL,
    state: {
      question,
      evaluations: ranked.map(c => ({
        criterion: c.label,
        context: c.context,
        favourability_0_to_10: c.scale === 'risk' ? 10 - c.score : c.score,
      })),
      gate: {
        criterion: GATE.label,
        context: gate.context,
        impermissibility_0_to_10: gateScore,
        note: 'Weigh this strongly. Only near-certain impermissibility should force negative.',
      },
    },
    questions: {
      category: {
        type: 'choice',
        instructions: `Weigh every evaluation and the gate, then choose the overall answer category for the asker's question: "${question}". The gate is a serious factor but not an absolute veto; only near-certain impermissibility should yield negative.`,
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

// Stage 4 -- cheap model: one plain factual sentence explaining the verdict.
async function writeSummary(question, ranked, gate, gateScore, category) {
  const lines = ranked.map(c => c.label + ': ' + c.score + '/10 - ' + c.context).join('\n');
  const system = 'You summarise decision verdicts. Write ONE plain, factual sentence (max 30 words) explaining the verdict, naming the 1-2 most decisive factors. No mysticism, no emojis, no preamble.';
  const user = 'Question: ' + question + '\nVerdict: ' + category + '\nScores:\n' + lines + '\n' + gate.label + ' impermissibility: ' + gateScore + '/10 - ' + gate.context;
  const data = await fetchJson(CHAT_URL, {
    model: CHEAP_MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.6,
    max_tokens: 1000,
    reasoning: { effort: 'low' },
  });
  const out = (data?.choices?.[0]?.message?.content || '').trim();
  if (!out) throw new Error('empty summary');
  return out.slice(0, 240);
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
        gate: { ...GATE, context: DEFAULT_CONTEXT[GATE.id] },
      };
    }

    // Stage 2: JEV scores every criterion + the gate noul.
    const { criteria: ranked, gateScore, gateNoul, jev: jev1 } = await jevRank(question, interpreted.criteria, interpreted.gate);

    // Stage 3: another JEV pass weighs all state and picks the category.
    const { category, jev: jev2, confidence } = await jevVerdict(question, ranked, interpreted.gate, gateScore);

    let summary;
    try {
      summary = await writeSummary(question, ranked, interpreted.gate, gateScore, category);
    } catch (err) {
      console.error('summary failed:', err.message);
    }

    res.json({
      question,
      answer: pick(PHRASES[category]),
      verdict: category,
      summary,
      criteria: ranked.map(c => ({ id: c.id, label: c.label, score: c.score, reason: c.context, description: c.desc })),
      gate: { id: GATE.id, label: GATE.label, score: gateScore, probability: gateNoul, reason: interpreted.gate.context, description: GATE.desc },
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
