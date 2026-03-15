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
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`)
  const data = await res.json() as any
  return data.content?.[0]?.text || ''
}

function parseJSON(raw: string): any {
  const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
  return JSON.parse(cleaned)
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// STEP 1: OCR — 이미지에서 숫자 읽기 (1장 or 2장 동시)
// 골프존: 이미지 1장 = 2명 × 18홀 / 2장 = 4명 × 18홀
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function step1_extract(
  apiKey: string,
  images: { base64: string; mimeType: string }[],
  cardMode: string = '1card-4p'
): Promise<any> {
  const isMulti = images.length > 1

  const systemPrompt = `You are a golf scorecard OCR machine for Korean screen golf (골프존/GolfZon) scorecards.

CRITICAL RULES:
1. Read ONLY the "Score" row values — ignore Putt, Sensor rows
2. Read values EXACTLY as printed: numbers like -1, 0, 1, 2, 3
3. Heart icon (❤️) or flower icon = BIRDIE = -1
4. GolfZon sticker icon = BIRDIE = -1  
5. Each image contains EXACTLY 2 players, each with 18 holes (9 front + 9 back)
6. Read player names from the top of each player section
7. Read the total score shown next to the player name (e.g. "70 (-3)" → cardTotal=70)
8. Par values: read from Par row
9. Return ONLY valid JSON, no markdown

${isMulti ? `TWO IMAGES PROVIDED:
- Image 1: Players 1 and 2
- Image 2: Players 3 and 4
- Combine into single result with 4 players` : `ONE IMAGE: Contains 2 players`}

JSON FORMAT:
{
  "courseName": null,
  "date": null,
  "players": ["로뎀아래", "아지아나이스", "대박~나이스", "오그셈버"],
  "pars": [4,5,3,4,4,4,5,3,4,6,4,3,4,4,5,4,3,4],
  "rawScores": [
    [-1,1,0,0,2,2,-1,-1,-1,-1,0,0,-1,-1,-1,0,0,0],
    [0,0,0,-1,1,0,0,0,1,0,2,1,0,0,0,0,0,0]
  ],
  "cardTotal": [70, 77, 80, 81]
}

rawScores[playerIndex] = 18 values in order (holes 1-18).
cardTotal = the total score shown next to each player name.`

  const imageBlocks = images.map(img => ({
    type: 'image' as const,
    source: { type: 'base64' as const, media_type: img.mimeType as any, data: img.base64 },
  }))

  const userTextMap: Record<string,string> = {
    '1card-4p':    'Read Score rows for ALL 4 players. 1 image, 4 players, 18 holes each. Return JSON only.',
    '2card-4p':    'Read Score rows for ALL 4 players. Image1=players1&2 (18 holes each), Image2=players3&4 (18 holes each). Return JSON only.',
    '2card-split': 'Read Score rows from BOTH images. Image1=holes1-9 for all players, Image2=holes10-18 for all players. Combine into 18 holes. Return JSON only.',
    '1card-2p':    'Read Score rows for both players. 1 image, 2 players, 18 holes each. Return JSON only.',
  }
  const userText = userTextMap[cardMode] || userTextMap['1card-4p']

  const content = await callClaude(apiKey, {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2048,
    system: systemPrompt,
    messages: [{
      role: 'user',
      content: [...imageBlocks, { type: 'text', text: userText }],
    }],
  })
  return parseJSON(content)
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// STEP 2: 변환 — diff → 실제 타수 (Haiku, 텍스트만)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function step2_convert(apiKey: string, raw: any): Promise<any> {
  const systemPrompt = `You are a golf score calculator. Convert diff-format scores to actual strokes.

CONVERSION TABLE (EXACT):
PAR 3: diff -2→1, -1→2, 0→3, 1→4, 2→5, 3→6
PAR 4: diff -3→1, -2→2, -1→3, 0→4, 1→5, 2→6, 3→7, 4→8
PAR 5: diff -3→2, -2→3, -1→4, 0→5, 1→6, 2→7, 3→8, 4→9, 5→10
PAR 6: diff -3→3, -2→4, -1→5, 0→6, 1→7, 2→8, 3→9, 4→10, 5→11, 6→12

STEPS:
1. For each player, convert rawScores[i] using par[i]: actual = par[i] + diff[i]
2. Calculate OUT sum (holes 1-9) and IN sum (holes 10-18)
3. OUT + IN = total. Compare with cardTotal to verify.
4. Return JSON only, no markdown.

OUTPUT:
{
  "scoreFormat": "diff",
  "players": [...],
  "holes": [
    {"hole":1,"par":4,"scores":[3,4,4,4],"diffs":[-1,0,0,0]}
  ],
  "totals": {"out":[35,37,39,45],"in":[35,40,41,36],"total":[70,77,80,81]},
  "cardTotals": {"total":[70,77,80,81]}
}`

  const content = await callClaude(apiKey, {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 4000,
    system: systemPrompt,
    messages: [{
      role: 'user',
      content: `Convert this GolfZon scorecard data:\n${JSON.stringify(raw, null, 2)}\n\nApply table exactly. Verify sums match cardTotal.`,
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
  const cardTotals = parsed.cardTotals || {}
  const outCount = 9

  players.forEach((player: string, pi: number) => {
    const allSum = holes.reduce((s: number, h: any) => s + (h.scores?.[pi] || 0), 0)
    const outSum = holes.filter((h: any) => h.hole <= outCount).reduce((s: number, h: any) => s + (h.scores?.[pi] || 0), 0)
    const inSum  = holes.filter((h: any) => h.hole > outCount).reduce((s: number, h: any) => s + (h.scores?.[pi] || 0), 0)
    const cardTotal = cardTotals.total?.[pi]
    if (cardTotal !== undefined && allSum !== cardTotal)
      warnings.push(`${player}: 합산 ${allSum} ≠ 카드 합계 ${cardTotal}`)
    if (parsed.totals?.out?.[pi] !== undefined && outSum !== parsed.totals.out[pi])
      warnings.push(`${player}: 전반 합산 ${outSum} ≠ ${parsed.totals.out[pi]}`)
    if (parsed.totals?.in?.[pi] !== undefined && inSum !== parsed.totals.in[pi])
      warnings.push(`${player}: 후반 합산 ${inSum} ≠ ${parsed.totals.in[pi]}`)
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
    const { imageBase64, mimeType = 'image/jpeg', imageBase64_2, mimeType2, cardMode = '1card-4p' } = body
    if (!imageBase64) return c.json({ error: 'No image data provided' }, 400)

    const images: { base64: string; mimeType: string }[] = [
      { base64: imageBase64, mimeType },
      ...(imageBase64_2 ? [{ base64: imageBase64_2, mimeType: mimeType2 || 'image/jpeg' }] : [])
    ]

    console.log(`Step1: OCR (Sonnet) ${images.length}장, mode=${cardMode}...`)
    const raw = await step1_extract(ANTHROPIC_API_KEY, images, cardMode)

    console.log('Step2: Convert (Haiku)...')
    const converted = await step2_convert(ANTHROPIC_API_KEY, raw)

    const warnings = validate(converted)

    return c.json({
      success: true,
      data: converted,
      warnings,
      debug: {
        scoreFormat: converted.scoreFormat,
        cardCount: images.length,
        estimatedCost: images.length === 1 ? '~33원' : '~36원',
      }
    })
  } catch (err: any) {
    console.error('Error:', err)
    return c.json({ error: err.message || 'Internal server error' }, 500)
  }
})

app.get('/api/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }))
app.get('*', async (c) => c.env.ASSETS.fetch(c.req.raw))

export default app
