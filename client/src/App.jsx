import { useEffect, useState } from 'react';

const SHAKE_MS = 1100;

const VERDICT_STYLES = {
  affirmative: { glow: '#39d98a', label: '✅ Affirmative' },
  neutral: { glow: '#f5c542', label: '🤔 Unclear' },
  negative: { glow: '#ff5c7a', label: '⛔ Negative' },
};

export default function App() {
  const [question, setQuestion] = useState('');
  const [phase, setPhase] = useState('idle'); // idle | shaking | answered
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  const runAsk = async (raw) => {
    const q = raw.trim();
    if (!q || phase === 'shaking') return;

    setPhase('shaking');
    setResult(null);
    setError('');

    const started = Date.now();
    try {
      const r = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'The ball refused to answer.');

      // let the shake play out fully for drama
      const wait = Math.max(0, SHAKE_MS - (Date.now() - started));
      setTimeout(() => {
        setResult(data);
        setPhase('answered');
      }, wait);
    } catch (err) {
      setTimeout(() => {
        setError(err.message);
        setPhase('idle');
      }, Math.max(0, SHAKE_MS - (Date.now() - started)));
    }
  };

  const ask = (e) => {
    e.preventDefault();
    runAsk(question);
  };

  // Shared links carry the question: /?q=Should%20I... — prefill and shake once.
  useEffect(() => {
    const shared = new URLSearchParams(window.location.search).get('q');
    if (shared) {
      const q = shared.slice(0, 500);
      setQuestion(q);
      runAsk(q);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const copyLink = async () => {
    const q = (result?.question || question).trim();
    if (!q) return;
    const url = `${window.location.origin}/?q=${encodeURIComponent(q)}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // clipboard API is blocked on plain http (LAN) — fall back
      const ta = document.createElement('textarea');
      ta.value = url;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const shaking = phase === 'shaking';
  const v = result ? VERDICT_STYLES[result.verdict] || VERDICT_STYLES.neutral : null;

  return (
    <div className="app">
      <header>
        <h1>🎱 Magic 8 Ball <span className="v2">v2</span></h1>
        <p className="tagline">Not random. Judged.</p>
      </header>

      <div className={'ball' + (shaking ? ' shaking' : '')} style={result ? { '--glow': v.glow } : {}}>
        <div className="window">
          {shaking && <span className="ghost">…</span>}
          {phase === 'idle' && !error && <span className="eight">8</span>}
          {phase === 'answered' && result && (
            <div className="answer-wrap">
              <span className="answer">{result.answer}</span>
              {result.verdict && <span className="verdict">{v.label}</span>}
            </div>
          )}
        </div>
      </div>

      <form onSubmit={ask} className="ask-form">
        <input
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask the ball anything…"
          maxLength={500}
          disabled={shaking}
          autoFocus
        />
        <button type="submit" disabled={shaking || !question.trim()}>
          {shaking ? 'Consulting…' : 'Shake'}
        </button>
      </form>

      {error && <p className="error">⚠️ {error}</p>}

      {phase === 'answered' && result && (
        <div className="result">
          {result.summary && <p className="summary">💬 {result.summary}</p>}
          <h2>Decision criteria</h2>
          <ul className="criteria">
            {(result.criteria || []).map((c) => (
              <li key={c.id}>
                <div className="crit-head">
                  <span className="crit-label">{c.label}</span>
                  <span className="crit-score">{c.score}/10</span>
                </div>
                <div className="bar">
                  <div
                    className={'fill' + (c.id === 'certainty_of_catastrophe' ? ' bad' : '')}
                    style={{ width: `${c.score * 10}%` }}
                  />
                </div>
                {c.reason && <p className="crit-reason">{c.reason}</p>}
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="share-btn"
            onClick={copyLink}
            style={{
              marginTop: 12,
              cursor: 'pointer',
              background: 'none',
              border: '1px solid rgba(255,255,255,.25)',
              color: 'inherit',
              borderRadius: 8,
              padding: '6px 14px',
              fontSize: '0.9rem',
            }}
          >
            {copied ? '✅ Link copied' : '🔗 Copy share link'}
          </button>
          <p className="powered">ranked &amp; judged by <strong>JEV LATEST</strong> (1.13) · context by DeepSeek Flash · via OpenRouter</p>
        </div>
      )}

      <footer>
        ethical oracle · demo build ·{' '}
        <a href="https://github.com/Grant-Visser/magic-8-ball-v2" target="_blank" rel="noreferrer" style={{ color: 'inherit' }}>
          source
        </a>
      </footer>
    </div>
  );
}
