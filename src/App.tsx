import React, { useEffect, useMemo, useRef, useState } from 'react'

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
type Theme = 'dark' | 'light'

type HistoryItem = {
  id: string
  ts: number
  mode: ScanMode
  words: number
  chars: number
  score?: number
  confidence?: string
  snippet: string
  text: string
}

const LS_HISTORY_KEY = 'ai_detector_history_v1'
const LS_THEME_KEY = 'ai_detector_theme_v1'

function clamp01(n: number) {
  return Math.max(0, Math.min(1, n))
}
function pct(n?: number) {
  if (typeof n !== 'number' || Number.isNaN(n)) return '—'
  return `${Math.round(clamp01(n) * 100)}%`
}
function formatNumber(n?: number, digits = 3) {
  if (typeof n !== 'number' || Number.isNaN(n)) return '—'
  return n.toFixed(digits)
}
function nowId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function tokenizeWords(text: string): string[] {
  return text.toLowerCase().match(/\b[\p{L}\p{N}'-]+\b/gu) ?? []
}
function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(Boolean)
}
function stddev(nums: number[]): number {
  if (nums.length <= 1) return 0
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length
  const v = nums.reduce((a, b) => a + (b - mean) ** 2, 0) / (nums.length - 1)
  return Math.sqrt(v)
}

// Quick local heuristic (for sentence highlighting only)
function computeSignals(text: string) {
  const words = tokenizeWords(text)
  const length = words.length

  const sentences = splitSentences(text)
  const sentenceLens = sentences.map(s => tokenizeWords(s).length).filter(n => n > 0)

  const burstiness = sentenceLens.length
    ? clamp01(
        stddev(sentenceLens) /
          ((sentenceLens.reduce((a, b) => a + b, 0) / sentenceLens.length) + 1e-6)
      )
    : 0

  const uniq = new Set(words)
  const unique_word_ratio = length ? clamp01(uniq.size / length) : 0

  const counts = new Map<string, number>()
  for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1)
  const repeats = Array.from(counts.values()).reduce((a, c) => a + Math.max(0, c - 1), 0)
  const repetition = length ? clamp01(repeats / length) : 0

  const punct = (text.match(/[.,!?;:]/g) ?? []).length
  const punctuation_rate = text.length ? clamp01(punct / text.length) : 0

  const avg_word_len = length ? words.reduce((a, w) => a + w.length, 0) / length : 0

  return { length, burstiness, repetition, punctuation_rate, avg_word_len, unique_word_ratio }
}

function heuristicScoreForHighlight(s: ReturnType<typeof computeSignals>) {
  const lowBurst = clamp01(1 - s.burstiness)
  const rep = clamp01(s.repetition / 0.22)
  const lowUnique = clamp01((0.62 - s.unique_word_ratio) / 0.25)
  const punctMid = 1 - clamp01(Math.abs(s.punctuation_rate - 0.03) / 0.03)
  const wordLenMid = 1 - clamp01(Math.abs(s.avg_word_len - 4.7) / 2.0)
  const lengthFactor = clamp01((s.length - 12) / 80)

  const raw = 0.36 * lowBurst + 0.28 * rep + 0.18 * lowUnique + 0.10 * punctMid + 0.08 * wordLenMid
  return clamp01(raw * (0.55 + 0.45 * lengthFactor))
}

function confidenceBadge(conf?: string) {
  if (conf === 'high') return { label: 'High confidence', tone: 'bad' }
  if (conf === 'medium') return { label: 'Medium confidence', tone: 'mid' }
  if (conf === 'low') return { label: 'Low confidence', tone: 'good' }
  return { label: '—', tone: 'neutral' }
}

function scoreTone(score01?: number) {
  const s = typeof score01 === 'number' ? clamp01(score01) : 0
  if (s >= 0.8) return 'bad'
  if (s >= 0.55) return 'mid'
  return 'good'
}

function sampleHuman() {
  return `I planned to clean my desk this morning, but I ended up sorting old notes instead. It’s not dramatic—just a small reminder that attention drifts. I’m going to set a 20-minute timer, finish one task, and then decide what’s worth keeping.`
}
function sampleAIish() {
  return `In today’s rapidly evolving digital landscape, it is essential to recognize that productivity is a multifaceted concept influenced by numerous variables. By implementing structured time-management strategies and maintaining consistent routines, individuals can optimize outcomes and achieve measurable improvements.`
}

function Donut({
  value01,
  label,
  hint,
}: {
  value01: number
  label: string
  hint: string
}) {
  const v = clamp01(value01)
  const r = 38
  const c = 2 * Math.PI * r
  const dash = v * c
  const gap = c - dash

  return (
    <div className="donut" title={hint}>
      <svg viewBox="0 0 100 100" width="92" height="92" aria-label={label}>
        <circle className="donutTrack" cx="50" cy="50" r={r} />
        <circle
          className="donutValue"
          cx="50"
          cy="50"
          r={r}
          strokeDasharray={`${dash} ${gap}`}
        />
      </svg>
      <div className="donutCenter">
        <div className="donutPct">{Math.round(v * 100)}%</div>
        <div className="donutLabel">{label}</div>
      </div>
    </div>
  )
}

async function readFileAsText(file: File): Promise<string> {
  const ext = file.name.toLowerCase().split('.').pop() ?? ''
  if (ext === 'txt' || ext === 'md' || ext === 'rtf' || ext === 'csv') {
    return await file.text()
  }
  if (ext === 'docx') {
    // dynamic import to keep bundle smaller
try {
  const { extractRawText } = await import('mammoth')
  const arrayBuffer = await file.arrayBuffer()
  const result = await extractRawText({ arrayBuffer })
  return (result?.value ?? '').trim()
} catch (err) {
  console.error('DOCX parse failed:', err)
  throw new Error('Unable to read .docx file')
}

  throw new Error('Unsupported file type. Use .txt, .md, or .docx')
}

export default function App() {
  const [text, setText] = useState('')
  const [mode, setMode] = useState<ScanMode>('advanced_ai')

  const [includeBreakdown, setIncludeBreakdown] = useState(true)
  const [highlightSentences, setHighlightSentences] = useState(true)

  const [isCalibrating, setIsCalibrating] = useState(false)
  const [calLabel, setCalLabel] = useState<'human' | 'ai'>('human')

  const [loading, setLoading] = useState(false)
  const [res, setRes] = useState<DetectResponse | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const [theme, setTheme] = useState<Theme>('dark')

  const [history, setHistory] = useState<HistoryItem[]>([])
  const [rightTab, setRightTab] = useState<'scan' | 'history'>('scan')

  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const endpoint = '/api/detect'

  const disabledModes: ScanMode[] = ['plagiarism', 'hallucinations', 'writing_feedback', 'custom']
  const isDisabled = disabledModes.includes(mode)

  const words = useMemo(() => tokenizeWords(text.trim()).length, [text])
  const chars = text.length

  // Theme init
  useEffect(() => {
    const saved = (localStorage.getItem(LS_THEME_KEY) as Theme | null) ?? null
    if (saved === 'dark' || saved === 'light') setTheme(saved)
  }, [])
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem(LS_THEME_KEY, theme)
  }, [theme])

  // History init
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_HISTORY_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as HistoryItem[]
      if (Array.isArray(parsed)) setHistory(parsed.slice(0, 25))
    } catch {
      // ignore
    }
  }, [])
  useEffect(() => {
    localStorage.setItem(LS_HISTORY_KEY, JSON.stringify(history.slice(0, 25)))
  }, [history])

  const sentenceHighlights = useMemo(() => {
    const sents = splitSentences(text)
    const scored = sents.map((s) => {
      const sig = computeSignals(s)
      const score = heuristicScoreForHighlight(sig)
      return { s, score }
    })
    return scored
  }, [text])

  const aiProb = typeof res?.ai_probability === 'number' ? clamp01(res.ai_probability) : undefined
  const badge = confidenceBadge(res?.confidence)

  const zippyScore = res?.signals?.zippy_score ?? res?.signals?.zippyScore
  const detectgptStability = res?.signals?.detectgpt_stability ?? res?.signals?.detectgptStability
  const compressionRatio = res?.signals?.compression_ratio

  function pushHistory(item: HistoryItem) {
    setHistory((prev) => {
      const next = [item, ...prev.filter(p => p.id !== item.id)]
      return next.slice(0, 25)
    })
  }

  async function analyze() {
    setErr(null)
    setRes(null)

    if (isDisabled) {
      setErr('That scan type is coming soon. For now, use Advanced AI Scan.')
      return
    }

    const t = text.trim()
    if (!t) {
      setErr('Paste some text first, or upload a file.')
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

        // Save scan to history (only for detect mode)
        if (!isCalibrating) {
          const item: HistoryItem = {
            id: nowId(),
            ts: Date.now(),
            mode,
            words,
            chars,
            score: typeof data.ai_probability === 'number' ? clamp01(data.ai_probability) : undefined,
            confidence: data.confidence,
            snippet: t.slice(0, 120).replace(/\s+/g, ' ').trim(),
            text: t,
          }
          pushHistory(item)
        }
      }
    } catch (e: any) {
      setErr(e?.message ?? 'Network error.')
    } finally {
      setLoading(false)
    }
  }

  async function handleFile(file: File) {
    setErr(null)
    try {
      const txt = await readFileAsText(file)
      if (!txt) {
        setErr('File had no readable text.')
        return
      }
      setText(txt)
      setRightTab('scan')
    } catch (e: any) {
      setErr(e?.message ?? 'Could not read file.')
    }
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files?.[0]
    if (file) void handleFile(file)
  }

  function clearHistory() {
    setHistory([])
    localStorage.removeItem(LS_HISTORY_KEY)
  }

  return (
    <div
      className={`app ${dragOver ? 'dragOver' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      {dragOver && (
        <div className="dropOverlay" aria-hidden="true">
          <div className="dropCard">
            <div className="dropTitle">Drop a file to import</div>
            <div className="dropSub">Supported: .txt, .md, .docx</div>
          </div>
        </div>
      )}

      <header className="topbar">
        <div className="brand">
          <div className="logo" aria-hidden="true">◎</div>
          <div>
            <div className="brandTitle">AI Text Detector</div>
            <div className="brandSub">GPTZero-style UI • Cloudflare Pages • Multi-signal scoring</div>
          </div>
        </div>

        <div className="topActions">
          <button className="btn ghost" onClick={() => setText(sampleHuman())} type="button">
            Human sample
          </button>
          <button className="btn ghost" onClick={() => setText(sampleAIish())} type="button">
            AI sample
          </button>

          <input
            ref={fileInputRef}
            type="file"
            className="fileInput"
            accept=".txt,.md,.docx,.rtf"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void handleFile(f)
              e.currentTarget.value = ''
            }}
          />
          <button
            className="btn ghost"
            type="button"
            onClick={() => fileInputRef.current?.click()}
            title="Upload .txt / .docx"
          >
            Upload
          </button>

          <button className="btn primary" onClick={analyze} disabled={loading} type="button">
            {loading ? (
              <>
                <span className="spinner" aria-hidden="true" />
                Scanning…
              </>
            ) : (
              <>Scan</>
            )}
          </button>

          <button
            className="btn icon"
            type="button"
            onClick={() => setTheme(t => (t === 'dark' ? 'light' : 'dark'))}
            title="Toggle theme"
          >
            {theme === 'dark' ? '☾' : '☀'}
          </button>
        </div>
      </header>

      <main className="layout">
        {/* LEFT */}
        <section className="mainCol">
          <div className="card editorCard">
            <div className="cardHeader">
              <div>
                <div className="cardTitle">Paste text</div>
                <div className="cardHint">Or drag-drop a file anywhere • Recommended: 40+ words</div>
              </div>
              <div className="meta">
                <span className="pill">{words} words</span>
                <span className="pill">{chars} chars</span>
                <span className="pill subtle">POST {endpoint}</span>
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
                    checked={highlightSentences}
                    onChange={(e) => setHighlightSentences(e.target.checked)}
                  />
                  <span>Highlight sentences</span>
                </label>
              </div>

              <div className="rightFoot">
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={isCalibrating}
                    onChange={(e) => setIsCalibrating(e.target.checked)}
                  />
                  <span>Calibration</span>
                </label>

                {isCalibrating && (
                  <select
                    className="select"
                    value={calLabel}
                    onChange={(e) => setCalLabel(e.target.value as any)}
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

          {/* Sentence highlight preview (inline heatmap) */}
          {highlightSentences && text.trim().length > 0 && (
            <div className="card previewCard">
              <div className="cardHeader">
                <div>
                  <div className="cardTitle">Sentence preview</div>
                  <div className="cardHint">Heatmap uses a fast local heuristic (preview only)</div>
                </div>
                <span className="badge neutral" title="Local preview only">
                  Preview
                </span>
              </div>

              <div className="previewBody">
                {sentenceHighlights.slice(0, 18).map((x, i) => {
                  const tone = scoreTone(x.score)
                  return (
                    <span
                      key={i}
                      className={`sent ${tone}`}
                      title={`Local sentence score: ${Math.round(x.score * 100)}%`}
                    >
                      {x.s}{' '}
                    </span>
                  )
                })}
                {sentenceHighlights.length > 18 && (
                  <div className="smallMuted" style={{ marginTop: 10 }}>
                    Showing first 18 sentences. (Long docs stay fast.)
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Results */}
          {res && !isCalibrating && (
            <div className="card resultsCard">
              <div className="cardHeader">
                <div>
                  <div className="cardTitle">Results</div>
                  <div className="cardHint">Probabilistic score — not a guarantee.</div>
                </div>
                <span className={`badge ${badge.tone}`}>{badge.label}</span>
              </div>

              <div className="resultTop">
                <Donut
                  value01={aiProb ?? 0}
                  label="AI"
                  hint="Overall AI likelihood (ensemble)."
                />

                <div className="resultSummary">
                  <div className="resultScore">
                    <div className="resultScoreLabel">AI likelihood</div>
                    <div className="resultScoreValue">{pct(aiProb)}</div>
                  </div>

                  <div className="scoreBarWrap" aria-label="AI likelihood bar">
                    <div className="scoreBar" title="Overall AI likelihood">
                      <div
                        className="scoreFill"
                        style={{ width: `${Math.round((aiProb ?? 0) * 100)}%` }}
                      />
                    </div>
                    <div className="scoreTicks">
                      <span>0</span><span>25</span><span>50</span><span>75</span><span>100</span>
                    </div>
                  </div>

                  <div className="smallMuted">
                    Tip: run multiple samples. Some writing styles compress very well and can look “AI-ish.”
                  </div>
                </div>
              </div>

              {includeBreakdown && (
                <div className="grid3">
                  <div className="metric" title="ZipPy entropy signal (higher often correlates with AI text)">
                    <div className="metricLabel">ZipPy entropy</div>
                    <div className="metricValue">{pct(typeof zippyScore === 'number' ? zippyScore : undefined)}</div>
                    <div className="metricHint">
                      Compression ratio: <b>{formatNumber(compressionRatio, 3)}</b>
                    </div>
                  </div>

                  <div className="metric" title="DetectGPT-style stability signal (higher = more stable under perturbations)">
                    <div className="metricLabel">DetectGPT-style stability</div>
                    <div className="metricValue">{pct(typeof detectgptStability === 'number' ? detectgptStability : undefined)}</div>
                    <div className="metricHint">Stability under light perturbations</div>
                  </div>

                  <div className="metric" title="More text improves reliability">
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
                    {res.notes.slice(0, 8).map((n, i) => (
                      <li key={i}>{n}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* Calibration output */}
          {res && isCalibrating && (
            <div className="card resultsCard">
              <div className="cardHeader">
                <div>
                  <div className="cardTitle">Calibration output</div>
                  <div className="cardHint">Collect labeled results to tune thresholds.</div>
                </div>
                <span className="badge neutral">Label: {res.label ?? calLabel}</span>
              </div>

              <div className="grid3">
                <div className="metric" title="Structural heuristic signal">
                  <div className="metricLabel">Heuristic</div>
                  <div className="metricValue">{pct(res.scores?.heuristic)}</div>
                  <div className="metricHint">Baseline structural signal</div>
                </div>

                <div className="metric" title="Compression entropy signal">
                  <div className="metricLabel">ZipPy</div>
                  <div className="metricValue">{pct(res.scores?.zippy)}</div>
                  <div className="metricHint">Compression entropy</div>
                </div>

                <div className="metric" title="Perturbation stability signal">
                  <div className="metricLabel">DetectGPT</div>
                  <div className="metricValue">{pct(res.scores?.detectgpt)}</div>
                  <div className="metricHint">Stability under perturbations</div>
                </div>
              </div>

              <div className="calRow">
                <div className="metric wide">
                  <div className="metricLabel">Ensemble</div>
                  <div className="metricValue">{pct(res.scores?.ensemble)}</div>
                  <div className="metricHint">Export these (human vs ai) to tune cutoffs.</div>
                </div>
                <button
                  className="btn ghost"
                  type="button"
                  onClick={() => navigator.clipboard.writeText(JSON.stringify(res, null, 2))}
                  title="Copy full calibration JSON"
                >
                  Copy JSON
                </button>
              </div>
            </div>
          )}
        </section>

        {/* RIGHT */}
        <aside className="sideCol">
          <div className="card sideCard">
            <div className="sideTabs">
              <button
                className={`tabBtn ${rightTab === 'scan' ? 'active' : ''}`}
                type="button"
                onClick={() => setRightTab('scan')}
              >
                Scan types
              </button>
              <button
                className={`tabBtn ${rightTab === 'history' ? 'active' : ''}`}
                type="button"
                onClick={() => setRightTab('history')}
              >
                History
                {history.length > 0 && <span className="tabPill">{history.length}</span>}
              </button>
            </div>

            {rightTab === 'scan' && (
              <>
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
                    Usability tip: If you’re testing content, compare multiple drafts, not just one paragraph.
                  </div>
                </div>
              </>
            )}

            {rightTab === 'history' && (
              <>
                <div className="sideHeader">
                  <div className="sideTitle">Recent scans</div>
                  <div className="sideSub">Stored locally in your browser.</div>
                </div>

                <div className="historyTools">
                  <button className="btn ghost small" type="button" onClick={clearHistory} disabled={history.length === 0}>
                    Clear
                  </button>
                </div>

                <div className="historyList">
                  {history.length === 0 && (
                    <div className="empty">
                      <div className="emptyTitle">No history yet</div>
                      <div className="smallMuted">Run a scan and it’ll show up here.</div>
                    </div>
                  )}

                  {history.map((h) => {
                    const tone = scoreTone(h.score)
                    return (
                      <button
                        key={h.id}
                        className={`historyItem ${tone}`}
                        type="button"
                        onClick={() => {
                          setText(h.text)
                          setRightTab('scan')
                          setRes(null)
                          setErr(null)
                        }}
                        title="Load this scan text"
                      >
                        <div className="historyTop">
                          <div className="historyScore">
                            {typeof h.score === 'number' ? `${Math.round(h.score * 100)}%` : '—'}
                          </div>
                          <div className="historyMeta">
                            <span>{new Date(h.ts).toLocaleString()}</span>
                            <span>•</span>
                            <span>{h.words} words</span>
                          </div>
                        </div>
                        <div className="historySnippet">{h.snippet || '(no snippet)'}</div>
                        <div className="historyBottom">
                          <span className="miniPill">{h.mode}</span>
                          <span className="miniPill">{h.confidence ?? '—'}</span>
                        </div>
                      </button>
                    )
                  })}
                </div>
              </>
            )}
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
                <div><b>ZipPy entropy:</b> gzip compressibility ratio.</div>
              </div>
              <div className="bullet">
                <div className="dot" />
                <div><b>DetectGPT-style:</b> stability under perturbations.</div>
              </div>
            </div>

            <div className="sideFooter">
              <div className="smallMuted">
                Tooltips are built-in: hover over cards/metrics for explanation.
              </div>
            </div>
          </div>
        </aside>
      </main>

      <footer className="footer">
        <div className="smallMuted">
          Drag-drop supported • History stored locally • Theme saved • Built for Cloudflare Pages Functions
        </div>
      </footer>
    </div>
  )
} 
