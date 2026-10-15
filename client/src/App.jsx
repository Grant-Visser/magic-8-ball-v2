import { useEffect, useRef, useState } from 'react';

const SHAKE_MS = 1200;
const TURN_MS = 950;

function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

// The moulded die has words, not sentence punctuation or verdict badges.
export const displayAnswer = (answer = '') => answer
  .replace(/[.,!?:;“”"‘’]/g, '')
  .replace(/\s+/g, ' ')
  .trim()
  .toUpperCase();

// Criteria where a HIGH score is bad (red bar). Everything else: high = good.
const BAD_HIGH = new Set(['downside_severity', 'risk_of_ruin', 'ethics_legality']);

export default function App() {
  const [question, setQuestion] = useState('');
  const [phase, setPhase] = useState('idle'); // idle | resetting | shaking | waiting | answered
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const inputRef = useRef(null);
  const requestRef = useRef(null);
  const busyRef = useRef(false);

  const runAsk = async (raw) => {
    const q = raw.trim();
    if (!q || busyRef.current) return;
    busyRef.current = true;
    const controller = new AbortController();
    requestRef.current = controller;
    const { signal } = controller;
    setError('');
    setCopied(false);

    try {
      // Turn the previous window away before shaking the numbered side again.
      if (phase === 'answered') {
        setPhase('resetting');
        await pause(500, signal);
      }
      setResult(null);
      setPhase('shaking');
      const request = fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q }),
        signal,
      }).then(async (r) => {
        const data = await r.json().catch(() => {
          throw new Error('The ball is unavailable. Please try again.');
        });
        if (!r.ok) throw new Error(data.error || 'The ball refused to answer.');
        return data;
      });
      // Attach the rejection handler immediately, even if the API fails mid-shake.
      const [data] = await Promise.all([
        request,
        (async () => {
          await pause(SHAKE_MS, signal);
          setPhase('waiting');
          await pause(TURN_MS, signal);
        })(),
      ]);
      setResult(data);
      setPhase('answered');
    } catch (err) {
      if (err.name !== 'AbortError') {
        controller.abort();
        setError(err.message);
        setPhase('idle');
      }
    } finally {
      if (requestRef.current === controller) busyRef.current = false;
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
      const q = shared.slice(0, 4096);
      setQuestion(q);
      runAsk(q);
    }
    return () => {
      requestRef.current?.abort();
      busyRef.current = false;
    };
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

  const autosize = () => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 240) + 'px';
  };

  const busy = ['resetting', 'shaking', 'waiting'].includes(phase);
  const turned = phase === 'waiting' || phase === 'answered';
  const answer = displayAnswer(result?.answer);
  const gatePct = result?.gate ? Math.round((result.gate.probability ?? result.gate.score / 10) * 100) : null;
  const gateColor = gatePct == null ? null : gatePct >= 70 ? '#ff5c7a' : gatePct >= 30 ? '#f5c542' : '#39d98a';

  return (
    <div className="app">
      <header>
        <h1>Magic 8 Ball <span className="v2">v2</span></h1>
        <p className="tagline">Not random. Judged.</p>
      </header>

      <div className={`ball-stage ${phase}`} aria-busy={busy}>
        <div className="ball-shadow" aria-hidden="true" />
        <div className="ball-motion" aria-hidden="true">
          <div className="ball">
            <div className={`ball-rotor${turned ? ' turned' : ''}`}>
              <div className="ball-face number-face">
                <div className="number-disc"><span>8</span></div>
              </div>
              <div className="ball-face answer-face">
                <div className="window-rim">
                  <div className="answer-window">
                    <div className={`answer-die${phase === 'answered' ? ' surfaced' : ''}`}>
                      <span className={`answer${answer.length > 22 ? ' answer-long' : ''}`}>{answer}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div className="shell-reflection" />
          </div>
        </div>
      </div>
      <p className="ball-status" role="status" aria-live="polite" aria-atomic="true">
        {phase === 'resetting' ? 'One more question' : phase === 'shaking' ? 'Shaking' : phase === 'waiting' ? 'Let the answer rise' : phase === 'answered' ? answer : 'Ask a question. Give it a shake.'}
      </p>

      <form onSubmit={ask} className="ask-form">
        <textarea
          ref={inputRef}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onInput={autosize}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              if (!busy && question.trim()) e.currentTarget.form.requestSubmit();
            }
          }}
          aria-label="Your question"
          placeholder="Ask the ball anything…"
          maxLength={4096}
          rows={1}
          disabled={busy}
          autoFocus
        />
        <button type="submit" disabled={busy || !question.trim()}>
          {busy ? 'Asking…' : 'Shake'}
        </button>
      </form>

      <button
        type="button"
        className="share-btn"
        onClick={copyLink}
        disabled={!question.trim()}
        style={{
          margin: '10px auto 0',
          display: 'block',
          cursor: question.trim() ? 'pointer' : 'not-allowed',
          background: 'none',
          border: '1px solid rgba(255,255,255,.25)',
          color: 'inherit',
          opacity: question.trim() ? 1 : 0.4,
          borderRadius: 8,
          padding: '6px 14px',
          fontSize: '0.9rem',
        }}
      >
        {copied ? 'Link copied' : 'Copy share link'}
      </button>

      {error && <p className="error" role="alert">{error}</p>}

      {phase === 'answered' && result && (
        <details className="result">
          <summary>Behind the answer</summary>
          {result.summary && <p className="summary">{result.summary}</p>}
          <h2>Decision criteria</h2>
          <ul className="criteria">
            {(result.criteria || []).map((c) => (
              <li key={c.id}>
                <div className="crit-head">
                  <span className="crit-label">{c.label}</span>
                  <span className="crit-score">{c.score}/10</span>
                </div>
                {c.description && <p style={{ margin: '2px 0 6px', fontSize: '0.75rem', opacity: 0.55 }}>{c.description}</p>}
                <div className="bar">
                  <div
                    className={'fill' + (BAD_HIGH.has(c.id) ? ' bad' : '')}
                    style={{ width: `${c.score * 10}%` }}
                  />
                </div>
                {c.reason && <p className="crit-reason">{c.reason}</p>}
              </li>
            ))}
          </ul>
          {result.gate && (
            <p style={{ margin: '12px 0 0', fontSize: '0.85rem' }} title={result.gate.description}>
              🛑 {result.gate.label}:{' '}
              <strong style={{ color: gateColor }}>{gatePct}% impermissible</strong>
              {' '}— weighed into the verdict, never a veto
            </p>
          )}
          <p className="powered">ranked &amp; judged by <strong>~typesafe/jev-latest</strong> · context by DeepSeek Flash · via OpenRouter</p>
        </details>
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
