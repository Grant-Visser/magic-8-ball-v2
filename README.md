# Magic 8 Ball v2 🎱

A "smart" magic 8 ball powered by GLM through OpenRouter. Instead of random answers, your question is
weighed against real decision criteria — ethics, morality, likelihood of success, certainty of
catastrophe, and more — and the verdict is served up as a classic 8-ball answer alongside the scoring.

## Stack

- **Backend:** Node.js (Express) — calls OpenRouter's GLM model with a decision-framework prompt
- **Frontend:** React (Vite) — mobile-first responsive UI

## Getting Started

### Backend

```bash
cd server
npm install
export OPENROUTER_API_KEY=sk-or-...
npm start
```

Runs on http://localhost:3000

### Frontend

```bash
cd client
npm install
npm run dev
```

Runs on http://localhost:5173

## API

`POST /api/ask`

```json
{ "question": "Should I quit my job and become a pirate?" }
```

Response includes the 8-ball verdict plus per-criterion scores and reasoning.
