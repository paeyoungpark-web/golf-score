# ⛳ Golf Score AI 자동 정산 시스템

GPT-4o Vision으로 골프 스코어카드를 인식하고, 타당 계산·배판·축하금·니어리스트를 자동 정산하는 웹앱.

## 기술 스택

- **Frontend** — Vanilla JS + Canvas API, Glassmorphism Dark Green UI
- **Backend** — Hono on Cloudflare Pages Functions (`_worker.js`)
- **AI** — OpenAI GPT-4o Vision API

---

## 🚀 로컬 개발 시작

### 1. 의존성 설치

```bash
npm install
```

### 2. OpenAI API 키 설정

`.dev.vars.example`을 복사하여 `.dev.vars` 생성:

```bash
cp .dev.vars.example .dev.vars
```

`.dev.vars` 파일에 실제 API 키 입력:

```
OPENAI_API_KEY=sk-...
```

### 3. 빌드 후 로컬 서버 실행

```bash
# 워커 + 정적 파일 빌드
npm run build:all

# Wrangler 로컬 개발 서버 실행 (포트 8788)
npm run dev
```

브라우저에서 `http://localhost:8788` 접속.

---

## 📦 Cloudflare Pages 배포

### 1. Wrangler 로그인

```bash
npx wrangler login
```

### 2. OpenAI API 키 시크릿 등록

```bash
npx wrangler pages secret put OPENAI_API_KEY
```
→ 프롬프트에 `sk-...` 키 입력

### 3. 빌드 및 배포

```bash
npm run deploy
```

이 명령이 다음을 순서대로 실행합니다:
1. `esbuild`로 `src/index.tsx` → `dist/_worker.js` 컴파일
2. `public/` 정적 파일 → `dist/` 복사
3. `wrangler pages deploy dist` 실행

---

## 📁 프로젝트 구조

```
golf-scorer/
├── src/
│   └── index.tsx          # Hono 백엔드 (API 라우터)
├── public/
│   └── index.html         # 프론트엔드 단일 파일 앱
├── dist/                  # 빌드 출력 (gitignored)
│   ├── _worker.js         # 컴파일된 Cloudflare Worker
│   └── index.html         # 정적 파일
├── wrangler.jsonc          # Cloudflare 설정
├── tsconfig.json
├── package.json
└── .dev.vars.example
```

---

## ⚙️ 정산 규칙 요약

| 규칙 | 내용 |
|------|------|
| 기본 | 홀마다 1:1 타수 차이 × 단위금액 |
| 버디 보너스 | 타수 차이 외 +1타 추가 보상 |
| 이글 보너스 | 타수 차이 외 +2타 추가 보상 |
| 버디 vs 이글 | 버디가 이글에게 2타 추가 제공 |
| **배판** | 버디/이글 있거나, 트리플+(Par4/5), 더블+(Par3), 3인 동타 시 **전체 2배** |
| 니어리스트 | Par 3 홀에서 나머지 인원에게 각 1타씩 수령 |

---

## 🔧 환경 변수

| 변수 | 설명 | 필수 |
|------|------|------|
| `OPENAI_API_KEY` | OpenAI API 시크릿 키 | ✅ |
