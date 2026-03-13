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
1. PLAYER NAMES: Extract the ACTUAL names written on the scorecard. Look for Korean names (e.g. 김철수, 이영희) or any names written in the name/성명 column. Do NOT use generic names like "Player1". If names are unclear, make your best guess from visible text.

2. SCORE FORMAT DETECTION — THIS IS THE MOST IMPORTANT STEP:
   Some scorecards show ACTUAL STROKES (e.g. 4, 5, 6, 7...)
   Other scorecards show DIFF FROM PAR (e.g. 0=par, 1=bogey, -1=birdie, 2=double, -2=eagle)
   
   HOW TO DETECT:
   - If most values are small numbers like -2, -1, 0, 1, 2, 3 → it's DIFF FORMAT
   - If most values are large numbers like 3, 4, 5, 6, 7, 8 → it's STROKE FORMAT
   - Butterfly/flower icon always means BIRDIE = diff of -1
   - If the scorecard shows a column total like "85" or "79" and individual values are small → DIFF FORMAT
   
   IF DIFF FORMAT: Convert to actual strokes → actual_score = par + diff
   Example: par=4, diff=0 → score=4 / par=4, diff=1 → score=5 / par=4, diff=-1 → score=3

3. After extracting scores, VERIFY: each player's total must equal the sum of their individual hole scores. If there's a mismatch, re-check whether scores are in diff format and convert accordingly.
4. Return ONLY valid JSON with NO markdown, NO code blocks, NO explanation.
5. Always include the "diffs" field (score minus par for each hole).
6. Par values must be realistic: 3, 4, or 5 for each hole.
7. Eagle = -2 under par, Birdie = -1, Par = 0, Bogey = +1, Double = +2, Triple = +3.
8. Final scores in "scores" field must ALWAYS be actual strokes (never diffs). Minimum score per hole is 1.

JSON FORMAT (return exactly this structure):
{
  "courseName": "string or null",
  "date": "string or null",
  "players": ["실제이름1", "실제이름2", "실제이름3", "실제이름4"],
  "holes": [
    {
      "hole": 1,
      "par": 4,
      "scores": [5, 4, 6, 4],
      "diffs": [1, 0, 2, 0]
    }
  ],
  "totals": {
    "out": [actual stroke totals for holes 1-9],
    "in": [actual stroke totals for holes 10-18],
    "total": [total actual strokes]
  }
}

VERIFICATION STEP: Before returning, confirm sum(holes[i].scores[j] for all i) == totals.total[j] for each player j. If not matching, the scorecard is likely in diff format — convert all scores to actual strokes and recalculate.`

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
                text: 'Please analyze this golf scorecard. FIRST detect if scores are in diff-from-par format or actual stroke format. Extract ALL player names exactly as written (Korean names preferred). Butterfly/flower symbols = birdie = diff of -1. Convert all diffs to actual strokes. Verify totals match sum of hole strokes.',
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

    let parsed
    try {
      const cleaned = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
      parsed = JSON.parse(cleaned)
    } catch (e) {
      return c.json({ error: 'Failed to parse AI response as JSON', raw: content }, 500)
    }

    return c.json({ success: true, data: parsed })
  } catch (err: any) {
    return c.json({ error: err.message || 'Internal server error' }, 500)
  }
})

app.get('/api/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }))

app.get('*', async (c) => {
  return c.env.ASSETS.fetch(c.req.raw)
})

export default app
