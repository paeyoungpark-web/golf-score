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
// STEP 1: AI 자동 판단 OCR
// - 이미지 형태 자동 인식 (골프존/스마트스코어/기타)
// - 2명씩, 전후반 분리, 4명 1장 등 모두 자동 처리
// - 최대 4장 동시 입력 지원
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function step1_extract(
  apiKey: string,
  images: { base64: string; mimeType: string }[]
): Promise<any> {

  const systemPrompt = `You are an expert golf scorecard OCR system. You can read ANY type of Korean golf scorecard image.

## YOUR TASK
Analyze the provided image(s) and extract complete scorecard data.

## STEP 1: IDENTIFY SCORECARD TYPE
First, examine the image(s) and determine:

A) **How many players** are shown? (1~4 players)
B) **How many holes** are shown? (9 holes = front/back split, 18 holes = full round)
C) **How many images** were provided? Use this to understand the data:
   - 1 image with 4 players → full round 18 holes, 4 players
   - 1 image with 2 players → full round 18 holes, 2 players  
   - 2 images, each with 2 players → combine: image1=P1&P2, image2=P3&P4 (18 holes each)
   - 2 images with same players but different holes → front/back split: image1=holes1-9, image2=holes10-18
   - 3~4 images → analyze each and combine logically

## STEP 2: READ SCORES
For each player in each hole:
1. Read the PAR value for that hole (par3, par4, par5, or par6)
2. Read the SCORE (actual strokes OR diff from par)
3. Determine if values are shown as:
   - **Diff format**: numbers like -2, -1, 0, +1, +2, +3 (or with icons: 🐦=birdie=-1)
   - **Actual strokes**: numbers like 2, 3, 4, 5, 6, 7
4. Read the player's total score shown on the card (cardTotal)

## STEP 3: VERIFY WITH MATH
For each player:
- ParTotal = sum of all par values
- If scores are in diff format: cardTotal should equal ParTotal + sum(diffs)
- If scores are actual strokes: cardTotal should equal sum(scores)
- Use cardTotal to verify and correct sign ambiguities

## CRITICAL RULES
- Return rawScores as DIFF values (actual - par). If image shows actual strokes, convert: diff = actual - par
- If a hole value is ambiguous (e.g., "1" could be birdie=-1 or bogey=+1), use cardTotal math to determine correct sign
- Icons/decorations: heart=birdie=-1, eagle=−2, etc.
- ALWAYS output exactly 18 rawScore values per player (for 9-hole splits, combine both images)
- Player names: read exactly as shown

## OUTPUT FORMAT (JSON only, no markdown):
{
  "detectedType": "description of what you detected (e.g. '골프존 2장, 각 2명 18홀')",
  "courseName": null,
  "date": null,
  "players": ["플레이어1", "플레이어2", "플레이어3", "플레이어4"],
  "pars": [4,5,3,4,4,4,5,3,4,4,4,3,4,4,5,4,3,4],
  "rawScores": [
    [0,1,-1,0,0,1,-1,0,2, 1,0,0,-1,0,1,0,0,0],
    [1,0,0,0,1,0,0,1,0, 0,2,1,0,0,0,1,0,0]
  ],
  "cardTotal": [76, 79, 82, 85]
}

NOTES:
- pars: array of 18 par values
- rawScores: one array per player, each with 18 diff values
- cardTotal: total score shown on card for each player
- If only 2 players detected, return only 2 entries in players/rawScores/cardTotal`

  const imageBlocks = images.map(img => ({
    type: 'image' as const,
    source: { type: 'base64' as const, media_type: img.mimeType as any, data: img.base64 },
  }))

  const userText = `I'm providing ${images.length} scorecard image(s). Please analyze and extract all player scores. Return JSON only.`

  const content = await callClaude(apiKey, {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 3000,
    system: systemPrompt,
    messages: [{
      role: 'user',
      content: [...imageBlocks, { type: 'text', text: userText }],
    }],
  })
  return parseJSON(content)
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// STEP 2: diff → 실제 타수 변환 (Haiku)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function step2_convert(apiKey: string, raw: any): Promise<any> {
  const systemPrompt = `You are a golf score calculator. Convert diff-format scores to actual strokes.

CONVERSION: actual = par + diff
- PAR 3: diff -2→1, -1→2, 0→3, 1→4, 2→5, 3→6
- PAR 4: diff -3→1, -2→2, -1→3, 0→4, 1→5, 2→6, 3→7, 4→8
- PAR 5: diff -3→2, -2→3, -1→4, 0→5, 1→6, 2→7, 3→8, 4→9, 5→10
- PAR 6: diff -3→3, -2→4, -1→5, 0→6, 1→7, 2→8, 3→9, 4→10

STEPS:
1. For each player i and hole h: scores[i] = pars[h] + rawScores[i][h]
2. OUT = sum of holes 1-9, IN = sum of holes 10-18, total = OUT + IN
3. Verify total matches cardTotal (within ±1 rounding tolerance)
4. Return JSON only, no markdown.

OUTPUT FORMAT:
{
  "scoreFormat": "diff",
  "players": [...],
  "holes": [
    {"hole":1,"par":4,"scores":[3,4,5,4],"diffs":[-1,0,1,0]}
  ],
  "totals": {"out":[36,38,40,42],"in":[36,40,42,44],"total":[72,78,82,86]},
  "cardTotals": {"total":[72,78,82,86]}
}`

  const content = await callClaude(apiKey, {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 4000,
    system: systemPrompt,
    messages: [{
      role: 'user',
      content: `Convert this scorecard data:\n${JSON.stringify(raw, null, 2)}\n\nReturn JSON only.`,
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
    if (cardTotal !== undefined && Math.abs(allSum - cardTotal) > 1)
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

    // ✅ 여러 장 이미지 지원 (최대 4장)
    // 형식 1: images 배열 [{base64, mimeType}, ...]
    // 형식 2: 기존 호환 imageBase64, imageBase64_2
    let images: { base64: string; mimeType: string }[] = []

    if (body.images && Array.isArray(body.images)) {
      // 새 형식: 배열로 여러 장
      images = body.images
        .filter((img: any) => img.base64)
        .slice(0, 4) // 최대 4장
        .map((img: any) => ({ base64: img.base64, mimeType: img.mimeType || 'image/jpeg' }))
    } else {
      // 기존 형식 호환
      const { imageBase64, mimeType = 'image/jpeg', imageBase64_2, mimeType2 } = body
      if (!imageBase64) return c.json({ error: 'No image data provided' }, 400)
      images = [
        { base64: imageBase64, mimeType },
        ...(imageBase64_2 ? [{ base64: imageBase64_2, mimeType: mimeType2 || 'image/jpeg' }] : [])
      ]
    }

    if (images.length === 0) return c.json({ error: 'No image data provided' }, 400)

    console.log(`Step1: AI 자동 판단 OCR (Sonnet) ${images.length}장...`)
    const raw = await step1_extract(ANTHROPIC_API_KEY, images)
    console.log(`  → 감지된 카드 유형: ${raw.detectedType}`)

    console.log('Step2: 타수 변환 (Haiku)...')
    const converted = await step2_convert(ANTHROPIC_API_KEY, raw)

    const warnings = validate(converted)

    return c.json({
      success: true,
      data: converted,
      warnings,
      debug: {
        detectedType: raw.detectedType,
        scoreFormat: converted.scoreFormat,
        cardCount: images.length,
        playerCount: converted.players?.length || 0,
        estimatedCost: `~${20 + images.length * 8}원`,
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
