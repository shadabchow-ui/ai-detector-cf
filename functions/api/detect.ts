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

/* ============================================================
   1) HEURISTIC BASELINE SIGNALS
============================================================ */

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

function heuristicScore(s: ReturnType<typeof computeSignals>) {
  const lowBurst = clamp01(1 - s.burstiness)
  const rep = clamp01(s.repetition / 0.22)
  const lowUnique = clamp01((0.62 - s.unique_word_ratio) / 0.25)
  const punctMid = 1 - clamp01(Math.abs(s.punctuation_rate - 0.03) / 0.03)
  const wordLenMid = 1 - clamp01(Math.abs(s.avg_word_len - 4.7) / 2.0)
  const lengthFactor = clamp01((s.length - 40) / 260)

  const raw =
    0.34 * lowBurst +
    0.26 * rep +
    0.20 * lowUnique +
    0.10 * punctMid +
    0.10 * wordLenMid

  return clamp01(raw * (0.55 + 0.45 * lengthFactor))
}

/* ============================================================
   2) ZIPPY-STYLE ENTROPY (COMPRESSION)
============================================================ */

async function compressionRatio(text: string): Promise<number> {
  const data = new TextEncoder().encode(text)
  const cs = new CompressionStream('gzip')
  const writer = cs.writable.getWriter()
  writer.write(data)
  writer.close()
  const compressed = await new Response(cs.readable).arrayBuffer()
  return compressed.byteLength / data.byteLength
}

function zipPyScore(ratio: number) {
  const min = 0.28
  const max = 0.68
  return clamp01(1 - (ratio - min) / (max - min))
}

/* ============================================================
   3) DETECTGPT-STYLE PERTURBATION STABILITY
============================================================ */

/**
 * Create light semantic-preserving perturbations
 * AI text is unusually stable under these changes
 */
function perturbText(text: string, seed: number): string {
  const words = tokenizeWords(text)
  if (words.length < 12) return text

  const rng = (n: number) =>
    Math.abs(Math.sin(seed++ * 9973)) % 1 * n

  const out = [...words]

  // swap two adjacent words
  const i = Math.floor(rng(out.length - 1))
  ;[out[i], out[i + 1]] = [out[i + 1], out[i]]

  // drop a low-information word
  if (out.length > 20) {
    out.splice(Math.floor(rng(out.length)), 1)
  }

  return out.join(' ')
}

function detectGPTScore(text: string, baseScore: number) {
  const samples = 5
  const deltas: number[] = []

  for (let i = 0; i < samples; i++) {
    const perturbed = perturbText(text, i + 1)
    const sig = computeSignals(perturbed)
    const score = heuristicScore(sig)
    deltas.push(Math.abs(score - baseScore))
  }

  const stability = 1 - clamp01(deltas.reduce((a, b) => a + b, 0) / samples / 0.15)

  return {
    perturbation_stability: stability, // higher = more AI-like
  }
}

/* ============================================================
   HTTP HANDLERS
============================================================ */

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
  const baseScore = heuristicScore(signals)

  let zippy = 0
  if (signals.length >= 60) {
    const ratio = await compressionRatio(text)
    zippy = zipPyScore(ratio)
  }

  const detectgpt = detectGPTScore(text, baseScore)

  /* ================= ENSEMBLE ================= */

  const finalScore =
    0.40 * baseScore +
    0.30 * zippy +
    0.30 * detectgpt.perturbation_stability

  const confidence =
    finalScore >= 0.8 ? 'high' :
    finalScore >= 0.55 ? 'medium' :
    'low'

  return json({
    ai_probability: finalScore,
    confidence,
    signals: {
      ...signals,
      zippy_score: zippy,
      detectgpt_stability: detectgpt.perturbation_stability,
    },
    notes: [
      'Heuristic statistical signals applied.',
      'ZipPy-style compression entropy applied.',
      'DetectGPT-style perturbation stability applied.',
      'Higher stability under perturbation correlates with AI-generated text.',
    ],
  })
}
