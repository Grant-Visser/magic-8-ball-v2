# Magic 8 Ball v2 🎱

A magic 8 ball that isn't random. Every question is run through a real decision
framework — 10 scored criteria plus an ethics gate — judged by TypeSafe's JEV
decision model via OpenRouter, then dressed up as a classic 8-ball answer.

## How it works

Four stages behind one `POST /api/ask`:

1. **Interpret** — a cheap chat model (DeepSeek Flash) reads the question and
   writes one factual context sentence for each fixed criterion. It never
   invents criteria; it only explains what a high score means *for this
   question*. Falls back to static defaults if it fails.
2. **Score** — `~typesafe/jev-latest` scores all 10 criteria 0–10 in one Decisions API
   call, plus an *Ethics & Legality* noul gate.
3. **Verdict** — a second JEV pass receives the question, every score with its
   context, and the gate probability, then chooses the category:
   `affirmative` / `neutral` / `negative`. The gate is weighed strongly but is
   **never a hard veto**.
4. **Summarise** — the cheap model writes one plain sentence naming the 1–2
   most decisive factors.

The 8-ball phrase itself is picked randomly from the classic phrase list
matching the chosen category — that's the only random part.

### The decision frame

Favourability criteria (high = good): Upside, Base-Rate Odds, Evidence
Quality, Reversibility, Opportunity Cost, Competence & Preparation, Option
Value of Waiting, Motivation & Energy.

Risk criteria (high = bad): Downside Severity, Risk of Ruin. These are
inverted before the verdict pass so it always reasons in favourability.

The Ethics & Legality gate is returned to the UI as a "% impermissible" badge.

## Stack

- **Backend:** Node.js (Express) — 4-stage pipeline over the OpenRouter
  Decisions + Chat APIs
- **Frontend:** React (Vite) — mobile-first, auto-growing textarea, share
  links, animated ball

## Getting Started

### Backend

```bash
cd server
npm install
cp .env.example .env   # then set OPENROUTER_API_KEY
npm start
```

Runs on http://localhost:8787 (serves the built frontend too).

### Frontend

```bash
cd client
npm install
npm run dev
```

Dev server on http://localhost:5173, proxying `/api` to :8787.

### Production build

```bash
cd client && npm run build
```

Express serves `client/dist` and the SPA fallback — one port for everything.

## Configuration (server/.env)

- `OPENROUTER_API_KEY` — required, get one at openrouter.ai
- `JEV_MODEL` — decision model, default `~typesafe/jev-latest` (tracks the
  newest JEV release; currently resolves to snapshot `jev-1.14-20261014`).
  Pinned slugs like `typesafe/jev-1.14` take no `~` prefix.
- `CHEAP_MODEL` — interpreter/summariser, default `~deepseek/deepseek-flash-latest`
- `SITE_URL` — optional, OpenRouter attribution header
- `PORT` — default 8787

## API

`POST /api/ask`

```json
{ "question": "Should I quit my job and become a pirate?" }
```

Questions up to 4096 characters. Response:

```json
{
  "answer": "Signs point to yes.",
  "verdict": "affirmative",
  "summary": "High base-rate odds and low risk of ruin outweigh moderate opportunity cost.",
  "criteria": [
    { "id": "upside", "label": "Upside", "score": 8, "reason": "…", "description": "…" }
  ],
  "gate": { "id": "ethics_legality", "label": "Ethics & Legality", "score": 1, "probability": 0.1, "reason": "…", "description": "…" },
  "confidence": 0.87,
  "model": "~typesafe/jev-latest-20261014 + ~deepseek/deepseek-flash-latest"
}
```

`criteria` is all 10 scored criteria with per-criterion reasoning; `gate`
carries the impermissibility probability shown as a badge in the UI.

## Share links

The result view offers a copyable link of the form `/?q=<question>` — opening
it prefills and shakes immediately.

## Deploying

Proxmox LXC install + upgrade scripts live in [`proxmox/`](proxmox/README.md).

Upgrade a deployed container from the Proxmox host:

```bash
pct exec <CTID> -- bash < <(curl -fsSL https://raw.githubusercontent.com/Grant-Visser/magic-8-ball-v2/main/proxmox/magic-8-ball-upgrade.sh)
```
