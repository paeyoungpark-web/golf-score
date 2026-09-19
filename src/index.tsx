import { Hono } from 'hono'
import { cors } from 'hono/cors'

type Bindings = {
  ANTHROPIC_API_KEY: string
  APP_API_KEY: string
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
  const cleaned = raw.replace(/```(?:json)?/gi, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('AI response did not contain a JSON object')
  return JSON.parse(cleaned.slice(start, end + 1))
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// STEP 1: OCR — 이미지에서 숫자 읽기 (1장 or 2장 동시)
// 골프존: 이미지 1장 = 2명 × 18홀 / 2장 = 4명 × 18홀
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function step1_extract(
  apiKey: string,
  images: { base64: string; mimeType: string }[],
  cardMode: string = 'auto'
): Promise<any> {
  if (!images.length || images.length > 2) throw new Error('One or two scorecard images are required')
  const isMulti = images.length > 1
  const isAuto = cardMode === 'auto'
  const playerCount = cardMode === '1card-2p' ? 2 : 4
  const isSplit = cardMode === '2card-split'

  const systemPrompt = `You are a golf scorecard OCR machine for Korean screen golf (골프존/GolfZon) scorecards.

CRITICAL RULES:
1. Read ONLY the "Score" row values — ignore Putt, Sensor rows
2. Read values EXACTLY as printed: numbers like -1, 0, 1, 2, 3
3. Heart icon (❤️) or flower icon = BIRDIE = -1
4. GolfZon sticker icon = BIRDIE = -1  
5. Determine whether each image contains 2 or 4 players, and whether it contains 18 holes or only front/back 9 holes
6. Read player names from the top of each player section
7. Read the total score shown next to the player name (e.g. "70 (-3)" → cardTotal=70)
8. Par values: read from Par row
9. Return ONLY valid JSON, no markdown. Never guess an unreadable value; use null and explain it in "uncertain".

${isAuto ? `AUTOMATIC LAYOUT DETECTION:
- If one image contains 2 players with 18 holes, detectedMode="1card-2p".
- If one image contains 4 players with 18 holes, detectedMode="1card-4p".
- If two images contain 2 players each with 18 holes, detectedMode="2card-4p".
- If two images contain the same players split into front/back 9 holes, detectedMode="2card-split".
- Count the visible player sections and hole numbers before reading scores.` : isSplit ? `TWO IMAGES PROVIDED:
- Image 1: holes 1-9 for all ${playerCount} players
- Image 2: holes 10-18 for all ${playerCount} players
- Combine both images by player and hole` : isMulti ? `TWO IMAGES PROVIDED:
- Image 1: Players 1 and 2
- Image 2: Players 3 and 4
- Combine into a single result with ${playerCount} players` : `ONE IMAGE: Contains ${playerCount} players`}

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
  "cardTotal": [70, 77, 80, 81],
  "detectedMode": "1card-4p",
  "uncertain": []
}

rawScores[playerIndex] = 18 values in order (holes 1-18).
cardTotal = the total score shown next to each player name.
Return exactly one detectedMode: "1card-2p", "1card-4p", "2card-4p", or "2card-split".
The players and rawScores arrays must have the same length.`

  const imageBlocks = images.map(img => ({
    type: 'image' as const,
    source: { type: 'base64' as const, media_type: img.mimeType as any, data: img.base64 },
  }))

  const userTextMap: Record<string,string> = {
    auto: 'Inspect the image count, player sections, and hole ranges first. Automatically determine the layout, set detectedMode, then read all Score rows. Return JSON only.',
    '1card-4p':    'Read Score rows for ALL 4 players. 1 image, 4 players, 18 holes each. Return JSON only.',
    '2card-4p':    'Read Score rows for ALL 4 players. Image1=players1&2 (18 holes each), Image2=players3&4 (18 holes each). Return JSON only.',
    '2card-split': 'Read Score rows from BOTH images. Image1=holes1-9 for all players, Image2=holes10-18 for all players. Combine into 18 holes. Return JSON only.',
    '1card-2p':    'Read Score rows for both players. 1 image, 2 players, 18 holes each. Return JSON only.',
  }
  const userText = userTextMap[cardMode] || userTextMap.auto

  const content = await callClaude(apiKey, {
    model: 'claude-sonnet-4-6',
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
// STEP 2: 변환 — diff → 실제 타수 (코드에서 결정적으로 계산)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export function step2_convert(raw: any): any {
  const players = Array.isArray(raw?.players)
    ? raw.players.map((name: unknown) => String(name || '이름 미상'))
    : []
  const pars = Array.isArray(raw?.pars) ? raw.pars : []
  const rawScores = Array.isArray(raw?.rawScores) ? raw.rawScores : []
  if (!players.length || players.length > 4 || pars.length !== 18 || rawScores.length !== players.length) {
    throw new Error('OCR 결과의 플레이어 수, Par 수 또는 스코어 행이 올바르지 않습니다')
  }
  if (rawScores.some((scores: unknown) => !Array.isArray(scores) || scores.length !== 18)) {
    throw new Error('각 플레이어의 OCR 스코어는 18홀이어야 합니다')
  }
  if (pars.some((par: unknown) => !Number.isInteger(par) || Number(par) < 3 || Number(par) > 6)) {
    throw new Error('OCR 결과에 유효하지 않은 Par 값이 있습니다')
  }
  const holes = pars.map((par: number, holeIndex: number) => {
    const diffs = rawScores.map((scores: unknown[]) => {
      const diff = scores?.[holeIndex]
      if (!Number.isInteger(diff) || Number(diff) < -5 || Number(diff) > 10) {
        throw new Error(`홀 ${holeIndex + 1}의 OCR 타수 차이가 유효하지 않습니다`)
      }
      return Number(diff)
    })
    return { hole: holeIndex + 1, par, scores: diffs.map((diff: number) => par + diff), diffs }
  })
  const totals = {
    out: players.map((_: string, pi: number) => holes.slice(0, 9).reduce((sum: number, hole: any) => sum + hole.scores[pi], 0)),
    in: players.map((_: string, pi: number) => holes.slice(9).reduce((sum: number, hole: any) => sum + hole.scores[pi], 0)),
    total: players.map((_: string, pi: number) => holes.reduce((sum: number, hole: any) => sum + hole.scores[pi], 0)),
  }
  return {
    scoreFormat: 'diff', players, holes, totals,
    cardTotals: { total: Array.isArray(raw.cardTotal) ? raw.cardTotal : [] },
    detectedMode: raw.detectedMode || 'unknown',
    uncertain: Array.isArray(raw.uncertain) ? raw.uncertain : [],
  }
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
  if (holes.length !== 18) warnings.push(`홀 데이터가 ${holes.length}개입니다. 18개인지 확인하세요.`)
  if (parsed.uncertain?.length) warnings.push(`OCR 불확실 항목 ${parsed.uncertain.length}개를 확인하세요.`)
  if (!['1card-2p', '1card-4p', '2card-4p', '2card-split'].includes(parsed.detectedMode)) {
    warnings.push('AI가 카드 구성을 확정하지 못했습니다. 원본을 확인하세요.')
  }

  players.forEach((player: string, pi: number) => {
    const allSum = holes.reduce((s: number, h: any) => s + (h.scores?.[pi] ?? 0), 0)
    const outSum = holes.filter((h: any) => h.hole <= outCount).reduce((s: number, h: any) => s + (h.scores?.[pi] ?? 0), 0)
    const inSum  = holes.filter((h: any) => h.hole > outCount).reduce((s: number, h: any) => s + (h.scores?.[pi] ?? 0), 0)
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
// API 키 검증 미들웨어 — 앱/웹에서 보내는 x-app-key 헤더 확인
function verifyAppKey(c: any): boolean {
  const appKey = c.env?.APP_API_KEY
  if (!appKey) return true // 키 미설정 시 통과 (개발 환경)
  const provided = c.req.header('x-app-key') || ''
  return provided === appKey
}

app.post('/api/analyze', async (c) => {
  if (!verifyAppKey(c)) return c.json({ error: 'Unauthorized' }, 401)

  const ANTHROPIC_API_KEY = c.env?.ANTHROPIC_API_KEY || ''
  if (!ANTHROPIC_API_KEY) return c.json({ error: 'ANTHROPIC_API_KEY is not configured' }, 500)

  try {
    const body = await c.req.json()
    const { imageBase64, mimeType = 'image/jpeg', imageBase64_2, mimeType2, cardMode = 'auto' } = body
    if (!imageBase64) return c.json({ error: 'No image data provided' }, 400)
    const validModes = ['auto', '1card-4p', '2card-4p', '2card-split', '1card-2p']
    if (!validModes.includes(cardMode)) return c.json({ error: 'Unsupported card mode' }, 400)
    if (![mimeType, mimeType2].filter(Boolean).every((mime: string) => ['image/jpeg', 'image/png', 'image/webp'].includes(mime))) {
      return c.json({ error: 'Only JPEG, PNG, and WebP images are supported' }, 400)
    }
    if (typeof imageBase64 !== 'string' || imageBase64.length > 12_000_000 || (imageBase64_2 && imageBase64_2.length > 12_000_000)) {
      return c.json({ error: 'Image is too large. Please upload a smaller image.' }, 413)
    }

    const images: { base64: string; mimeType: string }[] = [
      { base64: imageBase64, mimeType },
      ...(imageBase64_2 ? [{ base64: imageBase64_2, mimeType: mimeType2 || 'image/jpeg' }] : [])
    ]

    console.log(`Step1: OCR (Sonnet) ${images.length}장, mode=${cardMode}...`)
    const raw = await step1_extract(ANTHROPIC_API_KEY, images, cardMode)

    console.log('Step2: Convert (Haiku)...')
    const converted = step2_convert(raw)

    const warnings = validate(converted)

    return c.json({
      success: true,
      data: converted,
      warnings,
      debug: {
        scoreFormat: converted.scoreFormat,
        detectedMode: converted.detectedMode,
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
