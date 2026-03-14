import { Hono } from 'hono'
import { cors } from 'hono/cors'

type Bindings = {
  OPENAI_API_KEY: string
  ASSETS: Fetcher
}

type HoleRaw = {
  hole: number
  par: number
  rawScores: (number | string)[]  // 이미지에서 읽은 그대로
  cardTotals?: { out?: number[]; in?: number[]; total?: number[] }
}

const app = new Hono<{ Bindings: Bindings }>()
app.use('*', cors())

// ── OpenAI 호출 헬퍼 ──────────────────────────────────────────
async function callOpenAI(apiKey: string, body: object): Promise<any> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`OpenAI ${res.status}: ${err}`)
  }
  const data = await res.json() as any
  return data.choices?.[0]?.message?.content || ''
}

function parseJSON(raw: string): any {
  const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
  return JSON.parse(cleaned)
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// STEP 1 — 이미지에서 숫자를 "있는 그대로" 읽기
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function step1_extract(apiKey: string, imageBase64: string, mimeType: string): Promise<any> {
  const prompt = `You are a scorecard OCR machine. Your ONLY job is to READ numbers exactly as printed.

RULES:
- Read every cell value EXACTLY as written. Do NOT interpret, convert, or calculate anything.
- Butterfly/flower icon = write as -1
- Empty cell = write as 0
- Read player names exactly as written (Korean OK)
- Read OUT / IN / TOTAL row values exactly as printed
- Return ONLY valid JSON, no markdown

JSON FORMAT:
{
  "courseName": "string or null",
  "date": "string or null", 
  "players": ["이름1", "이름2", "이름3", "이름4"],
  "pars": [4, 4, 3, 5, 4, 4, 5, 3, 4, 4, 4, 3, 5, 4, 4, 5, 3, 4],
  "rawScores": [
    [0, -1, 3, 0, 0, 2, 0, 0, 1],
    [0, 0, 0, 2, 0, 0, 0, 2, 1]
  ],
  "cardOut":   [41, 41, 55, 50],
  "cardIn":    [44, 42, 57, 52],
  "cardTotal": [85, 83, 112, 102]
}

rawScores[playerIndex] = array of raw values for each hole in order.`

  const content = await callOpenAI(apiKey, {
    model: 'gpt-4o',
    temperature: 0,
    max_tokens: 2048,
    messages: [
      { role: 'system', content: prompt },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}`, detail: 'high' } },
          { type: 'text', text: 'Read all numbers from this scorecard exactly as printed. Include player names, pars, all hole values, and OUT/IN/TOTAL rows.' }
        ]
      }
    ]
  })
  return parseJSON(content)
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// STEP 2 — 텍스트만으로 diff → 실제 타수 변환 + 검증
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function step2_convert(apiKey: string, raw: any): Promise<any> {
  const prompt = `You are a golf score calculator. You receive raw scorecard data and must convert it to actual strokes.

CONVERSION TABLE (use EXACTLY):
PAR 3 → valid scores 1–6:  diff -2→1, -1→2, 0→3, 1→4, 2→5, 3→6
PAR 4 → valid scores 1–8:  diff -3→1, -2→2, -1→3, 0→4, 1→5, 2→6, 3→7, 4→8
PAR 5 → valid scores 2–10: diff -3→2, -2→3, -1→4, 0→5, 1→6, 2→7, 3→8, 4→9, 5→10
PAR 6 → valid scores 3–12: diff -3→3, -2→4, -1→5, 0→6, 1→7, 2→8, 3→9, 4→10, 5→11, 6→12

DETECTION: 
- If cardTotal values are large (70~130) but rawScores are small (-3~5) → rawScores are DIFFS → convert
- If rawScores already look like strokes (3~9) AND match cardTotal → keep as-is

STEPS:
1. Detect format (diff or stroke)
2. Convert each raw value using the table above: actual = par + diff
3. Sum converted scores per player for OUT (holes 1-9) and IN (holes 10-18)
4. Compare your sums with cardOut / cardIn / cardTotal
5. If mismatch remains, double-check format detection
6. Return final result as JSON only, no markdown

OUTPUT FORMAT:
{
  "scoreFormat": "diff" or "stroke",
  "players": ["이름1", ...],
  "holes": [
    { "hole": 1, "par": 4, "scores": [5,4,6,4], "diffs": [1,0,2,0] }
  ],
  "totals": { "out": [41,41,55,50], "in": [44,42,57,52], "total": [85,83,112,102] },
  "cardTotals": { "out": [...], "in": [...], "total": [...] }
}`

  const inputText = `Raw scorecard data:
${JSON.stringify(raw, null, 2)}

Convert this data. Use the conversion table exactly.`

  const content = await callOpenAI(apiKey, {
    model: 'gpt-4o',
    temperature: 0,
    max_tokens: 3000,
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content: inputText }
    ]
  })
  return parseJSON(content)
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 서버사이드 검증
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function validate(parsed: any): string[] {
  const warnings: string[] = []
  const players: string[] = parsed.players || []
  const holes: any[] = parsed.holes || []
  const totals = parsed.totals || {}
  const cardTotals = parsed.cardTotals || totals
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
  const OPENAI_API_KEY = c.env?.OPENAI_API_KEY || ''
  if (!OPENAI_API_KEY) return c.json({ error: 'OPENAI_API_KEY is not configured' }, 500)

  try {
    const body = await c.req.json()
    const { imageBase64, mimeType = 'image/jpeg' } = body
    if (!imageBase64) return c.json({ error: 'No image data provided' }, 400)

    // STEP 1: 이미지 → raw 숫자
    console.log('Step 1: Extracting raw values from image...')
    const raw = await step1_extract(OPENAI_API_KEY, imageBase64, mimeType)

    // STEP 2: raw 숫자 → 실제 타수 변환
    console.log('Step 2: Converting to actual strokes...')
    const converted = await step2_convert(OPENAI_API_KEY, raw)

    // STEP 3: 서버사이드 검증
    const warnings = validate(converted)

    return c.json({
      success: true,
      data: converted,
      warnings,
      debug: { scoreFormat: converted.scoreFormat }
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
