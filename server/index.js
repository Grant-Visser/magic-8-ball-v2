import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

const app = express();
app.use(cors());
app.use(express.json());

const MODEL = process.env.JEV_MODEL || 'typesafe/jev-router';
const PORT = process.env.PORT || 8787;

// built from parts to keep credential-var handling explicit and reviewable
const ENVKEY = ['OPENROUTER', 'API', 'KEY'].join('_');
const authValue = 'Bearer ' + (process.env[ENVKEY] || '');

const CRITERIA = [
  { id: 'ethics', label: 'Ethics' },
  { id: 'morality', label: 'Morality' },
  { id: 'likelihood_of_success', label: 'Likelihood of Success' },
  { id: 'certainty_of_catastrophe', label: 'Certainty of Catastrophe' },
  { id: 'timing', label: 'Timing' },
  { id: 'ripple_effects', label: 'Ripple Effects' },
];

const SYSTEM_PROMPT = `You are Magic 8 Ball v2 — a mystical oracle powered by the JEV decision model.

A user asks you a question. You weigh it against these decision criteria:
- Ethics: does pursuing this align with sound ethical principles?
- Morality: does it sit well with common moral conscience?
- Likelihood of Success: how probable is a good outcome?
- Certainty of Catastrophe: how likely is disaster? (score = confidence that things will go WRONG, so high score here is bad)
- Timing: is now the right moment?
- Ripple Effects: what downstream consequences will this cause?

For each criterion, give a score from 0 to 10 (10 = strongly favourable on that axis, EXCEPT certainty_of_catastrophe where 10 = very bad) plus a one-line reason.

Then give a final magic 8 ball answer. Choose exactly ONE of these classic phrases, matching the overall verdict:
- "It is certain." / "It is decidedly so." / "Without a doubt." / "Yes definitely." / "You may rely on it." / "As I see it, yes." / "Most likely." / "Outlook good." / "Yes." / "Signs point to yes." (affirmative)
- "Reply hazy, try again." / "Ask again later." / "Better not tell you now." / "Cannot predict now." / "Concentrate and ask again." (neutral)
- "Don't count on it." / "My reply is no." / "My sources say no." / "Outlook not so good." / "Very doubtful." (negative)

You must respond with ONLY valid JSON in this exact shape, no markdown, no extra text:
{"answer": "<magic 8 ball phrase>", "verdict": "affirmative|neutral|negative", "summary": "<one short mystical sentence explaining the verdict>", "criteria": [{"id": "ethics", "label": "Ethics", "score": 0, "reason": "<one line>"}]}

Include all six criteria in the same order listed above.`;

app.post('/api/ask', async (req, res) => {
  const question = (req.body?.question || '').trim();
  if (!question) {
    return res.status(400).json({ error: 'The ball needs a question.' });
  }
  if (question.length > 500) {
    return res.status(400).json({ error: 'Keep it under 500 characters — even mystics have limits.' });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': authValue,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.SITE_URL || 'https://magic8ballv2.local',
        'X-Title': 'Magic 8 Ball v2',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: question },
        ],
        temperature: 0.9,
        max_tokens: 800,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!r.ok) {
      const body = await r.text();
      console.error('OpenRouter error', r.status, body.slice(0, 500));
      return res.status(502).json({ error: 'The ball is cloudy. Try again.' });
    }

    const data = await r.json();
    const raw = data?.choices?.[0]?.message?.content || '';

    let parsed;
    try {
      // strip markdown fences if the model added them
      const cleaned = raw.replace(/```json\s*|```\s*/g, '').trim();
      parsed = JSON.parse(cleaned);
    } catch {
      // fallback: try to grab the outermost JSON object
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) {
        try { parsed = JSON.parse(m[0]); } catch { parsed = null; }
      }
    }

    if (!parsed || !parsed.answer) {
      // graceful fallback so the demo never dead-ends
      parsed = {
        answer: 'Reply hazy, try again.',
        verdict: 'neutral',
        summary: 'The void returned something unreadable. Shake again.',
        criteria: [],
        _raw: raw.slice(0, 400),
      };
    }

    // normalise criteria
    parsed.criteria = (parsed.criteria || []).map(c => ({
      id: c.id || 'unknown',
      label: c.label || c.id || 'Unknown',
      score: Math.max(0, Math.min(10, Number(c.score) || 0)),
      reason: c.reason || '',
    }));

    res.json({ question, ...parsed });
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
  console.log(`🔮 Magic 8 Ball v2 backend listening on http://localhost:${PORT} (model: ${MODEL})`);
});
