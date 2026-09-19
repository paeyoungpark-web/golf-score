# ⛳ Golf Score AI

스코어카드 사진을 AI(Claude Vision)로 인식하고, 타당·배판·니어리스트를 자동 정산하는 앱.

## 플랫폼

- **iOS** — Capacitor 네이티브 앱 (App Store)
- **Android / 웹** — https://golf-score-7xp.pages.dev/
- **Backend** — Hono on Cloudflare Pages Functions

## 기술 스택

- **Frontend** — Vanilla JS, 모바일 퍼스트 탭 UI
- **Backend** — Hono + Cloudflare Pages (`_worker.js`)
- **AI** — Claude Sonnet 4.6 (Anthropic API)
- **Native** — Capacitor (iOS)

---

## 🚀 로컬 개발

```bash
npm install
cp .dev.vars.example .dev.vars   # API 키 설정
npm run dev                       # http://localhost:8788
```

### 환경 변수 (.dev.vars)

| 변수 | 설명 | 필수 |
|------|------|------|
| `ANTHROPIC_API_KEY` | Anthropic API 키 | ✅ |
| `APP_API_KEY` | 앱 인증키 (API 보호) | 선택 |

---

## 📱 iOS 빌드

```bash
npm run build           # 웹 빌드
npx cap sync ios        # iOS 프로젝트에 웹 복사
npx cap open ios        # Xcode 열기
```

Xcode에서 Team 설정 후 빌드 (iOS 14+).

---

## 📦 Cloudflare 배포

```bash
npx wrangler login
npx wrangler pages secret put ANTHROPIC_API_KEY
npx wrangler pages secret put APP_API_KEY
npm run deploy
```

---

## 📁 프로젝트 구조

```
golf-score/
├── src/index.tsx          # Hono 백엔드 (API 라우터)
├── public/index.html      # 프론트엔드 SPA
├── public/manifest.json   # PWA 매니페스트
├── capacitor.config.ts    # Capacitor 설정
├── ios/                   # iOS Xcode 프로젝트
├── dist/                  # 빌드 출력 (gitignored)
├── wrangler.json          # Cloudflare 설정
└── .dev.vars.example      # 환경변수 예시
```

---

## ⚙️ 정산 규칙

| 규칙 | 내용 |
|------|------|
| 기본 | 홀마다 1:1 타수 차이 × 단위금액 |
| 버디 보너스 | 타수 차이 외 +1타 추가 |
| 이글 보너스 | 타수 차이 외 +2타 추가 |
| **배판** | 버디/이글, 트리플+(Par4/5), 더블+(Par3), 3인 동타 시 전체 ×2 |
| **따따블** | 전원 동타 시 다음 홀 타당 ×2 누적 (최대 8배) |
| 니어리스트 | Par3 홀에서 나머지 인원에게 각 1타씩 수령 |

---

## 👤 개발자

**박배영** · 로뎀시스템 · [apps.lupa.kr](https://apps.lupa.kr)
