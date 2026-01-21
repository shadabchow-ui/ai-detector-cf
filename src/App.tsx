import React, { useEffect, useMemo, useRef, useState } from 'react'

type DetectResponse = {
  score: number // 0..1
  verdict: 'likely_human' | 'uncertain' | 'likely_ai'
  signals: Record<string, number>
  notes?: string[]
}

type HistoryItem = {
  id: string
  ts: number
  source: 'paste' | 'file'
  filename?: string
  wordCount: number
  score: number
  verdict: DetectResponse['verdict']
  excerpt: string
}

const MAX_INPUT_CHARS = 50_000

const formatPct = (v: number) => `${Math.round(v * 100)}%`

const clamp01 = (x: number) => Math.max(0, Math.min(1, x))

const uid = () => Math.random().toString(16).slice(2) + Date.now().toString(16)

const countWords = (text: string) => {
  const t = text.trim()
  if (!t) return 0
  return t.split(/\s+/).filter(Boolean).length
}

const safeExcerpt = (text: string, n = 180) => {
  const t = text.trim().replace(/\s+/g, ' ')
  return t.length <= n ? t : t.slice(0, n - 1) + '…'
}

async function readFileAsText(file: File): Promise<string> {
  const lower = file.name.toLowerCase()

  // Plain text / markdown
  if (
    lower.endsWith('.txt') ||
    lower.endsWith('.md') ||
    lower.endsWith('.csv') ||
    lower.endsWith('.json')
  ) {
    return await file.text()
  }

  // DOCX (client-side) via mammoth
  if (lower.endsWith('.docx')) {
    // mammoth is CommonJS-ish; handle both default and named export shapes
    const mammothMod: any = await import('mammoth')
    const mammoth: any = mammothMod?.default ?? mammothMod

    const arrayBuffer = await file.arrayBuffer()
    const result = await mammoth.extractRawText({ arrayBuffer })
    return (result?.value ?? '').trim()
  }

  throw new Error('Unsupported file type. Please upload .txt, .md, .docx, .csv, or .json.')
}

function VerdictPill({ verdict }: { verdict: DetectResponse['verdict'] }) {
  const map: Record<DetectResponse['verdict'], { label: string; cls: string }> = {
    likely_human: { label: 'Likely Human', cls: 'pill good' },
    uncertain: { label: 'Uncertain', cls: 'pill mid' },
    likely_ai: { label: 'Likely AI', cls: 'pill bad' },
  }
  const v = map[verdict]
  return <span className={v.cls}>{v.label}</span>
}

function ScoreBar({ score }: { score: number }) {
  const s = clamp01(score)
  return (
    <div className="scoreBar">
      <div className="scoreFill" style={{ width: `${Math.round(s * 100)}%` }} />
      <div className="scoreLabel">{formatPct(s)}</div>
    </div>
  )
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="miniStat">
      <div className="miniStatLabel">{label}</div>
      <div className="miniStatValue">{value}</div>
    </div>
  )
}

function SignalRow({ k, v }: { k: string; v: number }) {
  const pct = clamp01(v)
  return (
    <div className="signalRow">
      <div className="signalKey">{k}</div>
      <div className="signalTrack">
        <div className="signalFill" style={{ width: `${Math.round(pct * 100)}%` }} />
      </div>
      <div className="signalVal">{formatPct(pct)}</div>
    </div>
  )
}

function useLocalStorageState<T>(key: string, init: T) {
  const [val, setVal] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw ? (JSON.parse(raw) as T) : init
    } catch {
      return init
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(val))
    } catch {
      // ignore
    }
  }, [key, val])

  return [val, setVal] as const
}

export default function App() {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<DetectResponse | null>(null)

  const [history, setHistory] = useLocalStorageState<HistoryItem[]>('aidet_hist', [])

  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const words = useMemo(() => countWords(text), [text])
  const chars = useMemo(() => text.length, [text])

  const endpointLabel = 'POST /api/detect'

  const addHistory = (item: Omit<HistoryItem, 'id'>) => {
    const full: HistoryItem = { id: uid(), ...item }
    setHistory((h) => [full, ...h].slice(0, 30))
  }

  const clearHistory = () => setHistory([])

  const onSample = () => {
    setError(null)
    setResult(null)
    setText(
      [
        'I woke up early and rewrote the intro three times until it sounded like me.',
        'The argument is simple: small habits compound when you remove friction, not when you add willpower.',
        'If you want a quick win, pick one cue in your day and attach a two-minute action to it.',
        '',
        'That’s it. Consistency beats intensity.',
      ].join('\n')
    )
  }

  const onPickFile = () => {
    setError(null)
    fileInputRef.current?.click()
  }

  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) return
    e.target.value = ''

    try {
      setBusy(true)
      setError(null)
      setResult(null)

      const content = await readFileAsText(f)
      const trimmed = content.slice(0, MAX_INPUT_CHARS)

      setText(trimmed)

      // Auto-run after load if there's enough text
      if (countWords(trimmed) >= 5) {
        await runDetect(trimmed, { source: 'file', filename: f.name })
      }
    } catch (err: any) {
      setError(err?.message ?? 'Failed to read file.')
    } finally {
      setBusy(false)
    }
  }

  const runDetect = async (
    payloadText?: string,
    meta?: { source?: HistoryItem['source']; filename?: string }
  ) => {
    const bodyText = (payloadText ?? text).trim()

    if (bodyText.length === 0) {
      setError('Paste some text first.')
      return
    }
    if (bodyText.length > MAX_INPUT_CHARS) {
      setError(`Text too long. Max ${MAX_INPUT_CHARS.toLocaleString()} characters.`)
      return
    }

    setBusy(true)
    setError(null)
    setResult(null)

    try {
      const res = await fetch('/api/detect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: bodyText }),
      })

      if (!res.ok) {
        const t = await res.text()
        throw new Error(t || `Request failed (${res.status})`)
      }

      const data = (await res.json()) as DetectResponse
      setResult(data)

      addHistory({
        ts: Date.now(),
        source: meta?.source ?? 'paste',
        filename: meta?.filename,
        wordCount: countWords(bodyText),
        score: clamp01(data.score),
        verdict: data.verdict,
        excerpt: safeExcerpt(bodyText),
      })
    } catch (err: any) {
      setError(err?.message ?? 'Failed to analyze.')
    } finally {
      setBusy(false)
    }
  }

  const onAnalyze = () => runDetect(text, { source: 'paste' })

  const onReset = () => {
    setText('')
    setResult(null)
    setError(null)
  }

  return (
    <div className="appShell">
      <header className="topBar">
        <div className="brand">
          <div className="brandTitle">AI Text Detector (Cloudflare Pages)</div>
          <div className="brandSub">Open-source, edge-safe. Probabilistic score (not a guarantee).</div>
        </div>

        <div className="topActions">
          <button className="btn ghost" onClick={onSample} disabled={busy}>
            Sample
          </button>
          <button className="btn" onClick={onAnalyze} disabled={busy}>
            {busy ? 'Analyzing…' : 'Analyze'}
          </button>
        </div>
      </header>

      <main className="mainGrid">
        <section className="card mainCard">
          <div className="cardHeader">
            <div className="cardTitle">Text</div>
            <div className="cardTools">
              <button className="btn ghost small" onClick={onPickFile} disabled={busy}>
                Upload (.txt/.md/.docx)
              </button>
              <button className="btn ghost small" onClick={onReset} disabled={busy}>
                Clear
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".txt,.md,.docx,.csv,.json"
                onChange={onFileChange}
                style={{ display: 'none' }}
              />
            </div>
          </div>

          <textarea
            className="textArea"
            value={text}
            onChange={(e) => {
              const v = e.target.value
              if (v.length <= MAX_INPUT_CHARS) setText(v)
            }}
            placeholder="Paste text here (40+ words recommended)…"
            spellCheck={false}
          />

          <div className="textMeta">
            <div className="metaLeft">
              <span>{words.toLocaleString()} words</span>
              <span className="dot">•</span>
              <span>{chars.toLocaleString()} chars</span>
            </div>
            <div className="metaRight">
              <span className="muted">Endpoint:</span> <code>{endpointLabel}</code>
            </div>
          </div>

          {error && (
            <div className="alert bad">
              <div className="alertTitle">Error</div>
              <div className="alertBody">{error}</div>
            </div>
          )}

          {!error && !result && (
            <div className="hint">
              This starter uses lightweight statistical signals to stay Edge-compatible. If you want
              stronger detection, we can add a second-pass method (DetectGPT-style) later.
            </div>
          )}
        </section>

        <aside className="side">
          <section className="card sideCard">
            <div className="cardHeader">
              <div className="cardTitle">Result</div>
            </div>

            {!result && (
              <div className="emptyState">
                <div className="emptyTitle">No result yet</div>
                <div className="emptySub">Paste text and click Analyze.</div>
              </div>
            )}

            {result && (
              <>
                <div className="resultTop">
                  <VerdictPill verdict={result.verdict} />
                  <div className="resultScore">
                    <div className="resultScoreLabel">AI likelihood</div>
                    <ScoreBar score={result.score} />
                  </div>
                </div>

                <div className="grid3">
                  <MiniStat label="Score" value={formatPct(result.score)} />
                  <MiniStat label="Words" value={words.toLocaleString()} />
                  <MiniStat label="Signals" value={Object.keys(result.signals ?? {}).length.toString()} />
                </div>

                <div className="divider" />

                <div className="signals">
                  <div className="sectionTitle">Signals</div>
                  <div className="signalsList">
                    {Object.entries(result.signals ?? {})
                      .sort((a, b) => b[1] - a[1])
                      .map(([k, v]) => (
                        <SignalRow key={k} k={k} v={v} />
                      ))}
                  </div>
                </div>

                {result.notes?.length ? (
                  <>
                    <div className="divider" />
                    <div className="notes">
                      <div className="sectionTitle">Notes</div>
                      <ul className="notesList">
                        {result.notes.map((n, i) => (
                          <li key={i}>{n}</li>
                        ))}
                      </ul>
                    </div>
                  </>
                ) : null}
              </>
            )}
          </section>

          <section className="card sideCard">
            <div className="cardHeader">
              <div className="cardTitle">History</div>
              <div className="cardTools">
                <button className="btn ghost small" onClick={clearHistory} disabled={!history.length}>
                  Clear
                </button>
              </div>
            </div>

            {!history.length ? (
              <div className="emptyState">
                <div className="emptyTitle">No history</div>
                <div className="emptySub">Your last analyses will appear here.</div>
              </div>
            ) : (
              <div className="historyList">
                {history.map((h) => (
                  <button
                    key={h.id}
                    className="historyItem"
                    onClick={() => {
                      setText(h.excerpt)
                      setResult({
                        score: h.score,
                        verdict: h.verdict,
                        signals: {},
                        notes: [],
                      })
                      setError(null)
                    }}
                  >
                    <div className="historyTop">
                      <div className="historyVerdict">
                        <span className={`dotPill ${h.verdict}`} />
                        <span className="historyVerdictLabel">{h.verdict.replace('_', ' ')}</span>
                      </div>
                      <div className="historyScore">{formatPct(h.score)}</div>
                    </div>
                    <div className="historyMeta">
                      <span>{new Date(h.ts).toLocaleString()}</span>
                      <span className="dot">•</span>
                      <span>{h.wordCount}w</span>
                      {h.source === 'file' && h.filename ? (
                        <>
                          <span className="dot">•</span>
                          <span className="mono">{h.filename}</span>
                        </>
                      ) : null}
                    </div>
                    <div className="historyExcerpt">{h.excerpt}</div>
                  </button>
                ))}
              </div>
            )}
          </section>
        </aside>
      </main>

      <footer className="footer">
        <div className="footerInner">
          <span className="muted">
            Tip: For best signal quality, use 80+ words and avoid super-short fragments.
          </span>
        </div>
      </footer>
    </div>
  )
}
