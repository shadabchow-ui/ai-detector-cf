import React, { useMemo, useState } from 'react'

type DetectResponse = {
  ai_probability?: number
  confidence?: 'low' | 'medium' | 'high'
  signals?: Record<string, any>
  notes?: string[]
  error?: string
  label?: string
  scores?: {
    heuristic?: number
    zippy?: number
    detectgpt?: number
    ensemble?: number
  }
}

type ScanMode = 'advanced_ai' | 'plagiarism' | 'hallucinations' | 'writing_feedback' | 'custom'

function pct(n?: number) {
  if (typeof n !== 'number' || Number.isNaN(n)) return '—'
  return `${Math.round(n * 100)}%`
}

function clamp01(n: number) {
  return Math.max(0, Math.min(1, n))
}

function confidenceBadge(conf?: string) {
  if (conf === 'high') return { label: 'High confidence', tone: 'bad' }
  if (conf === 'medium') return { label: 'Medium confidence', tone: 'mid' }
  if (conf === 'low') return { label: 'Low confidence', tone: 'good' }
  return { label: '—', tone: 'neutral' }
}

function formatNumber(n?: number, digits = 3) {
  if (typeof n !== 'number' || Number.isNaN(n)) return '—'
  return n.toFixed(digits)
}

function sampleHuman() {
  return `I planned to clean my desk this morning, but I ended up sorting old notes instead. It’s not dramatic—just a small reminder that attention drifts. I’m going to set a 20-minute timer, finish one task, and then decide what’s worth keeping.`
}

function sampleAIish() {
  return `In today’s rapidly evolving digital landscape, it is essential to recognize that productivity is a multifaceted concept influenced by numerous variables. By implementing structured time-management strategies and maintaining consistent routines, individuals can optimize outcomes and achieve measurable improvements.`
}

export default function App() {
  const [text, setText] = useState('')
  const [mode, setMode] = useState<ScanMode>('advanced_ai')
  const [includeBreakdown, setIncludeBreakdown] = useState(true)
  const [isCalibrating, setIsCalibrating] = useState(false)
  const [calLabel, setCalLabel] = useState<'human' | 'ai'>('human')

  const [loading, setLoading] = useState(false)
  const [res, setRes] = useState<DetectResponse | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const words = useMemo(() => {
    const m = text.trim().match(/\b[\p{L}\p{N}'-]+\b/gu)
    return m ? m.length : 0
  }, [text])

  const chars = text.length

  const endpoint = '/api/detect'

  const disabledModes: ScanMode[] = ['plagiarism', 'hallucinations', 'writing_feedback', 'custom']
  const isDisabled = disabledModes.includes(mode)

  async function analyze() {
    setErr(null)
    setRes(null)

    if (isDisabled) {
      setErr('That scan type is coming soon. For now, use Advanced AI Scan.')
      return
    }

    const t = text.trim()
    if (!t) {
      setErr('Paste some text first.')
      return
    }

    setLoading(true)
    try {
      const payload: any = { text: t }
      if (isCalibrating) {
        payload.mode = 'calibration'
        payload.label = calLabel
      }

      const r = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      const data = (await r.json()) as DetectResponse
      if (!r.ok) {
        setErr(data?.error ?? 'Request failed.')
        setRes(data)
      } else {
        setRes(data)
      }
    } catch (e: any) {
      setErr(e?.message ?? 'Network error.')
    } finally {
      setLoading(false)
    }
  }

  const aiProb = typeof res?.ai_probability === 'number' ? clamp01(res!.ai_probability!) : undefined
  const badge = confidenceBadge(res?.confidence)

  // Pull known signals if present
  const zippyScore = res?.signals?.zippy_score ?? res?.signals?.zippyScore
  const detectgptStability = res?.signals?.detectgpt_stability ?? res?.signals?.detectgptStability
  const compressionRatio = res?.signals?.compression_ratio

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="logo" aria-hidden="true">◎</div>
          <div>
            <div className="brandTitle">AI Text Detector</div>
            <div className="brandSub">Edge-deployed on Cloudflare Pages • Multi-signal scoring</div>
          </div>
        </div>

        <div className="topActions">
          <button
            className="btn ghost"
            onClick={() => setText(sampleHuman())}
            type="button"
          >
            Load human sample
          </button>
          <button
            className="btn ghost"
            onClick={() => setText(sampleAIish())}
            type="button"
          >
            Load AI sample
          </button>
          <button
            className="btn primary"
            onClick={analyze}
            disabled={loading}
            type="button"
          >
            {loading ? (
              <>
                <span className="spinner" aria-hidden="true" />
                Scanning…
              </>
            ) : (
              <>Scan</>
            )}
          </button>
        </div>
      </header>

      <main className="layout">
        {/* LEFT: Editor + Results */}
        <section className="mainCol">
          <div className="card editorCard">
            <div className="cardHeader">
              <div>
                <div className="cardTitle">Paste text</div>
                <div className="cardHint">Recommended: 40+ words for better stability</div>
              </div>
              <div className="meta">
                <span className="pill">{words} words</span>
                <span className="pill">{chars} chars</span>
              </div>
            </div>

            <div className="editorWrap">
              <textarea
                className="textarea"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Paste text here…"
                spellCheck={false}
              />
            </div>

            <div className="editorFooter">
              <div className="leftFoot">
                <span className="endpoint">
                  Endpoint: <code>POST {endpoint}</code>
                </span>
              </div>

              <div className="rightFoot">
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={includeBreakdown}
                    onChange={(e) => setIncludeBreakdown(e.target.checked)}
                  />
                  <span>Show breakdown</span>
                </label>

                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={isCalibrating}
                    onChange={(e) => setIsCalibrating(e.target.checked)}
                  />
                  <span>Calibration mode</span>
                </label>

                {isCalibrating && (
                  <select
                    className="select"
                    value={calLabel}
                    onChange={(e) => setCalLabel(e.target.value as any)}
                    aria-label="Calibration label"
                  >
                    <option value="human">Label: human</option>
                    <option value="ai">Label: ai</option>
                  </select>
                )}
              </div>
            </div>
          </div>

          {err && (
            <div className="alert bad">
              <div className="alertTitle">Heads up</div>
              <div className="alertBody">{err}</div>
            </div>
          )}

          {res && !isCalibrating && (
            <div className="card resultsCard">
              <div className="cardHeader">
                <div>
                  <div className="cardTitle">Results</div>
                  <div className="cardHint">Probabilistic score — not a guarantee.</div>
                </div>
                <span className={`badge ${badge.tone}`}>{badge.label}</span>
              </div>

              <div className="scoreRow">
                <div className="scoreBig">
                  <div className="scoreLabel">AI likelihood</div>
                  <div className="scoreValue">{pct(aiProb)}</div>
                </div>

                <div className="scoreBarWrap" aria-label="AI likelihood bar">
                  <div className="scoreBar">
                    <div
                      className="scoreFill"
                      style={{ width: `${Math.round((aiProb ?? 0) * 100)}%` }}
                    />
                  </div>
                  <div className="scoreTicks">
                    <span>0</span><span>25</span><span>50</span><span>75</span><span>100</span>
                  </div>
                </div>
              </div>

              {includeBreakdown && (
                <div className="grid3">
                  <div className="metric">
                    <div className="metricLabel">ZipPy entropy</div>
                    <div className="metricValue">{pct(typeof zippyScore === 'number' ? zippyScore : undefined)}</div>
                    <div className="metricHint">
                      Compression ratio: <b>{formatNumber(compressionRatio, 3)}</b>
                    </div>
                  </div>

                  <div className="metric">
                    <div className="metricLabel">DetectGPT-style stability</div>
                    <div className="metricValue">{pct(typeof detectgptStability === 'number' ? detectgptStability : undefined)}</div>
                    <div className="metricHint">Stability under light perturbations</div>
                  </div>

                  <div className="metric">
                    <div className="metricLabel">Text length</div>
                    <div className="metricValue">{res?.signals?.length ?? words}</div>
                    <div className="metricHint">More text → better signal</div>
                  </div>
                </div>
              )}

              {Array.isArray(res.notes) && res.notes.length > 0 && (
                <div className="notes">
                  <div className="notesTitle">Notes</div>
                  <ul>
                    {res.notes.slice(0, 6).map((n, i) => (
                      <li key={i}>{n}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {res && isCalibrating && (
            <div className="card resultsCard">
              <div className="cardHeader">
                <div>
                  <div className="cardTitle">Calibration output</div>
                  <div className="cardHint">Use this to collect labeled score distributions.</div>
                </div>
                <span className="badge neutral">Label: {res.label ?? calLabel}</span>
              </div>

              <div className="grid3">
                <div className="metric">
                  <div className="metricLabel">Heuristic</div>
                  <div className="metricValue">{pct(res.scores?.heuristic)}</div>
                  <div className="metricHint">Baseline structural signal</div>
                </div>

                <div className="metric">
                  <div className="metricLabel">ZipPy</div>
                  <div className="metricValue">{pct(res.scores?.zippy)}</div>
                  <div className="metricHint">Compression entropy</div>
                </div>

                <div className="metric">
                  <div className="metricLabel">DetectGPT</div>
                  <div className="metricValue">{pct(res.scores?.detectgpt)}</div>
                  <div className="metricHint">Perturbation stability</div>
                </div>
              </div>

              <div className="calRow">
                <div className="metric wide">
                  <div className="metricLabel">Ensemble</div>
                  <div className="metricValue">{pct(res.scores?.ensemble)}</div>
                  <div className="metricHint">Save results (human vs ai) and tune thresholds.</div>
                </div>
                <button
                  className="btn ghost"
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(JSON.stringify(res, null, 2))
                  }}
                >
                  Copy JSON
                </button>
              </div>
            </div>
          )}
        </section>

        {/* RIGHT: Sidebar */}
        <aside className="sideCol">
          <div className="card sideCard">
            <div className="sideHeader">
              <div className="sideTitle">Scan types</div>
              <div className="sideSub">Choose a scan, then click Scan.</div>
            </div>

            <div className="scanList">
              <button
                className={`scanItem ${mode === 'advanced_ai' ? 'active' : ''}`}
                onClick={() => setMode('advanced_ai')}
                type="button"
              >
                <div className="scanIcon">◉</div>
                <div className="scanText">
                  <div className="scanName">Advanced AI Scan</div>
                  <div className="scanDesc">Multi-signal AI likelihood</div>
                </div>
                <div className="scanTag ok">On</div>
              </button>

              <button
                className={`scanItem ${mode === 'plagiarism' ? 'active' : ''}`}
                onClick={() => setMode('plagiarism')}
                type="button"
              >
                <div className="scanIcon">⧉</div>
                <div className="scanText">
                  <div className="scanName">Plagiarism Check</div>
                  <div className="scanDesc">Coming soon</div>
                </div>
                <div className="scanTag off">Soon</div>
              </button>

              <button
                className={`scanItem ${mode === 'hallucinations' ? 'active' : ''}`}
                onClick={() => setMode('hallucinations')}
                type="button"
              >
                <div className="scanIcon">✦</div>
                <div className="scanText">
                  <div className="scanName">AI Hallucinations</div>
                  <div className="scanDesc">Coming soon</div>
                </div>
                <div className="scanTag off">Soon</div>
              </button>

              <button
                className={`scanItem ${mode === 'writing_feedback' ? 'active' : ''}`}
                onClick={() => setMode('writing_feedback')}
                type="button"
              >
                <div className="scanIcon">✎</div>
                <div className="scanText">
                  <div className="scanName">Writing Feedback</div>
                  <div className="scanDesc">Coming soon</div>
                </div>
                <div className="scanTag off">Soon</div>
              </button>

              <button
                className={`scanItem ${mode === 'custom' ? 'active' : ''}`}
                onClick={() => setMode('custom')}
                type="button"
              >
                <div className="scanIcon">＋</div>
                <div className="scanText">
                  <div className="scanName">Create Custom Scan</div>
                  <div className="scanDesc">Coming soon</div>
                </div>
                <div className="scanTag off">Soon</div>
              </button>
            </div>

            <div className="sideFooter">
              <div className="smallMuted">
                Tip: For best results, test with multiple paragraphs. Short text can look “AI-ish” even when it isn’t.
              </div>
            </div>
          </div>

          <div className="card sideCard">
            <div className="sideHeader">
              <div className="sideTitle">How scoring works</div>
              <div className="sideSub">Transparent signals, no external APIs.</div>
            </div>

            <div className="bullets">
              <div className="bullet">
                <div className="dot" />
                <div><b>Heuristics:</b> repetition, burstiness, lexical diversity.</div>
              </div>
              <div className="bullet">
                <div className="dot" />
                <div><b>ZipPy entropy:</b> compressibility of text (gzip ratio).</div>
              </div>
              <div className="bullet">
                <div className="dot" />
                <div><b>DetectGPT-style:</b> stability under light perturbations.</div>
              </div>
            </div>

            <div className="sideFooter">
              <div className="smallMuted">
                If you want the UI to match GPTZero even closer (fonts, spacing, micro-interactions), say “v2 polish” and I’ll tune it.
              </div>
            </div>
          </div>
        </aside>
      </main>

      <footer className="footer">
        <div className="smallMuted">
          Open-source • Edge-safe • Built for Cloudflare Pages Functions
        </div>
      </footer>
    </div>
  )
}
