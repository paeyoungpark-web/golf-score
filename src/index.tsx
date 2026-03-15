import { Hono } from 'hono'
import { cors } from 'hono/cors'

type Bindings = {
  ANTHROPIC_API_KEY: string
  ASSETS: Fetcher
}

const app = new Hono<{ Bindings: Bindings }>()
app.use('*', cors())

async function callClaude(apiKey: string, body: object): Promise<any> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Anthropic ${res.status}: ${err}`)
  }
  const data = await res.json() as any
  return data.content?.[0]?.text || ''
}

function parseJSON(raw: string): any {
  const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
  return JSON.parse(cleaned)
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// STEP 1 — 이미지 OCR (Haiku — 저렴)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function step1_extract(apiKey: string, imageBase64: string, mimeType: string): Promise<any> {
  const prompt = `You are a golf scorecard OCR machine. READ numbers exactly as printed. Do NOT interpret or convert.

RULES:
- Read every cell value EXACTLY as written
- Butterfly/flower icon = write as -1
- Empty cell = write as 0
- Read player names exactly (Korean OK)
- Read OUT / IN / TOTAL rows exactly as printed
- Return ONLY valid JSON, no markdown

JSON FORMAT:
{
  "courseName": "string or null",
  "date": "string or null",
  "players": ["이름1", "이름2", "이름3", "이름4"],
  "pars": [4, 4, 3, 5, 4, 4, 5, 3, 4, 4, 4, 3, 5, 4, 4, 5, 3, 4],
  "rawScores": [
    [0, -1, 3, 0, 0, 2, 0, 0, 1, 1, 0, 1, 1, 0, 1, 1, 0, 3],
    [0, 0, 0, 2, 0, 0, 0, 2, 1, -1, 0, 0, 3, 1, 0, 0, 3, 0]
  ],
  "cardOut":   [41, 41, 55, 50],
  "cardIn":    [44, 42, 57, 52],
  "cardTotal": [85, 83, 112, 102]
}
rawScores[playerIndex] = array of raw values for ALL holes in order.`

  const content = await callClaude(apiKey, {
    model: 'claude-haiku-4-5-20251001',  // ← Haiku (저렴)
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: mimeType as any, data: imageBase64 },
        },
        {
          type: 'text',
          text: 'Read all numbers from this golf scorecard exactly as printed. Extract player names, par values, all raw score values, and OUT/IN/TOTAL summary rows. Return JSON only.',
        },
      ],
    }],
  })
  return parseJSON(content)
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// STEP 2 — diff → 실제 타수 변환 (Haiku — 텍스트만이라 충분)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function step2_convert(apiKey: string, raw: any): Promise<any> {
  const prompt = `You are a golf score calculator. Convert raw scorecard data to actual strokes.

CONVERSION TABLE (use EXACTLY):
PAR 3 (valid: 1–6):  diff -2→1, -1→2, 0→3, 1→4, 2→5, 3→6
PAR 4 (valid: 1–8):  diff -3→1, -2→2, -1→3, 0→4, 1→5, 2→6, 3→7, 4→8
PAR 5 (valid: 2–10): diff -3→2, -2→3, -1→4, 0→5, 1→6, 2→7, 3→8, 4→9, 5→10
PAR 6 (valid: 3–12): diff -3→3, -2→4, -1→5, 0→6, 1→7, 2→8, 3→9, 4→10, 5→11, 6→12

FORMAT DETECTION:
- cardTotal large (70~130) + rawScores small (-3~5) → DIFF format → convert
- rawScores already match cardTotal as strokes → keep as-is

STEPS:
1. Detect format
2. Convert: actual = par + diff
3. Sum OUT (holes 1-9) and IN (holes 10-18)
4. Verify sums match cardTotal
5. Return JSON only, no markdown

OUTPUT:
{
  "scoreFormat": "diff",
  "players": ["이름1", ...],
  "holes": [{ "hole": 1, "par": 4, "scores": [4,4,6,6], "diffs": [0,0,2,2] }],
  "totals": { "out": [41,41,55,50], "in": [44,42,57,52], "total": [85,83,112,102] },
  "cardTotals": { "out": [41,41,55,50], "in": [44,42,57,52], "total": [85,83,112,102] }
}`

  const content = await callClaude(apiKey, {
    model: 'claude-haiku-4-5-20251001',  // ← Haiku (저렴)
    max_tokens: 3000,
    system: prompt,
    messages: [{
      role: 'user',
      content: `Raw scorecard data:\n${JSON.stringify(raw, null, 2)}\n\nApply conversion table exactly. Verify sums match card totals.`,
    }],
  })
  return parseJSON(content)
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 검증
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function validate(parsed: any): string[] {
  const warnings: string[] = []
  const players: string[] = parsed.players || []
  const holes: any[] = parsed.holes || []
  const cardTotals = parsed.cardTotals || parsed.totals || {}
  const outCount = 9

  players.forEach((player: string, pi: number) => {
    const allSum = holes.reduce((s: number, h: any) => s + (h.scores?.[pi] || 0), 0)
    const outSum = holes.filter((h: any) => h.hole <= outCount).reduce((s: number, h: any) => s + (h.scores?.[pi] || 0), 0)
    const inSum  = holes.filter((h: any) => h.hole > outCount).reduce((s: number, h: any) => s + (h.scores?.[pi] || 0), 0)

    const cardTotal = cardTotals.total?.[pi]
    const cardOut   = cardTotals.out?.[pi]
    const cardIn    = cardTotals.in?.[pi]

    if (cardTotal !== undefined && allSum !== cardTotal)
      warnings.push(`${player}: 전체 합계 불일치 — 홀 합산 ${allSum} ≠ 카드 합계 ${cardTotal}`)
    if (cardOut !== undefined && outSum !== cardOut)
      warnings.push(`${player}: 전반(OUT) 불일치 — 홀 합산 ${outSum} ≠ 카드 OUT ${cardOut}`)
    if (cardIn !== undefined && inSum !== cardIn)
      warnings.push(`${player}: 후반(IN) 불일치 — 홀 합산 ${inSum} ≠ 카드 IN ${cardIn}`)
  })
  return warnings
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// API 라우트
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.post('/api/analyze', async (c) => {
  const ANTHROPIC_API_KEY = c.env?.ANTHROPIC_API_KEY || ''
  if (!ANTHROPIC_API_KEY) return c.json({ error: 'ANTHROPIC_API_KEY is not configured' }, 500)

  try {
    const body = await c.req.json()
    const { imageBase64, mimeType = 'image/jpeg' } = body
    if (!imageBase64) return c.json({ error: 'No image data provided' }, 400)

    console.log('Step 1: OCR (Haiku)...')
    const raw = await step1_extract(ANTHROPIC_API_KEY, imageBase64, mimeType)

    console.log('Step 2: Convert (Haiku)...')
    const converted = await step2_convert(ANTHROPIC_API_KEY, raw)

    const warnings = validate(converted)

    return c.json({
      success: true,
      data: converted,
      warnings,
      debug: { scoreFormat: converted.scoreFormat, model: 'claude-haiku-4-5' }
    })

  } catch (err: any) {
    console.error('Analysis error:', err)
    return c.json({ error: err.message || 'Internal server error' }, 500)
  }
})

app.get('/api/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }))

app.get('*', async (c) => {
  return c.env.ASSETS.fetch(c.req.raw)
})

export default app
