import React, { useMemo, useRef, useState } from 'react'

type ScanMode = 'advanced' | 'plagiarism' | 'hallucinations' | 'writing' | 'custom'

type ApiDetectResponse = {
  ok: boolean
  score?: number // 0..1 (higher => more likely AI)
  model?: string
  details?: {
    entropy?: number
    burstiness?: number
    tokenCount?: number
    sentenceCount?: number
  }
  notes?: string[]
  error?: string
}

function clamp(n: number, min = 0, max = 1) {
  return Math.max(min, Math.min(max, n))
}

function pct(n: number) {
  return `${Math.round(clamp(n) * 100)}%`
}

function shortCountLabel(text: string) {
  const words = text.trim().length ? text.trim().split(/\s+/).length : 0
  const chars = text.length
  return { words, chars }
}

function iconSvg(kind: string) {
  // simple inline icons (no deps)
  const common = { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', xmlns: 'http://www.w3.org/2000/svg' }
  switch (kind) {
    case 'home':
      return (
        <svg {...common}>
          <path d="M3 10.5L12 3l9 7.5V21a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1V10.5Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/>
        </svg>
      )
    case 'docs':
      return (
        <svg {...common}>
          <path d="M7 3h7l3 3v15a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" stroke="currentColor" strokeWidth="2"/>
          <path d="M14 3v4h4" stroke="currentColor" strokeWidth="2"/>
          <path d="M8.5 12h7M8.5 16h7" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
        </svg>
      )
    case 'review':
      return (
        <svg {...common}>
          <path d="M4 7a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v12l-4-3H6a2 2 0 0 1-2-2V7Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/>
          <path d="M8 9h6M8 12h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
        </svg>
      )
    case 'plus':
      return (
        <svg {...common}>
          <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
        </svg>
      )
    case 'help':
      return (
        <svg {...common}>
          <path d="M12 22a10 10 0 1 0-10-10 10 10 0 0 0 10 10Z" stroke="currentColor" strokeWidth="2"/>
          <path d="M9.5 9a2.5 2.5 0 1 1 4.2 1.8c-.8.7-1.7 1.1-1.7 2.2v.3" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
          <path d="M12 17h.01" stroke="currentColor" strokeWidth="3" strokeLinecap="round"/>
        </svg>
      )
    case 'settings':
      return (
        <svg {...common}>
          <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" stroke="currentColor" strokeWidth="2"/>
          <path d="M19.4 15a7.9 7.9 0 0 0 .1-1 7.9 7.9 0 0 0-.1-1l2-1.6-2-3.4-2.4 1a7.4 7.4 0 0 0-1.7-1l-.4-2.6H9.1l-.4 2.6a7.4 7.4 0 0 0-1.7 1l-2.4-1-2 3.4L4.6 13a7.9 7.9 0 0 0-.1 1 7.9 7.9 0 0 0 .1 1l-2 1.6 2 3.4 2.4-1a7.4 7.4 0 0 0 1.7 1l.4 2.6h5.8l.4-2.6a7.4 7.4 0 0 0 1.7-1l2.4 1 2-3.4-2-1.6Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/>
        </svg>
      )
    default:
      return null
  }
}

export default function App() {
  const fileRef = useRef<HTMLInputElement | null>(null)

  const [activeSide, setActiveSide] = useState<'home' | 'docs' | 'review'>('docs')

  const [text, setText] = useState<string>('')

  const [autoTrim, setAutoTrim] = useState(true)
  const [highlightSentences, setHighlightSentences] = useState(true)
  const [showBreakdown, setShowBreakdown] = useState(true)

  const [mode, setMode] = useState<ScanMode>('advanced')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<ApiDetectResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  const counts = useMemo(() => shortCountLabel(text), [text])
  const endpointLabel = useMemo(() => `POST /api/detect`, [])

  function setSample(which: 'human' | 'ai') {
    const human =
      `I planned to clean my desk this morning, but I ended up sorting old notes instead.
It's not dramatic—just a small reminder that attention drifts. I'm going to set a
20-minute timer, finish one task, and then decide what's worth keeping.`

    const ai =
      `In today’s fast-paced world, productivity is often defined by how efficiently we manage our time.
By organizing priorities, minimizing distractions, and using structured routines, individuals can
achieve better outcomes and maintain consistent progress toward their goals.`

    setText(which === 'human' ? human : ai)
    setResult(null)
    setError(null)
  }

  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (!f) return
    const content = await f.text()
    setText(content)
    setResult(null)
    setError(null)
  }

  function normalizedText() {
    let t = text
    if (autoTrim) t = t.trim()
    return t
  }

  async function runScan() {
    setError(null)
    setResult(null)

    const payloadText = normalizedText()
    if (!payloadText || payloadText.split(/\s+/).filter(Boolean).length < 10) {
      setError('Paste more text (recommended 40+ words) for a more stable score.')
      return
    }

    setLoading(true)
    try {
      const res = await fetch('/api/detect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: payloadText,
          mode,
          options: {
            highlightSentences,
            showBreakdown,
          },
        }),
      })

      // If the function returns non-2xx, try to surface a useful message.
      if (!res.ok) {
        let msg = `Scan failed (HTTP ${res.status}).`
        try {
          const maybeJson = await res.json()
          msg = (maybeJson?.error as string) || msg
        } catch {
          // non-JSON response, keep default msg
        }
        setError(msg)
        setResult(null)
        return
      }

      // Accept BOTH shapes:
      // 1) { ok: true, score, model, details }
      // 2) { score, model, details }   (no ok)
      const raw = (await res.json()) as any

      const hasScore = typeof raw?.score === 'number'
      const okField = typeof raw?.ok === 'boolean' ? raw.ok : undefined

      if (okField === false) {
        setError(raw?.error || 'Scan failed.')
        setResult(null)
        return
      }

      if (okField === true) {
        setResult(raw as ApiDetectResponse)
        return
      }

      if (hasScore) {
        // normalize into ApiDetectResponse
        const normalized: ApiDetectResponse = {
          ok: true,
          score: raw.score,
          model: raw.model,
          details: raw.details,
          notes: raw.notes,
        }
        setResult(normalized)
        return
      }

      // If we get here, backend returned JSON but not in an expected format.
      setError(raw?.error || 'Scan failed (unexpected response).')
      setResult(null)
    } catch (err: any) {
      setError(err?.message || 'Network error.')
    } finally {
      setLoading(false)
    }
  }

  const uiScore = result?.score ?? null
  const confidence =
    uiScore == null ? null :
    uiScore >= 0.7 ? 'High confidence' :
    uiScore >= 0.45 ? 'Medium confidence' :
    'Low confidence'

  return (
    <div className="appShell">
      {/* LEFT SIDEBAR (GPTZero-like) */}
      <aside className="sidebar" aria-label="UpCube Detect navigation">
        <div className="brandDot" title="UpCube Detect">U</div>

        <nav className="sideNav">
          <button
            className={`sideItem ${activeSide === 'home' ? 'sideItemActive' : ''}`}
            onClick={() => setActiveSide('home')}
            title="Home"
            aria-label="Home"
          >
            {iconSvg('home')}
          </button>

          <button
            className={`sideItem ${activeSide === 'docs' ? 'sideItemActive' : ''}`}
            onClick={() => setActiveSide('docs')}
            title="Documents"
            aria-label="Documents"
          >
            {iconSvg('docs')}
          </button>

          <button
            className={`sideItem ${activeSide === 'review' ? 'sideItemActive' : ''}`}
            onClick={() => setActiveSide('review')}
            title="AI Review"
            aria-label="AI Review"
          >
            {iconSvg('review')}
          </button>

          <button
            className="sideItem"
            onClick={() => alert('Coming soon')}
            title="New"
            aria-label="New"
          >
            {iconSvg('plus')}
          </button>
        </nav>

        <div className="sideSpacer" />

        <div className="sideFooter">
          <button className="sideItem" title="Help" aria-label="Help" onClick={() => alert('Help coming soon')}>
            {iconSvg('help')}
          </button>
          <button className="sideItem" title="Settings" aria-label="Settings" onClick={() => alert('Settings coming soon')}>
            {iconSvg('settings')}
          </button>
        </div>
      </aside>

      {/* MAIN */}
      <main className="main">
        <div className="wrap">
          {/* TOP BAR (like GPTZero doc header row) */}
          <div className="topBar">
            <div className="docTitle">
              <div>
                <h1>UpCube Detect <span>Untitled Document</span></h1>
              </div>
            </div>

            <div className="actionRow">
              <button className="btn btnGhost" onClick={() => setSample('human')}>Human sample</button>
              <button className="btn btnGhost" onClick={() => setSample('ai')}>AI sample</button>

              <input
                ref={fileRef}
                type="file"
                accept=".txt,.md,.docx"
                style={{ display: 'none' }}
                onChange={onPickFile}
              />
              <button className="btn" onClick={() => fileRef.current?.click()}>
                Upload
              </button>

              <button className="btn btnPrimary" onClick={runScan} disabled={loading}>
                {loading ? 'Scanning…' : 'Scan'}
              </button>
            </div>
          </div>

          {/* GRID: editor left, right panel like GPTZero */}
          <div className="grid">
            {/* LEFT: editor */}
            <section className="card editorShell" aria-label="Text input">
              <div className="editorHead">
                <div>
                  <h2>Paste text</h2>
                  <div className="sub">Or drag-drop a file anywhere · Recommended: 40+ words</div>
                </div>

                <div className="chips" aria-label="Counters">
                  <div className="chip">{counts.words} words</div>
                  <div className="chip">{counts.chars} chars</div>
                  <div className="chip">{endpointLabel}</div>
                </div>
              </div>

              <div className="textareaWrap">
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="Paste text here…"
                />
              </div>

              <div className="editorFoot">
                <div className="checkRow">
                  <label>
                    <input type="checkbox" checked={showBreakdown} onChange={(e) => setShowBreakdown(e.target.checked)} />
                    Show breakdown
                  </label>
                  <label>
                    <input type="checkbox" checked={highlightSentences} onChange={(e) => setHighlightSentences(e.target.checked)} />
                    Highlight sentences
                  </label>
                </div>

                <div className="checkRow">
                  <label>
                    <input type="checkbox" checked={autoTrim} onChange={(e) => setAutoTrim(e.target.checked)} />
                    Auto-trim
                  </label>
                </div>
              </div>
            </section>

            {/* RIGHT: scan types + results summary */}
            <aside className="rightStack" aria-label="Scan options and results">
              <section className="card">
                <div className="cardInner">
                  <div className="panelTitle">
                    <div>
                      <h3>Scan types</h3>
                      <p>Choose a scan, then click Scan.</p>
                    </div>
                  </div>

                  <div className="scanList">
                    <div
                      className="scanItem"
                      onClick={() => setMode('advanced')}
                      role="button"
                      aria-label="Advanced AI Scan"
                    >
                      <div className="scanLeft">
                        <div className="badge">AI</div>
                        <div>
                          <div style={{ fontWeight: 800, fontSize: 13 }}>Advanced AI Scan</div>
                          <div className="small">Multi-signal AI likelihood</div>
                        </div>
                      </div>
                      <div className={`badge ${mode === 'advanced' ? 'badgeOn' : 'badgeSoon'}`}>
                        {mode === 'advanced' ? 'On' : 'On'}
                      </div>
                    </div>

                    <div className="scanItem" role="button" aria-label="Plagiarism Check (coming soon)">
                      <div className="scanLeft">
                        <div className="badge">P</div>
                        <div>
                          <div style={{ fontWeight: 800, fontSize: 13 }}>Plagiarism Check</div>
                          <div className="small">Coming soon</div>
                        </div>
                      </div>
                      <div className="badge badgeSoon">Soon</div>
                    </div>

                    <div className="scanItem" role="button" aria-label="AI Hallucinations (coming soon)">
                      <div className="scanLeft">
                        <div className="badge">H</div>
                        <div>
                          <div style={{ fontWeight: 800, fontSize: 13 }}>AI Hallucinations</div>
                          <div className="small">Coming soon</div>
                        </div>
                      </div>
                      <div className="badge badgeSoon">Soon</div>
                    </div>

                    <div className="scanItem" role="button" aria-label="Writing Feedback (coming soon)">
                      <div className="scanLeft">
                        <div className="badge">W</div>
                        <div>
                          <div style={{ fontWeight: 800, fontSize: 13 }}>Writing Feedback</div>
                          <div className="small">Coming soon</div>
                        </div>
                      </div>
                      <div className="badge badgeSoon">Soon</div>
                    </div>

                    <div className="scanItem" role="button" aria-label="Create Custom Scan (coming soon)">
                      <div className="scanLeft">
                        <div className="badge">+</div>
                        <div>
                          <div style={{ fontWeight: 800, fontSize: 13 }}>Create Custom Scan</div>
                          <div className="small">Coming soon</div>
                        </div>
                      </div>
                      <div className="badge badgeSoon">Soon</div>
                    </div>
                  </div>

                  <div className="hr" />

                  <div className="small">
                    Usability tip: if you’re testing content, compare multiple drafts, not just one paragraph.
                  </div>
                </div>
              </section>

              <section className="card">
                <div className="cardInner">
                  <div className="panelTitle">
                    <div>
                      <h3>Results</h3>
                      <p>Probabilistic score — not a guarantee.</p>
                    </div>
                  </div>

                  {error ? <div className="toast">{error}</div> : null}

                  <div className="kpiRow" style={{ marginTop: 12 }}>
                    <div className="kpi">
                      <div className="kpiLabel">AI likelihood</div>
                      <div className="kpiValue">{uiScore == null ? '—' : pct(uiScore)}</div>
                      <div className="kpiHint">{uiScore == null ? 'Paste text and click Scan' : (confidence || '')}</div>
                    </div>

                    <div className="kpi">
                      <div className="kpiLabel">Model</div>
                      <div className="kpiValue" style={{ fontSize: 14, marginTop: 10 }}>
                        {result?.model || 'local-heuristic'}
                      </div>
                      <div className="kpiHint">Edge-safe, no external APIs</div>
                    </div>
                  </div>

                  {result?.details && showBreakdown ? (
                    <>
                      <div className="hr" />
                      <div className="small" style={{ fontWeight: 800, marginBottom: 8 }}>Signals</div>
                      <div className="kpiRow">
                        <div className="kpi">
                          <div className="kpiLabel">Entropy</div>
                          <div className="kpiValue" style={{ fontSize: 18 }}>
                            {result.details.entropy == null ? '—' : result.details.entropy.toFixed(2)}
                          </div>
                          <div className="kpiHint">Lexical diversity proxy</div>
                        </div>
                        <div className="kpi">
                          <div className="kpiLabel">Burstiness</div>
                          <div className="kpiValue" style={{ fontSize: 18 }}>
                            {result.details.burstiness == null ? '—' : result.details.burstiness.toFixed(2)}
                          </div>
                          <div className="kpiHint">Sentence variation</div>
                        </div>
                      </div>
                    </>
                  ) : null}

                  <div className="hr" />
                  <div className="small">
                    Tip: Best signal quality comes from longer samples (80+ words). Avoid super-short fragments.
                  </div>
                </div>
              </section>
            </aside>
          </div>
        </div>
      </main>
    </div>
  )
}
