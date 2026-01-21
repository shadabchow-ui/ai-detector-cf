export interface Env {}

type DetectRequest = { text?: string }

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
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

/* ------------------------------------------------------------------
   Heuristic signal computation (baseline layer)
------------------------------------------------------------------ */

function computeSignals(text: string) {
  const words = tokenizeWords(text)
  const length = words.length

  const sentences = splitSentences(text)
  const sentenceLens = sentences
    .map(s => tokenizeWords(s).length)
    .filter(n => n > 0)

  const burstiness = sentenceLens.length
    ? clamp01(
        stddev(sentenceLens) /
          ((sentenceLens.reduce((a, b) => a + b, 0) /
            sentenceLens.length) +
            1e-6)
      )
    : 0

  const uniq = new Set(words)
  const unique_word_ratio = length ? clamp01(uniq.size / length) : 0

  const counts = new Map<string, number>()
  for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1)
  const repeats = Array.from(counts.values()).reduce(
    (acc, c) => acc + Math.max(0, c - 1),
    0
  )
  const repetition = length ? clamp01(repeats / length) : 0

  const punct = (text.match(/[.,!?;:]/g) ?? []).length
  const punctuation_rate = text.length
    ? clamp01(punct / text.length)
    : 0

  const avg_word_len = length
    ? words.reduce((a, w) => a + w.length, 0) / length
    : 0

  return {
    length,
    burstiness,
    repetition,
    punctuation_rate,
    avg_word_len,
    unique_word_ratio,
  }
}

function heuristicScore(signals: ReturnType<typeof computeSignals>) {
  const {
    length,
    burstiness,
    repetition,
    punctuation_rate,
    avg_word_len,
    unique_word_ratio,
  } = signals

  const lowBurst = clamp01(1 - burstiness)
  const rep = clamp01(repetition / 0.22)
  const lowUnique = clamp01((0.62 - unique_word_ratio) / 0.25)
  const punctMid = 1 - clamp01(Math.abs(punctuation_rate - 0.03) / 0.03)
  const wordLenMid = 1 - clamp01(Math.abs(avg_word_len - 4.7) / 2.0)
  const lengthFactor = clamp01((length - 40) / 260)

  const raw =
    0.34 * lowBurst +
    0.26 * rep +
    0.20 * lowUnique +
    0.10 * punctMid +
    0.10 * wordLenMid

  const ai_probability = clamp01(raw * (0.55 + 0.45 * lengthFactor))

  const notes: string[] = []
  if (length < 40)
    notes.push('Text is short; detector confidence is reduced.')
  if (lowBurst > 0.75)
    notes.push('Low sentence-length variance (low burstiness).')
  if (repetition > 0.18)
    notes.push('Elevated repetition detected.')
  if (unique_word_ratio < 0.5)
    notes.push('Lower lexical diversity observed.')

  return { ai_probability, notes }
}

/* ------------------------------------------------------------------
   ZipPy-style entropy layer (compression ratio)
------------------------------------------------------------------ */

async function compressionRatio(text: string): Promise<number> {
  const encoder = new TextEncoder()
  const data = encoder.encode(text)

  const cs = new CompressionStream('gzip')
  const writer = cs.writable.getWriter()
  writer.write(data)
  writer.close()

  const compressed = await new Response(cs.readable).arrayBuffer()
  return compressed.byteLength / data.byteLength
}

function zipPyScore(ratio: number) {
  // Expected empirical range
  const min = 0.28
  const max = 0.68

  const normalized =
    1 - Math.max(0, Math.min(1, (ratio - min) / (max - min)))

  return {
    compression_ratio: ratio,
    zippy_score: normalized,
  }
}

/* ------------------------------------------------------------------
   HTTP handlers
------------------------------------------------------------------ */

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
  const base = heuristicScore(signals)

  let zippy = { compression_ratio: 0, zippy_score: 0 }
  if (signals.length >= 60) {
    const ratio = await compressionRatio(text)
    zippy = zipPyScore(ratio)
  }

  // Ensemble score
  const finalScore =
    0.65 * base.ai_probability +
    0.35 * zippy.zippy_score

  const confidence =
    finalScore >= 0.8 ? 'high' :
    finalScore >= 0.55 ? 'medium' :
    'low'

  return json({
    ai_probability: finalScore,
    confidence,
    signals: {
      ...signals,
      compression_ratio: zippy.compression_ratio,
      zippy_score: zippy.zippy_score,
    },
    notes: [
      ...base.notes,
      'ZipPy-style compression entropy applied.',
      'Lower compression ratios often correlate with AI-generated text.',
    ],
  })
}
