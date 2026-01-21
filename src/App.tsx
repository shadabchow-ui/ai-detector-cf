import React, { useEffect, useMemo, useRef, useState } from 'react'

type ScanKind = 'fast' | 'strict' | 'lite' | 'hybrid' | 'signals'
type Verdict = 'good' | 'mid' | 'bad' | 'neutral'

type ScanResult = {
  score: number // 0..100
  label: Verdict
  words: number
  chars: number
  sentences: number
  avgSentenceLen: number
  burstiness: number
  notes: string[]
  signals: {
    repetition: number
    functionWordRatio: number
    punctuationRatio: number
    avgWordLen: number
    uniqueWordRatio: number
  }
}

type HistoryItem = {
  id: string
  ts: number
  kind: ScanKind
  text: string
  result: ScanResult
}

const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n))

function nowId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function countWords(text: string) {
  const m = text.trim().match(/\S+/g)
  return m ? m.length : 0
}

function splitSentences(text: string) {
  const cleaned = text
    .replace(/\s+/g, ' ')
    .replace(/([!?])+/g, '$1')
    .trim()
  if (!cleaned) return []
  // Basic sentence splitting; not perfect, good enough for a heuristic tool
  return cleaned
    .split(/(?<=[.?!])\s+(?=[A-Z0-9“"'])/g)
    .map((s) => s.trim())
    .filter(Boolean)
}

function tokenizeWords(text: string) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'-]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
}

function uniqueRatio(words: string[]) {
  if (!words.length) return 0
  return new Set(words).size / words.length
}

function avgWordLen(words: string[]) {
  if (!words.length) return 0
  const sum = words.reduce((a, w) => a + w.length, 0)
  return sum / words.length
}

function punctuationRatio(text: string) {
  if (!text.length) return 0
  const punct = (text.match(/[.,!?;:()\[\]"“”'’—-]/g) || []).length
  return punct / text.length
}

function functionWordRatio(words: string[]) {
  if (!words.length) return 0
  const fn = new Set([
    'the','a','an','and','or','but','if','then','else','when','while','to','of','in','on','at','for','from','with','without',
    'as','by','is','are','was','were','be','been','being','it','this','that','these','those','i','you','we','they','he','she',
    'them','him','her','my','your','our','their','not','no','yes','do','does','did','can','could','would','should','may','might',
    'will','just','also','so','because','than','too','very'
  ])
  const count = words.reduce((a, w) => a + (fn.has(w) ? 1 : 0), 0)
  return count / words.length
}

function repetitionScore(words: string[]) {
  if (words.length < 10) return 0
  const freq = new Map<string, number>()
  for (const w of words) freq.set(w, (freq.get(w) || 0) + 1)
  const top = [...freq.values()].sort((a, b) => b - a).slice(0, 10)
  const topSum = top.reduce((a, n) => a + n, 0)
  return topSum / words.length // higher => more repetitive
}

function stdDev(nums: number[]) {
  if (!nums.length) return 0
  const mean = nums.reduce((a, n) => a + n, 0) / nums.length
  const varr = nums.reduce((a, n) => a + (n - mean) ** 2, 0) / nums.length
  return Math.sqrt(varr)
}

function burstinessFromSentences(sentences: string[]) {
  if (sentences.length < 2) return 0
  const lens = sentences.map((s) => countWords(s))
  return stdDev(lens)
}

function verdictFromScore(score: number): Verdict {
  if (score >= 70) return 'bad'
  if (score >= 45) return 'mid'
  if (score >= 0) return 'good'
  return 'neutral'
}

function analyzeText(text: string, kind: ScanKind): ScanResult {
  const chars = text.length
  const wordsArr = tokenizeWords(text)
  const words = wordsArr.length
  const sentencesArr = splitSentences(text)
  const sentences = sentencesArr.length
  const sentLens = sentencesArr.map((s) => countWords(s))
  const avgSentenceLen = sentLens.length ? sentLens.reduce((a, n) => a + n, 0) / sentLens.length : 0
  const burstiness = burstinessFromSentences(sentencesArr)

  const rep = repetitionScore(wordsArr)
  const uniq = uniqueRatio(wordsArr)
  const avgWL = avgWordLen(wordsArr)
  const punc = punctuationRatio(text)
  const fnr = functionWordRatio(wordsArr)

  // Heuristic scoring (not a guarantee)
  // Tune weights per mode
  const weights = (() => {
    switch (kind) {
      case 'lite':
        return { rep: 28, uniq: -18, fnr: 10, avgWL: -6, punc: -8, burst: -6 }
      case 'strict':
        return { rep: 32, uniq: -22, fnr: 12, avgWL: -8, punc: -10, burst: -10 }
      case 'hybrid':
        return { rep: 30, uniq: -20, fnr: 11, avgWL: -7, punc: -9, burst: -9 }
      case 'signals':
        return { rep: 26, uniq: -16, fnr: 8, avgWL: -6, punc: -8, burst: -6 }
      case 'fast':
      default:
        return { rep: 26, uniq: -16, fnr: 8, avgWL: -6, punc: -8, burst: -6 }
    }
  })()

  // Normalize signals to roughly comparable ranges
  const repN = clamp(rep, 0, 0.6) / 0.6
  const uniqN = clamp(uniq, 0.2, 0.85)
  const fnrN = clamp(fnr, 0.2, 0.7)
  const avgWLN = clamp(avgWL, 3.5, 6.2)
  const puncN = clamp(punc, 0.01, 0.08)
  const burstN = clamp(burstiness, 0.0, 6.0) / 6.0

  let score =
    45 +
    weights.rep * repN +
    weights.uniq * (1 - (uniqN - 0.2) / (0.85 - 0.2)) +
    weights.fnr * (fnrN - 0.2) / (0.7 - 0.2) +
    weights.avgWL * (avgWLN - 3.5) / (6.2 - 3.5) +
    weights.punc * (puncN - 0.01) / (0.08 - 0.01) +
    weights.burst * (1 - burstN)

  // Penalize too-short samples
  if (words < 40) score += 18
  if (words < 20) score += 22

  score = clamp(score, 0, 100)
  const label = verdictFromScore(score)

  const notes: string[] = []
  if (words < 40) notes.push('Sample is short — results are less reliable. Aim for 40+ words.')
  if (rep > 0.28) notes.push('High repetition in top terms.')
  if (uniq < 0.45) notes.push('Low vocabulary diversity.')
  if (burstiness < 1.2) notes.push('Low burstiness (sentence lengths feel uniform).')
  if (fnr > 0.55) notes.push('High function-word ratio (common in templated writing).')

  return {
    score,
    label,
    words,
    chars,
    sentences,
    avgSentenceLen,
    burstiness,
    notes,
    signals: {
      repetition: rep,
      functionWordRatio: fnr,
      punctuationRatio: punc,
      avgWordLen: avgWL,
      uniqueWordRatio: uniq,
    },
  }
}

async function readFileAsText(file: File): Promise<string> {
  const name = file.name || ''
  const ext = name.split('.').pop()?.toLowerCase()

  // Plain text / markdown
  if (ext === 'txt' || ext === 'md' || ext === 'csv') {
    return (await file.text()).trim()
  }

  // DOCX (client-side)
  if (ext === 'docx') {
    try {
      const mammothMod: any = await import('mammoth')
      const extractRawText =
        mammothMod?.extractRawText ??
        mammothMod?.default?.extractRawText ??
        mammothMod?.default ??
        null

      if (typeof extractRawText !== 'function') {
        throw new Error('mammoth extractRawText not available')
      }

      const arrayBuffer = await file.arrayBuffer()
      const result = await extractRawText({ arrayBuffer })
      return String(result?.value ?? '').trim()
    } catch (e) {
      console.error('DOCX parse failed', e)
      throw new Error('Could not read .docx. Please export as .txt or paste the text.')
    }
  }

  throw new Error('Unsupported file type. Please upload .txt/.md/.csv or .docx.')
}

function badgeClass(label: Verdict) {
  if (label === 'good') return 'badge good'
  if (label === 'mid') return 'badge mid'
  if (label === 'bad') return 'badge bad'
  return 'badge neutral'
}

function scanLabel(label: Verdict) {
  if (label === 'good') return 'Likely Human'
  if (label === 'mid') return 'Mixed / Unclear'
  if (label === 'bad') return 'Likely AI'
  return '—'
}

function formatPct(n: number) {
  return `${Math.round(n)}%`
}

function useLocalStorage<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw ? (JSON.parse(raw) as T) : initial
    } catch {
      return initial
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch {}
  }, [key, value])
  return [value, setValue] as const
}

function Donut({ value }: { value: number }) {
  const r = 36
  const c = 2 * Math.PI * r
  const pct = clamp(value, 0, 100) / 100
  const dash = `${c * pct} ${c * (1 - pct)}`
  return (
    <div className="donut" aria-label={`Score ${Math.round(value)} out of 100`}>
      <svg viewBox="0 0 100 100">
        <circle className="donutTrack" cx="50" cy="50" r={r} />
        <circle className="donutValue" cx="50" cy="50" r={r} strokeDasharray={dash} />
      </svg>
      <div className="donutCenter">
        <div className="donutPct">{Math.round(value)}</div>
        <div className="donutLabel">score</div>
      </div>
    </div>
  )
}

export default function App() {
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [theme, setTheme] = useLocalStorage<'dark' | 'light'>('aid_theme', 'dark')
  const [kind, setKind] = useLocalStorage<ScanKind>('aid_kind', 'fast')
  const [text, setText] = useLocalStorage<string>('aid_text', '')
  const [autoTrim, setAutoTrim] = useLocalStorage<boolean>('aid_trim', true)

  const [result, setResult] = useState<ScanResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [history, setHistory] = useLocalStorage<HistoryItem[]>('aid_history', [])
  const [activeTab, setActiveTab] = useState<'scans' | 'history'>('scans')
  const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(null)

  const words = useMemo(() => countWords(text), [text])
  const chars = useMemo(() => text.length, [text])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  const doAnalyze = async (input?: string) => {
    setBusy(true)
    setError(null)
    try {
      const raw = typeof input === 'string' ? input : text
      const t = autoTrim ? raw.trim() : raw
      const r = analyzeText(t, kind)
      setResult(r)
      const item: HistoryItem = {
        id: nowId(),
        ts: Date.now(),
        kind,
        text: t,
        result: r,
      }
      setHistory([item, ...history].slice(0, 25))
      setSelectedHistoryId(item.id)
      setActiveTab('history')
    } catch (e: any) {
      setError(e?.message || 'Something went wrong.')
    } finally {
      setBusy(false)
    }
  }

  const loadSample = () => {
    const sample =
      `I rewrote the page copy twice, then realized the issue wasn’t the copy at all — it was the build.\n` +
      `The CSS bundle never changed because I was editing a file that Vite wasn’t importing.\n` +
      `Once the import path matched the actual file location, the deployment picked it up immediately.`
    setText(sample)
    setResult(null)
    setError(null)
    setActiveTab('scans')
  }

  const onPickFile = async (file: File | null) => {
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      const content = await readFileAsText(file)
      setText(content)
      setResult(null)
      setActiveTab('scans')
    } catch (e: any) {
      setError(e?.message || 'Could not read file.')
    } finally {
      setBusy(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const clearHistory = () => {
    setHistory([])
    setSelectedHistoryId(null)
  }

  const selectedHistory = useMemo(() => {
    if (!selectedHistoryId) return null
    return history.find((h) => h.id === selectedHistoryId) || null
  }, [history, selectedHistoryId])

  const previewSentences = useMemo(() => {
    const source = (result ? (selectedHistory?.text ?? text) : text).trim()
    const sents = splitSentences(source)
    if (!sents.length) return []
    const scored = sents.map((s) => {
      const r = analyzeText(s, kind)
      return { s, label: r.label }
    })
    return scored.slice(0, 24)
  }, [text, result, kind, selectedHistory])

  return (
    <div className="app">
      <input
        ref={fileInputRef}
        className="fileInput"
        type="file"
        accept=".txt,.md,.csv,.docx"
        onChange={(e) => onPickFile(e.target.files?.[0] ?? null)}
      />

      <div className="topbar">
        <div className="brand">
          <div className="logo">AI</div>
          <div>
            <div className="brandTitle">AI Text Detector (Cloudflare Pages)</div>
            <div className="brandSub">Open-source, edge-safe. Probabilistic score (not a guarantee).</div>
          </div>
        </div>

        <div className="topActions">
          <button className="btn ghost" onClick={loadSample} disabled={busy}>
            Sample
          </button>
          <button className="btn primary" onClick={() => doAnalyze()} disabled={busy || words === 0}>
            {busy ? (
              <>
                <span className="spinner" /> Analyzing…
              </>
            ) : (
              'Analyze'
            )}
          </button>
          <button className="btn" onClick={() => fileInputRef.current?.click()} disabled={busy}>
            Upload
          </button>
          <button className="btn icon" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} title="Toggle theme">
            {theme === 'dark' ? '☀' : '☾'}
          </button>
        </div>
      </div>

      <div className="layout">
        <div>
          <div className="card">
            <div className="cardHeader">
              <div>
                <div className="cardTitle">Text</div>
                <div className="cardHint">Paste text below (40+ words recommended).</div>
              </div>
              <div className="meta">
                <span className="pill">{words} words</span>
                <span className="pill">{chars} chars</span>
                <span className="pill subtle">Mode: {kind}</span>
              </div>
            </div>

            <div className="editorWrap">
              <textarea
                className="textarea"
                value={text}
                onChange={(e) => {
                  setText(e.target.value)
                  setResult(null)
                  setError(null)
                }}
                placeholder="Paste text here (40+ words recommended)…"
              />
              {error && (
                <div className="alert bad">
                  <div className="alertTitle">Error</div>
                  <div className="alertBody">{error}</div>
                </div>
              )}
            </div>

            <div className="editorFooter">
              <div className="leftFoot">
                <label className="toggle">
                  <input type="checkbox" checked={autoTrim} onChange={(e) => setAutoTrim(e.target.checked)} />
                  Auto-trim
                </label>

                <select className="select" value={kind} onChange={(e) => setKind(e.target.value as ScanKind)}>
                  <option value="fast">Fast</option>
                  <option value="strict">Strict</option>
                  <option value="lite">Lite</option>
                  <option value="hybrid">Hybrid</option>
                  <option value="signals">Signals</option>
                </select>

                <span className="badge neutral">Endpoint: <code>POST /api/detect</code></span>
              </div>

              <div className="rightFoot">
                <button className="btn small" onClick={() => setText('')} disabled={busy || !text}>
                  Clear
                </button>
                <button className="btn small" onClick={() => doAnalyze()} disabled={busy || words === 0}>
                  Run scan
                </button>
              </div>
            </div>
          </div>

          {result && (
            <div className="card resultsCard">
              <div className="cardHeader">
                <div>
                  <div className="cardTitle">Results</div>
                  <div className="cardHint">Heuristic signals only. Use as a quick indicator, not proof.</div>
                </div>
                <div className="meta">
                  <span className={badgeClass(result.label)}>{scanLabel(result.label)}</span>
                </div>
              </div>

              <div className="resultTop">
                <Donut value={result.score} />
                <div className="resultSummary">
                  <div>
                    <div className="resultScoreLabel">AI-likeness score</div>
                    <div className="resultScoreValue">{Math.round(result.score)}</div>
                  </div>

                  <div className="scoreBarWrap">
                    <div className="scoreBar" role="progressbar" aria-valuenow={result.score} aria-valuemin={0} aria-valuemax={100}>
                      <div className="scoreFill" style={{ width: `${Math.round(result.score)}%` }} />
                    </div>
                    <div className="scoreTicks">
                      <span>Human</span>
                      <span>Mixed</span>
                      <span>AI</span>
                    </div>
                  </div>
                </div>
              </div>

              <div className="grid3">
                <div className="metric">
                  <div className="metricLabel">Sentences</div>
                  <div className="metricValue">{result.sentences}</div>
                  <div className="metricHint">Avg sentence: {result.avgSentenceLen.toFixed(1)} words</div>
                </div>
                <div className="metric">
                  <div className="metricLabel">Burstiness</div>
                  <div className="metricValue">{result.burstiness.toFixed(2)}</div>
                  <div className="metricHint">Lower can feel more templated</div>
                </div>
                <div className="metric">
                  <div className="metricLabel">Vocabulary</div>
                  <div className="metricValue">{formatPct(result.signals.uniqueWordRatio * 100)}</div>
                  <div className="metricHint">Unique word ratio</div>
                </div>

                <div className="metric wide">
                  <div className="metricLabel">Signals</div>
                  <div className="metricValue" style={{ fontSize: 16, fontWeight: 800 }}>
                    Repetition: {formatPct(result.signals.repetition * 100)} · Function words: {formatPct(result.signals.functionWordRatio * 100)} ·
                    Punctuation: {formatPct(result.signals.punctuationRatio * 100)} · Avg word len: {result.signals.avgWordLen.toFixed(2)}
                  </div>
                  <div className="metricHint">These are lightweight, edge-friendly heuristics.</div>
                </div>
              </div>

              <div className="notes">
                <div className="notesTitle">Notes</div>
                <ul>
                  {(result.notes.length ? result.notes : ['No strong red flags detected in this sample.']).map((n, i) => (
                    <li key={i}>{n}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          <div className="card previewCard">
            <div className="cardHeader">
              <div>
                <div className="cardTitle">Preview</div>
                <div className="cardHint">Sentence-level “heat” preview (rough).</div>
              </div>
            </div>
            <div className="previewBody">
              {previewSentences.length ? (
                previewSentences.map((x, i) => (
                  <span key={i} className={`sent ${x.label}`}>
                    {x.s}{' '}
                  </span>
                ))
              ) : (
                <div className="smallMuted">Run a scan to see sentence highlights.</div>
              )}
            </div>
          </div>
        </div>

        <div>
          <div className="card sideCard">
            <div className="sideHeader">
              <div className="sideTitle">Tools</div>
              <div className="sideSub">Recent scans and quick tips.</div>
            </div>

            <div className="sideTabs">
              <button className={`tabBtn ${activeTab === 'scans' ? 'active' : ''}`} onClick={() => setActiveTab('scans')}>
                Scans <span className="tabPill">{history.length}</span>
              </button>
              <button className={`tabBtn ${activeTab === 'history' ? 'active' : ''}`} onClick={() => setActiveTab('history')}>
                History
              </button>
            </div>

            {activeTab === 'scans' ? (
              <>
                <div className="bullets">
                  <div className="bullet">
                    <div className="dot" />
                    <div>Use <b>40+ words</b>. Short samples spike false positives.</div>
                  </div>
                  <div className="bullet">
                    <div className="dot" />
                    <div>“Likely AI” is <b>not proof</b> — verify with context and sources.</div>
                  </div>
                  <div className="bullet">
                    <div className="dot" />
                    <div>If CSS isn’t changing, verify you’re importing the <b>right file path</b>.</div>
                  </div>
                </div>
                <div className="sideFooter">
                  <div className="smallMuted">
                    This starter uses lightweight statistical signals to stay Edge-compatible. If you want stronger detection, we can add a second-pass method
                    (DetectGPT-style) later.
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="historyTools">
                  <button className="btn small" onClick={clearHistory} disabled={!history.length}>
                    Clear history
                  </button>
                </div>
                <div className="historyList">
                  {history.length ? (
                    history.map((h) => (
                      <button
                        key={h.id}
                        className={`historyItem ${h.result.label}`}
                        onClick={() => {
                          setSelectedHistoryId(h.id)
                          setText(h.text)
                          setResult(h.result)
                        }}
                      >
                        <div className="historyTop">
                          <div className="historyScore">{Math.round(h.result.score)}</div>
                          <div className="historyMeta">
                            <span>{new Date(h.ts).toLocaleString()}</span>
                            <span>•</span>
                            <span>{h.kind}</span>
                          </div>
                        </div>
                        <div className="historySnippet">{h.text.slice(0, 140)}{h.text.length > 140 ? '…' : ''}</div>
                        <div className="historyBottom">
                          <span className="miniPill">{scanLabel(h.result.label)}</span>
                          <span className="miniPill">{h.result.words} words</span>
                          <span className="miniPill">{h.result.sentences} sentences</span>
                        </div>
                      </button>
                    ))
                  ) : (
                    <div className="empty">
                      <div className="emptyTitle">No scans yet.</div>
                      <div className="smallMuted">Run Analyze to save results here.</div>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          {selectedHistory && (
            <div className="footer">
              <span className={badgeClass(selectedHistory.result.label)}>
                Selected: {scanLabel(selectedHistory.result.label)} ({Math.round(selectedHistory.result.score)})
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
