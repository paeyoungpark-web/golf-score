import { Hono } from 'hono'
import { cors } from 'hono/cors'

type Bindings = {
  ANTHROPIC_API_KEY: string
  ASSETS: Fetcher
}

const app = new Hono<{ Bindings: Bindings }>()
app.use('*', cors())

// ── Anthropic API 호출 헬퍼 ──────────────────────────────────
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
// STEP 1 — 이미지에서 숫자를 있는 그대로 읽기 (OCR)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function step1_extract(apiKey: string, imageBase64: string, mimeType: string): Promise<any> {
  const prompt = `You are a golf scorecard OCR machine. Your ONLY job is to READ numbers exactly as printed. Do NOT interpret or convert anything.

RULES:
- Read every cell value EXACTLY as written
- Butterfly/flower icon = write as -1
- Empty cell = write as 0
- Read player names exactly as written (Korean OK)
- Read OUT / IN / TOTAL row values exactly as printed
- Return ONLY valid JSON, no markdown, no explanation

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

rawScores[playerIndex] = array of raw cell values for ALL holes in order (hole 1 to 18).`

  const content = await callClaude(apiKey, {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2048,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mimeType as any,
              data: imageBase64,
            },
          },
          {
            type: 'text',
            text: 'Read all numbers from this golf scorecard exactly as printed. Extract player names, par values for each hole, all raw score values, and OUT/IN/TOTAL summary rows. Return JSON only.',
          },
        ],
      },
    ],
  })
  return parseJSON(content)
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// STEP 2 — diff → 실제 타수 변환 + 검증 (텍스트만)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function step2_convert(apiKey: string, raw: any): Promise<any> {
  const prompt = `You are a golf score calculator. Convert raw scorecard data to actual strokes.

CONVERSION TABLE (use EXACTLY — do not deviate):
PAR 3 (valid: 1–6):  diff -2→1, -1→2, 0→3, 1→4, 2→5, 3→6
PAR 4 (valid: 1–8):  diff -3→1, -2→2, -1→3, 0→4, 1→5, 2→6, 3→7, 4→8
PAR 5 (valid: 2–10): diff -3→2, -2→3, -1→4, 0→5, 1→6, 2→7, 3→8, 4→9, 5→10
PAR 6 (valid: 3–12): diff -3→3, -2→4, -1→5, 0→6, 1→7, 2→8, 3→9, 4→10, 5→11, 6→12

FORMAT DETECTION:
- If cardTotal values are large (70~130) but rawScores are small (-3~5) → rawScores are DIFFS → convert
- If rawScores already match cardTotal as strokes (3~9) → keep as-is

STEPS:
1. Detect format (diff or stroke)
2. Convert every hole for every player using the table: actual = par + diff
3. Calculate OUT sum (holes 1-9) and IN sum (holes 10-18) per player
4. Verify: your OUT+IN must equal cardTotal. If not, re-check your conversion.
5. Return JSON only, no markdown

OUTPUT FORMAT:
{
  "scoreFormat": "diff",
  "players": ["이름1", "이름2", "이름3", "이름4"],
  "holes": [
    { "hole": 1, "par": 4, "scores": [4, 4, 6, 6], "diffs": [0, 0, 2, 2] }
  ],
  "totals": { "out": [41,41,55,50], "in": [44,42,57,52], "total": [85,83,112,102] },
  "cardTotals": { "out": [41,41,55,50], "in": [44,42,57,52], "total": [85,83,112,102] }
}`

  const inputText = `Raw scorecard data to convert:
${JSON.stringify(raw, null, 2)}

Apply the conversion table exactly. Verify your sums match the card totals before returning.`

  const content = await callClaude(apiKey, {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 3000,
    messages: [
      { role: 'user', content: inputText },
    ],
    system: prompt,
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

    // STEP 1: 이미지 → raw 숫자
    console.log('Step 1: OCR - extracting raw values...')
    const raw = await step1_extract(ANTHROPIC_API_KEY, imageBase64, mimeType)

    // STEP 2: raw 숫자 → 실제 타수
    console.log('Step 2: Converting to actual strokes...')
    const converted = await step2_convert(ANTHROPIC_API_KEY, raw)

    // STEP 3: 검증
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
