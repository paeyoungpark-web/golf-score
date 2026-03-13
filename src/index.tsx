import { Hono } from 'hono'
import { cors } from 'hono/cors'

type Bindings = {
  OPENAI_API_KEY: string
  ASSETS: Fetcher
}

const app = new Hono<{ Bindings: Bindings }>()

app.use('*', cors())

app.post('/api/analyze', async (c) => {
  const OPENAI_API_KEY = c.env?.OPENAI_API_KEY || ''

  if (!OPENAI_API_KEY) {
    return c.json({ error: 'OPENAI_API_KEY is not configured' }, 500)
  }

  try {
    const body = await c.req.json()
    const { imageBase64, mimeType = 'image/jpeg' } = body

    if (!imageBase64) {
      return c.json({ error: 'No image data provided' }, 400)
    }

    const systemPrompt = `You are an expert golf scorecard analyzer. Your job is to extract golf scores from scorecard images with 100% accuracy.

CRITICAL RULES:
1. PLAYER NAMES: Extract the ACTUAL names written on the scorecard. Look for Korean names (e.g. 김철수, 이영희) or any names written in the name/성명 column. Do NOT use generic names like "Player1".

2. SCORE FORMAT DETECTION — THIS IS THE MOST IMPORTANT STEP:
   Some scorecards show ACTUAL STROKES (e.g. 4, 5, 6, 7...)
   Other scorecards show DIFF FROM PAR (e.g. 0=par, 1=bogey, -1=birdie, 2=double, -2=eagle)
   
   HOW TO DETECT:
   - If most values are small numbers like -2, -1, 0, 1, 2, 3 → it is DIFF FORMAT
   - If most values are large numbers like 3, 4, 5, 6, 7, 8 → it is STROKE FORMAT
   - Butterfly/flower icon always means BIRDIE = diff of -1
   - If the scorecard shows a column total like "85" or "79" and individual values are small → DIFF FORMAT
   
   IF DIFF FORMAT: Convert to actual strokes → actual_score = par + diff
   Example: par=4, diff=0 → score=4 / par=4, diff=1 → score=5 / par=4, diff=-1 → score=3
   Example: par=3, diff=-1 (butterfly) → score=2

3. TOTALS: Extract the OUT (전반), IN (후반), and TOTAL values EXACTLY as shown on the card. These are used to verify accuracy.

4. VERIFICATION: After converting, check: sum of hole scores == card total for each player. If not matching, re-examine format detection.

5. Return ONLY valid JSON with NO markdown, NO code blocks, NO explanation.
6. Always include the "diffs" field (actual_score minus par for each hole).
7. Par values must be realistic: 3, 4, or 5 for each hole.
8. Final scores in "scores" field must ALWAYS be actual strokes (never diffs). Minimum score per hole is 1.

JSON FORMAT:
{
  "courseName": "string or null",
  "date": "string or null",
  "players": ["이름1", "이름2", "이름3", "이름4"],
  "holes": [
    {
      "hole": 1,
      "par": 4,
      "scores": [5, 4, 6, 4],
      "diffs": [1, 0, 2, 0]
    }
  ],
  "totals": {
    "out": [41, 41, 55, 50],
    "in": [44, 42, 57, 52],
    "total": [85, 83, 112, 102]
  }
}`

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: 4096,
        messages: [
          {
            role: 'system',
            content: systemPrompt,
          },
          {
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: {
                  url: `data:${mimeType};base64,${imageBase64}`,
                  detail: 'high',
                },
              },
              {
                type: 'text',
                text: 'Analyze this golf scorecard. FIRST detect if scores are diff-from-par or actual strokes by checking if individual values are small (-2~3) or large (3~8). Extract player names exactly as written in Korean. Convert diffs to actual strokes. Extract OUT/IN/TOTAL exactly from the card.',
              },
            ],
          },
        ],
      }),
    })

    if (!response.ok) {
      const errorData = await response.text()
      console.error('OpenAI API error:', errorData)
      return c.json({ error: `OpenAI API error: ${response.status}` }, 500)
    }

    const data = await response.json() as any
    const content = data.choices?.[0]?.message?.content

    if (!content) {
      return c.json({ error: 'No response from AI' }, 500)
    }

    let parsed: any
    try {
      const cleaned = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
      parsed = JSON.parse(cleaned)
    } catch (e) {
      return c.json({ error: 'Failed to parse AI response as JSON', raw: content }, 500)
    }

    // ── 서버사이드 검증 ──────────────────────────────────────
    const warnings: string[] = []
    const players: string[] = parsed.players || []
    const holes: any[] = parsed.holes || []
    const totals = parsed.totals || {}
    const outCount = 9

    players.forEach((player: string, pi: number) => {
      const allSum = holes.reduce((s: number, h: any) => s + (h.scores?.[pi] || 0), 0)
      const outSum = holes.filter((h: any) => h.hole <= outCount).reduce((s: number, h: any) => s + (h.scores?.[pi] || 0), 0)
      const inSum  = holes.filter((h: any) => h.hole > outCount).reduce((s: number, h: any) => s + (h.scores?.[pi] || 0), 0)

      const cardTotal = totals.total?.[pi]
      const cardOut   = totals.out?.[pi]
      const cardIn    = totals.in?.[pi]

      if (cardTotal !== undefined && allSum !== cardTotal) {
        warnings.push(`${player}: 전체 합계 불일치 — 홀 합산 ${allSum} ≠ 카드 합계 ${cardTotal}`)
      }
      if (cardOut !== undefined && outSum !== cardOut) {
        warnings.push(`${player}: 전반(OUT) 불일치 — 홀 합산 ${outSum} ≠ 카드 OUT ${cardOut}`)
      }
      if (cardIn !== undefined && inSum !== cardIn) {
        warnings.push(`${player}: 후반(IN) 불일치 — 홀 합산 ${inSum} ≠ 카드 IN ${cardIn}`)
      }
    })

    return c.json({ success: true, data: parsed, warnings })

  } catch (err: any) {
    return c.json({ error: err.message || 'Internal server error' }, 500)
  }
})

app.get('/api/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }))

app.get('*', async (c) => {
  return c.env.ASSETS.fetch(c.req.raw)
})

export default app
