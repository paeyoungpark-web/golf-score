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
2. Butterfly/flower icons on the scorecard represent BIRDIE (-1 under par). Interpret them as birdie scores.
3. After extracting scores, VERIFY: each player's total must equal the sum of their individual hole scores. If there's a mismatch, correct individual hole scores to match the total shown.
4. Return ONLY valid JSON with NO markdown, NO code blocks, NO explanation.
5. Always include the "diffs" field (score minus par for each hole).
6. Par values must be realistic: 3, 4, or 5 for each hole.
7. Eagle = -2 under par, Birdie = -1, Par = 0, Bogey = +1, Double = +2, Triple = +3.

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
    "out": [scores for holes 1-9],
    "in": [scores for holes 10-18],
    "total": [total scores]
  }
}

VERIFICATION STEP: Before returning, confirm that sum(holes[i].scores[j] for all i) == totals.total[j] for each player j.`

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
                text: 'Please analyze this golf scorecard. Extract ALL player names exactly as written (Korean names preferred). Remember: butterfly/flower symbols = birdie. Verify totals match sum of holes.',
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
