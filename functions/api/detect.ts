export interface Env {}

type DetectRequest = { text?: string }

function json(data: any, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      ...extraHeaders,
    },
  })
}

function clamp01(n: number) {
  return Math.max(0, Math.min(1, n))
}

function tokenizeWords(text: string): string[] {
  const m = text.toLowerCase().match(/\b[\p{L}\p{N}'-]+\b/gu)
  return m ?? []
}

function splitSentences(text: string): string[] {
  // Simple sentence splitter (edge-safe)
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function stddev(nums: number[]): number {
  if (nums.length <= 1) return 0
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length
  const v = nums.reduce((a, b) => a + (b - mean) ** 2, 0) / (nums.length - 1)
  return Math.sqrt(v)
}

function computeSignals(text: string) {
  const words = tokenizeWords(text)
  const length = words.length

  const sentences = splitSentences(text)
  const sentenceLens = sentences.map((s) => tokenizeWords(s).length).filter((n) => n > 0)

  const burstiness = sentenceLens.length ? clamp01(stddev(sentenceLens) / (sentenceLens.reduce((a,b)=>a+b,0)/sentenceLens.length + 1e-6)) : 0

  const uniq = new Set(words)
  const unique_word_ratio = length ? clamp01(uniq.size / length) : 0

  // Repetition: how often tokens repeat beyond first occurrence
  const counts = new Map<string, number>()
  for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1)
  const repeats = Array.from(counts.values()).reduce((acc, c) => acc + Math.max(0, c - 1), 0)
  const repetition = length ? clamp01(repeats / length) : 0

  const punct = (text.match(/[.,!?;:]/g) ?? []).length
  const punctuation_rate = text.length ? clamp01(punct / text.length) : 0

  const avg_word_len = length ? words.reduce((a, w) => a + w.length, 0) / length : 0

  return { length, burstiness, repetition, punctuation_rate, avg_word_len, unique_word_ratio }
}

/**
 * Edge-safe heuristic scoring.
 * Higher score ≈ more "LLM-like" patterns: low burstiness, higher repetition, unusually uniform structure.
 * This is not definitive proof.
 */
function scoreAI(signals: ReturnType<typeof computeSignals>) {
  const { length, burstiness, repetition, punctuation_rate, avg_word_len, unique_word_ratio } = signals

  // Normalize components (hand-tuned; you can calibrate later on your own dataset)
  const lowBurst = clamp01(1 - burstiness) // LLM tends to be less bursty
  const rep = clamp01(repetition / 0.22)   // higher repetition -> higher score
  const lowUnique = clamp01((0.62 - unique_word_ratio) / 0.25) // low diversity -> higher score

  // punctuation: extremely low or extremely high can be suspicious; keep mild weight
  const punctMid = 1 - clamp01(Math.abs(punctuation_rate - 0.03) / 0.03)

  // avg word length: very uniform mid range; mild weight
  const wordLenMid = 1 - clamp01(Math.abs(avg_word_len - 4.7) / 2.0)

  // Length penalty: very short text is unreliable
  const lengthFactor = clamp01((length - 40) / 260)

  // Weighted sum
  const raw =
    0.34 * lowBurst +
    0.26 * rep +
    0.20 * lowUnique +
    0.10 * punctMid +
    0.10 * wordLenMid

  const ai_probability = clamp01(raw * (0.55 + 0.45 * lengthFactor))

  const notes: string[] = []
  if (length < 40) notes.push('Text is short (<40 words). Scores are unreliable; provide more text.')
  if (lowBurst > 0.75) notes.push('Low sentence-length variance (low burstiness) can correlate with templated/LLM-like output.')
  if (repetition > 0.18) notes.push('Higher repetition can correlate with automated generation, but also with certain topics/styles.')
  if (unique_word_ratio < 0.50) notes.push('Lower lexical diversity can be a signal, but domain-specific writing may also do this.')
  notes.push('Use this as a probabilistic indicator. Mixed human+AI or heavy editing can confuse any detector.')

  const confidence = ai_probability >= 0.8 ? 'high' : ai_probability >= 0.55 ? 'medium' : 'low'

  return { ai_probability, confidence, notes }
}

export const onRequestOptions: PagesFunction<Env> = async () => {
  return json({ ok: true })
}

export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  let body: DetectRequest
  try {
    body = await ctx.request.json()
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }

  const text = (body.text ?? '').trim()
  if (!text) return json({ error: 'Missing "text"' }, 400)

  const signals = computeSignals(text)
  const scored = scoreAI(signals)

  return json({
    ai_probability: scored.ai_probability,
    confidence: scored.confidence,
    signals,
    notes: scored.notes,
  })
}
