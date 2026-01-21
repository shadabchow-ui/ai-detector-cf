import React, { useMemo, useState } from 'react'

type ApiResult = {
  ai_probability: number
  confidence: 'low' | 'medium' | 'high'
  signals: {
    length: number
    burstiness: number
    repetition: number
    punctuation_rate: number
    avg_word_len: number
    unique_word_ratio: number
  }
  notes: string[]
}

function confidenceFrom(p: number): ApiResult['confidence'] {
  if (p >= 0.80) return 'high'
  if (p >= 0.55) return 'medium'
  return 'low'
}

export default function App() {
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(false)
  const [res, setRes] = useState<ApiResult | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const charCount = text.length
  const wordCount = useMemo(() => {
    const w = text.trim().match(/\b[\p{L}\p{N}'-]+\b/gu)
    return w ? w.length : 0
  }, [text])

  async function analyze() {
    setErr(null)
    setLoading(true)
    setRes(null)
    try {
      const r = await fetch('/api/detect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      if (!r.ok) {
        const t = await r.text()
        throw new Error(t || `HTTP ${r.status}`)
      }
      const data = (await r.json()) as ApiResult
      setRes(data)
    } catch (e: any) {
      setErr(e?.message ?? 'Request failed')
    } finally {
      setLoading(false)
    }
  }

  function fillSample() {
    setText(
      `In recent years, large language models have become widely used for drafting content. This tool estimates the likelihood that a passage was produced by an automated system based on statistical signals such as repetition, word diversity, punctuation patterns, and sentence-length variance. It is not definitive proof—treat it as a probabilistic indicator and combine it with human review.`
    )
  }

  const p = res?.ai_probability ?? 0
  const pct = Math.round(p * 100)
  const conf = res ? confidenceFrom(res.ai_probability) : null

  return (
    <div className="container">
      <div className="card">
        <div className="row" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h1>AI Text Detector (Cloudflare Pages)</h1>
            <small className="muted">
              Open-source, edge-safe. Probabilistic score (not a guarantee).
            </small>
          </div>
          <div className="row">
            <button className="btn secondary" onClick={fillSample} disabled={loading}>
              Sample
            </button>
            <button className="btn" onClick={analyze} disabled={loading || wordCount < 40}>
              {loading ? 'Analyzing…' : 'Analyze'}
            </button>
          </div>
        </div>

        <hr className="sep" />

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Paste text here (40+ words recommended)…"
        />
        <div className="row" style={{ marginTop: 10, justifyContent: 'space-between' }}>
          <small className="muted">{wordCount} words · {charCount} chars</small>
          <small className="muted">Endpoint: <span className="tag">POST /api/detect</span></small>
        </div>

        {err && (
          <>
            <hr className="sep" />
            <div className="tag" style={{ borderColor: 'rgba(239,68,68,0.5)' }}>
              Error: {err}
            </div>
          </>
        )}

        {res && (
          <>
            <hr className="sep" />
            <div className="row" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
              <div className="row" style={{ alignItems: 'center' }}>
                <span className="tag">
                  AI likelihood: <b style={{ marginLeft: 6 }}>{pct}%</b>
                </span>
                <span className="tag">
                  Confidence: <b style={{ marginLeft: 6 }}>{conf}</b>
                </span>
              </div>
              <small className="muted">
                Tip: mix signals + human judgment; avoid “gotcha” decisions.
              </small>
            </div>

            <div className="bar" style={{ marginTop: 10 }}>
              <div style={{ width: `${pct}%`, background: p >= 0.8 ? '#ef4444' : p >= 0.55 ? '#f59e0b' : '#22c55e' }} />
            </div>

            <hr className="sep" />

            <h2>Signals</h2>
            <div className="kpi">
              <div>
                <small className="muted">Burstiness</small><br />
                <b>{res.signals.burstiness.toFixed(3)}</b>
              </div>
              <div>
                <small className="muted">Repetition</small><br />
                <b>{res.signals.repetition.toFixed(3)}</b>
              </div>
              <div>
                <small className="muted">Unique word ratio</small><br />
                <b>{res.signals.unique_word_ratio.toFixed(3)}</b>
              </div>
              <div>
                <small className="muted">Punctuation rate</small><br />
                <b>{res.signals.punctuation_rate.toFixed(3)}</b>
              </div>
              <div>
                <small className="muted">Avg word length</small><br />
                <b>{res.signals.avg_word_len.toFixed(2)}</b>
              </div>
              <div>
                <small className="muted">Length</small><br />
                <b>{res.signals.length}</b>
              </div>
            </div>

            <hr className="sep" />

            <h2>Notes</h2>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {res.notes.map((n, i) => (
                <li key={i} style={{ marginBottom: 6 }}>
                  <small className="muted">{n}</small>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <div style={{ marginTop: 14 }}>
        <small className="muted">
          This starter uses lightweight statistical signals to stay Edge-compatible.
          If you want stronger detection, we can add a second-pass method (DetectGPT-style) later.
        </small>
      </div>
    </div>
  )
}
