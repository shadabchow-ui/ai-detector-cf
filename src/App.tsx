import React, { useMemo, useRef, useState } from 'react'

type DetectResult = {
  ok: boolean
  score: number // 0..1 AI likelihood
  model?: string
  details?: {
    entropy?: number
    burstiness?: number
    gzipRatio?: number
    tokenCount?: number
    sentenceCount?: number
  }
  notes?: string[]
  error?: string
}

type ScanMode = 'advanced_ai'

type HistoryItem = {
  id: string
  ts: number
  mode: ScanMode
  text: string
  result: DetectResult
}

const HUMAN_SAMPLE =
  `I planned to clean my desk this morning, but I ended up sorting old notes instead.
It's not dramatic—just a small reminder that attention drifts. I'm going to set a
20-minute timer, finish one task, and then decide what's worth keeping.`

const AI_SAMPLE =
  `In the modern information ecosystem, language patterns can be evaluated using statistical
features such as distributional predictability, repetition rate, and sentence structure stability.
When multiple signals converge, the probability of machine-generated text increases.`

function clamp(n: number, a = 0, b = 1) {
  return Math.max(a, Math.min(b, n))
}

function nowId() {
  return Math.random().toString(16).slice(2) + '-' + Date.now().toString(16)
}

function splitSentences(input: string) {
  const text = input.replace(/\s+/g, ' ').trim()
  if (!text) return []
  // simple sentence split that behaves nicely for UI preview
  return text
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(Boolean)
    .slice(0, 12)
}

function confidenceLabel(p: number) {
  if (p < 0.33) return 'Low confidence'
  if (p < 0.66) return 'Medium confidence'
  return 'High confidence'
}

function localHeuristic(text: string): DetectResult {
  const raw = text.trim()
  const sentences = splitSentences(raw)
  const words = raw ? raw.split(/\s+/).filter(Boolean) : []
  const tokenCount = words.length

  // crude lexical diversity
  const lower = words.map(w => w.toLowerCase().replace(/[^a-z0-9']/g, ''))
  const uniq = new Set(lower.filter(Boolean))
  const diversity = words.length ? uniq.size / words.length : 0

  // repetition proxy
  let repeats = 0
  const freq = new Map<string, number>()
  for (const w of lower) {
    if (!w) continue
    freq.set(w, (freq.get(w) || 0) + 1)
  }
  for (const [, c] of freq) {
    if (c >= 4) repeats += c
  }
  const repetition = words.length ? repeats / words.length : 0

  // sentence length variance proxy (burstiness-ish)
  const lens = sentences.map(s => s.split(/\s+/).filter(Boolean).length).filter(n => n > 0)
  const mean = lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : 0
  const variance = lens.length ? lens.reduce((a, b) => a + (b - mean) * (b - mean), 0) / lens.length : 0

  // score: lower diversity + higher repetition + very stable sentence length => more AI-ish
  const s = clamp(
    0.55 * (1 - diversity) +
      0.30 * repetition +
      0.15 * (variance < 18 ? 0.8 : 0.2)
  )

  return {
    ok: true,
    score: s,
    model: 'local-heuristic',
    details: {
      entropy: diversity,
      burstiness: variance,
      tokenCount,
      sentenceCount: sentences.length,
    },
    notes: [
      'Local fallback scoring (no API).',
      'Use longer samples (80+ words) for better signal.',
    ],
  }
}

async function apiDetect(text: string): Promise<DetectResult> {
  // Try the most common payloads without breaking your existing worker.
  const candidates = [
    { text },
    { input: text },
    { content: text },
    { text, mode: 'ai' },
  ]

  let lastErr = ''
  for (const body of candidates) {
    try {
      const res = await fetch('/api/detect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        lastErr = `HTTP ${res.status}`
        continue
      }

      const data = await res.json()

      // normalize common response shapes
      const scoreRaw =
        typeof data?.score === 'number' ? data.score :
        typeof data?.ai === 'number' ? data.ai :
        typeof data?.probability === 'number' ? data.probability :
        typeof data?.result?.score === 'number' ? data.result.score :
        null

      if (scoreRaw === null) {
        lastErr = 'No score in response'
        continue
      }

      const score = clamp(scoreRaw)
      const details = data?.details || data?.result?.details || {}
      const model = data?.model || data?.result?.model || 'api'
      const notes = data?.notes || data?.result?.notes || []

      return {
        ok: true,
        score,
        model,
        details: {
          entropy: typeof details?.entropy === 'number' ? details.entropy : undefined,
          burstiness: typeof details?.burstiness === 'number' ? details.burstiness : undefined,
          gzipRatio: typeof details?.gzipRatio === 'number' ? details.gzipRatio : undefined,
          tokenCount: typeof details?.tokenCount === 'number' ? details.tokenCount : undefined,
          sentenceCount: typeof details?.sentenceCount === 'number' ? details.sentenceCount : undefined,
        },
        notes: Array.isArray(notes) ? notes : [],
      }
    } catch (e: any) {
      lastErr = e?.message || 'Network error'
    }
  }

  return { ok: false, score: 0, error: lastErr || 'API failed' }
}

export default function App() {
  const [text, setText] = useState('')
  const [mode] = useState<ScanMode>('advanced_ai')
  const [activeTab, setActiveTab] = useState<'scan' | 'history'>('scan')

  const [showBreakdown, setShowBreakdown] = useState(true)
  const [highlightSentences, setHighlightSentences] = useState(true)

  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<DetectResult | null>(null)
  const [history, setHistory] = useState<HistoryItem[]>([])

  const fileRef = useRef<HTMLInputElement | null>(null)

  const words = useMemo(() => {
    const w = text.trim().split(/\s+/).filter(Boolean)
    return w.length
  }, [text])

  const chars = useMemo(() => text.length, [text])

  const sentences = useMemo(() => splitSentences(text), [text])

  const scorePct = useMemo(() => {
    const s = result?.ok ? result.score : 0
    return Math.round(clamp(s) * 100)
  }, [result])

  const confidence = useMemo(() => confidenceLabel((result?.ok ? result.score : 0) ?? 0), [result])

  const onSample = (kind: 'human' | 'ai') => {
    setText(kind === 'human' ? HUMAN_SAMPLE : AI_SAMPLE)
    setResult(null)
  }

  const onUpload = async (file: File) => {
    const name = file.name.toLowerCase()
    if (!(name.endsWith('.txt') || name.endsWith('.md'))) {
      // keep it simple + safe: no docx parsing in-browser here
      setResult({
        ok: false,
        score: 0,
        error: 'Only .txt or .md upload is supported right now.',
      })
      return
    }
    const content = await file.text()
    setText(content)
    setResult(null)
  }

  const runScan = async () => {
    const trimmed = text.trim()
    if (!trimmed) return

    setLoading(true)
    setResult(null)

    let r = await apiDetect(trimmed)
    if (!r.ok) {
      r = localHeuristic(trimmed)
      r.notes = [...(r.notes || []), `API error: ${r.error || 'unknown'}`]
    }

    setResult(r)

    const item: HistoryItem = {
      id: nowId(),
      ts: Date.now(),
      mode,
      text: trimmed,
      result: r,
    }
    setHistory(prev => [item, ...prev].slice(0, 10))

    setLoading(false)
    setActiveTab('scan')
  }

  const pickHistory = (h: HistoryItem) => {
    setText(h.text)
    setResult(h.result)
    setActiveTab('scan')
  }

  const clearAll = () => {
    setText('')
    setResult(null)
  }

  return (
    <div className="container">
      <div className="topbar">
        <div className="brand">
          <div className="logo" />
          <div className="title">
            <strong>AI Text Detector</strong>
            <span>GPTZero-style UI · Cloudflare Pages · Multi-signal scoring</span>
          </div>
        </div>

        <div className="pills">
          <button className="pill ghost" onClick={() => onSample('human')}>Human sample</button>
          <button className="pill ghost" onClick={() => onSample('ai')}>AI sample</button>

          <button
            className="pill ghost"
            onClick={() => fileRef.current?.click()}
          >
            Upload
          </button>

          <button
            className="pill primary"
            disabled={loading || !text.trim()}
            onClick={runScan}
            title={!text.trim() ? 'Paste text first' : 'Run scan'}
          >
            {loading ? 'Scanning…' : 'Scan'}
          </button>

          <input
            ref={fileRef}
            type="file"
            accept=".txt,.md"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) onUpload(f)
              e.currentTarget.value = ''
            }}
          />
        </div>
      </div>

      <div className="layout">
        {/* LEFT */}
        <div className="card">
          <div className="cardInner">
            <div className="cardHeader">
              <div className="hgroup">
                <h2>Paste text</h2>
                <p>Or drag-drop a file anywhere · Recommended: 40+ words</p>
              </div>

              <div className="chips">
                <span className="chip">{words} words</span>
                <span className="chip">{chars} chars</span>
                <span className="chip">POST /api/detect</span>
              </div>
            </div>

            <div className="editorWrap">
              <textarea
                className="textarea"
                placeholder="Paste text here…"
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            </div>

            <div className="editorFooter">
              <div className="toggles">
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={showBreakdown}
                    onChange={(e) => setShowBreakdown(e.target.checked)}
                  />
                  Show breakdown
                </label>

                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={highlightSentences}
                    onChange={(e) => setHighlightSentences(e.target.checked)}
                  />
                  Highlight sentences
                </label>
              </div>

              <div className="smallRow">
                <button className="pill ghost" onClick={clearAll}>Clear</button>
              </div>
            </div>

            {showBreakdown && (
              <>
                <hr className="sep" />

                <div className="resultsGrid">
                  <div className="metric">
                    <div className="label">
                      <span>AI likelihood</span>
                      <span style={{ fontWeight: 700, color: (scorePct < 33 ? 'var(--ok)' : scorePct < 66 ? 'var(--warn)' : 'var(--bad)') }}>
                        {confidence}
                      </span>
                    </div>

                    <strong>{result?.ok ? `${scorePct}%` : '—'}</strong>

                    <div className="bar" aria-label="score bar">
                      <div style={{ width: `${result?.ok ? scorePct : 0}%` }} />
                    </div>

                    <div className="kv">
                      <span className="k">Model: {result?.model || '—'}</span>
                      <span className="k">Sentences: {result?.details?.sentenceCount ?? sentences.length}</span>
                      <span className="k">Tokens: {result?.details?.tokenCount ?? words}</span>
                    </div>

                    {result?.notes?.length ? (
                      <div className="note">
                        {result.notes.slice(0, 3).map((n, i) => (
                          <div key={i}>• {n}</div>
                        ))}
                      </div>
                    ) : null}

                    {result?.error ? (
                      <div className="note">Error: {result.error}</div>
                    ) : null}
                  </div>

                  <div className="metric">
                    <div className="label">
                      <span>Sentence preview</span>
                      <span style={{ fontWeight: 700, color: 'var(--muted)' }}>Preview only</span>
                    </div>

                    <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--muted)', lineHeight: 1.55 }}>
                      Heatmap highlights are approximate. Best signal quality comes from longer samples (80+ words).
                    </div>

                    <div className="kv">
                      <span className="k">Signals: repetition</span>
                      <span className="k">Signals: burstiness</span>
                      <span className="k">Signals: lexical diversity</span>
                    </div>
                  </div>
                </div>

                <div className="preview">
                  <div className="previewHeader">
                    <strong>Sentence-level view</strong>
                    <button onClick={runScan} disabled={loading || !text.trim()}>
                      {loading ? 'Scanning…' : 'Re-scan'}
                    </button>
                  </div>

                  {sentences.length === 0 ? (
                    <div className="mini">Paste text and click Scan to see sentence-level preview.</div>
                  ) : (
                    sentences.map((s, idx) => (
                      <div className="sentence" key={idx}>
                        {highlightSentences ? <mark>{s}</mark> : s}
                      </div>
                    ))
                  )}
                </div>

                <div className="footerPad" />
              </>
            )}
          </div>
        </div>

        {/* RIGHT */}
        <div className="rightPanel">
          <div className="card">
            <div className="cardInner">
              <div className="panelTabs">
                <button
                  className={'tab ' + (activeTab === 'scan' ? 'active' : '')}
                  onClick={() => setActiveTab('scan')}
                >
                  Scan types
                </button>
                <button
                  className={'tab ' + (activeTab === 'history' ? 'active' : '')}
                  onClick={() => setActiveTab('history')}
                >
                  History ({history.length})
                </button>
              </div>

              <div style={{ marginTop: 12 }}>
                {activeTab === 'scan' ? (
                  <div className="scanList">
                    <div className="scanItem">
                      <div className="scanLeft">
                        <div className="icon">AI</div>
                        <div className="scanText">
                          <strong>Advanced AI Scan</strong>
                          <span>Multi-signal AI likelihood</span>
                        </div>
                      </div>
                      <span className="badge on">On</span>
                    </div>

                    <div className="scanItem">
                      <div className="scanLeft">
                        <div className="icon">⧉</div>
                        <div className="scanText">
                          <strong>Plagiarism Check</strong>
                          <span>Coming soon</span>
                        </div>
                      </div>
                      <span className="badge soon">Soon</span>
                    </div>

                    <div className="scanItem">
                      <div className="scanLeft">
                        <div className="icon">✓</div>
                        <div className="scanText">
                          <strong>AI Hallucinations</strong>
                          <span>Coming soon</span>
                        </div>
                      </div>
                      <span className="badge soon">Soon</span>
                    </div>

                    <div className="scanItem">
                      <div className="scanLeft">
                        <div className="icon">✎</div>
                        <div className="scanText">
                          <strong>Writing Feedback</strong>
                          <span>Coming soon</span>
                        </div>
                      </div>
                      <span className="badge soon">Soon</span>
                    </div>

                    <div className="scanItem">
                      <div className="scanLeft">
                        <div className="icon">＋</div>
                        <div className="scanText">
                          <strong>Create Custom Scan</strong>
                          <span>Coming soon</span>
                        </div>
                      </div>
                      <span className="badge soon">Soon</span>
                    </div>
                  </div>
                ) : (
                  <div className="scanList">
                    {history.length === 0 ? (
                      <div className="mini">No scans yet. Run a scan and it’ll show up here.</div>
                    ) : (
                      history.map(h => (
                        <button
                          key={h.id}
                          className="scanItem"
                          style={{ cursor: 'pointer' }}
                          onClick={() => pickHistory(h)}
                          title="Click to load this scan"
                        >
                          <div className="scanLeft">
                            <div className="icon">{Math.round(h.result.score * 100)}</div>
                            <div className="scanText">
                              <strong>{new Date(h.ts).toLocaleTimeString()}</strong>
                              <span>{h.text.slice(0, 52)}{h.text.length > 52 ? '…' : ''}</span>
                            </div>
                          </div>
                          <span className="badge">{confidenceLabel(h.result.score)}</span>
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="card">
            <div className="cardInner mini">
              <div style={{ fontWeight: 800, marginBottom: 6 }}>How scoring works</div>
              Transparent signals, no external APIs required.
              <ul>
                <li><strong>Heuristics:</strong> repetition, burstiness, lexical diversity.</li>
                <li><strong>Zip entropy:</strong> compressibility ratio (if your API returns it).</li>
                <li><strong>DetectGPT-style:</strong> stability under perturbations (optional later).</li>
              </ul>
              Tooltips are built in: hover over metrics for explanation (you can add these next).
            </div>
          </div>

          <button className="scanButton" onClick={runScan} disabled={loading || !text.trim()}>
            {loading ? 'Scanning…' : 'Scan'}
            <span aria-hidden="true">→</span>
          </button>
        </div>
      </div>
    </div>
  )
}
