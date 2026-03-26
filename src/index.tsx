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
// STEP 1: AI 자동 판단 OCR (강화된 부호 검증)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function step1_extract(
  apiKey: string,
  images: { base64: string; mimeType: string }[]
): Promise<any> {

  const systemPrompt = `You are an expert golf scorecard OCR system for Korean golf apps (골프존, 스마트스코어, etc).

## STEP 1: IDENTIFY SCORECARD TYPE
- 1 image, 4 players → 18 holes, 4 players
- 1 image, 2 players → 18 holes, 2 players
- 2 images, 2 players each → image1=P1&P2, image2=P3&P4
- 2 images, same players different holes → front(1-9) + back(10-18)

## STEP 2: READ ACTUAL STROKE NUMBERS FIRST

### GolfZon scorecard layout:
- Each player has a "Score" row showing the ACTUAL STROKES taken (e.g. 2,3,4,5,6,7,8)
- Visual decorations indicate good/bad scores:
  - Red heart/circle around number = birdie or better (under par)
  - Blue box/square around number = bogey or worse (over par)
  - No decoration = par

### CRITICAL RULE - Read the NUMBER, not the decoration:
- See "6" in a blue box on Par4? → actual=6, diff=+2 (double bogey)
- See "3" in a red heart on Par4? → actual=3, diff=-1 (birdie)  
- See "2" in double red heart on Par4? → actual=2, diff=-2 (eagle)
- A LARGE number (5,6,7,8) is ALWAYS over par regardless of decoration
- A SMALL number (1,2,3) is ALWAYS under or at par

## STEP 3: MANDATORY VERIFICATION USING SUBTOTALS

After reading all stroke numbers, verify using the OUT/IN/T columns on the card:

1. Read OUT subtotal (T column after hole 9) = sum of holes 1-9 actual strokes
2. Read IN subtotal (T column after hole 18) = sum of holes 10-18 actual strokes  
3. Read TOTAL = OUT + IN

For each player:
- Calculate sum of your read strokes for holes 1-9
- This MUST equal the OUT subtotal shown on card
- If mismatch: find and fix the wrong hole(s)

Example verification:
- Card shows OUT=37 for player
- You read holes 1-9 as: 6,3,3,5,4,3,6,4,3 = sum=37 ✓ CORRECT
- If your sum=33 but card shows 37: you misread some holes, fix them

## STEP 4: OUTPUT DIFFS
After verifying strokes match subtotals, convert to diffs:
rawScores[player][hole] = actual_strokes - par

## OUTPUT FORMAT (JSON only, no markdown):
{
  "detectedType": "골프존 1장 2명 18홀",
  "players": ["급~송아지~", "달성군수"],
  "pars": [4,4,3,4,5,3,5,4,4, 5,4,4,4,3,4,3,4,5],
  "rawScores": [
    [2,-1,0,1,-1,1,-1,1,3, -1,-1,-1,-1,0,0,3,0,0],
    [0,0,1,0,0,0,0,1,0, 0,0,0,0,1,0,0,0,0]
  ],
  "cardTotal": [76, 79],
  "outTotal": [37, 36],
  "inTotal": [39, 43]
}`

  const imageBlocks = images.map(img => ({
    type: 'image' as const,
    source: { type: 'base64' as const, media_type: img.mimeType as any, data: img.base64 },
  }))

  const userText = `Analyze ${images.length} scorecard image(s).

IMPORTANT REMINDER:
1. Read the ACTUAL STROKE NUMBER shown in each cell first
2. Large numbers (5,6,7,8) = over par = POSITIVE diff
3. Small numbers with red decoration = under par = NEGATIVE diff  
4. Verify your reading: sum of holes 1-9 strokes MUST equal the OUT total shown on card
5. Fix any holes where your sum doesn't match the card subtotals

Return JSON only.`

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
1. Convert each diff to actual strokes: actual = par + diff
2. OUT = sum holes 1-9, IN = sum holes 10-18, total = OUT + IN
3. Verify OUT matches outTotal from input, IN matches inTotal
4. Return JSON only.

OUTPUT FORMAT:
{
  "scoreFormat": "diff",
  "players": [...],
  "holes": [
    {"hole":1,"par":4,"scores":[6,4,4,4],"diffs":[2,0,0,0]}
  ],
  "totals": {"out":[37,36,40,42],"in":[39,43,42,44],"total":[76,79,82,86]},
  "cardTotals": {"total":[76,79,82,86]}
}`

  const content = await callClaude(apiKey, {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 4000,
    system: systemPrompt,
    messages: [{
      role: 'user',
      content: `Convert this scorecard:\n${JSON.stringify(raw, null, 2)}\n\nVerify sums match outTotal/inTotal. Return JSON only.`,
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
    if (parsed.totals?.out?.[pi] !== undefined && Math.abs(outSum - parsed.totals.out[pi]) > 1)
      warnings.push(`${player}: 전반 합산 ${outSum} ≠ ${parsed.totals.out[pi]}`)
    if (parsed.totals?.in?.[pi] !== undefined && Math.abs(inSum - parsed.totals.in[pi]) > 1)
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

    let images: { base64: string; mimeType: string }[] = []

    if (body.images && Array.isArray(body.images)) {
      images = body.images
        .filter((img: any) => img.base64)
        .slice(0, 4)
        .map((img: any) => ({ base64: img.base64, mimeType: img.mimeType || 'image/jpeg' }))
    } else {
      const { imageBase64, mimeType = 'image/jpeg', imageBase64_2, mimeType2 } = body
      if (!imageBase64) return c.json({ error: 'No image data provided' }, 400)
      images = [
        { base64: imageBase64, mimeType },
        ...(imageBase64_2 ? [{ base64: imageBase64_2, mimeType: mimeType2 || 'image/jpeg' }] : [])
      ]
    }

    if (images.length === 0) return c.json({ error: 'No image data provided' }, 400)

    console.log(`Step1: AI OCR (Sonnet) ${images.length}장...`)
    const raw = await step1_extract(ANTHROPIC_API_KEY, images)
    console.log(`  → 감지: ${raw.detectedType}`)

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
