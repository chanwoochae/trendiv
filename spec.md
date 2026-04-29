# Trendiv v2 시스템 스펙 문서

> **작성일**: 2026-02-10  
> **버전**: 2.0.0-draft  
> **목표**: Cloud Run 단일 서버 → 로컬 PC + Oracle Cloud 분산 아키텍처로 전환

---

## 1. 시스템 개요

### 1.1 한줄 요약

AI 기반 글로벌 웹/모바일 개발 트렌드 수집 → 분석 → 뉴스레터 발송 자동화 파이프라인.

### 1.2 v1 → v2 변경 요약

| 항목            | v1                          | v2                                                  |
| --------------- | --------------------------- | --------------------------------------------------- |
| 수집 (Scraping) | Cloud Run 내 Playwright     | **로컬 PC** (Playwright + Readability.js + Ollama)  |
| 분석 (Analysis) | Cloud Run 내 Gemini + Grok  | **Oracle Cloud** (Gemini 3 + Grok 4.1 + Kimi K2.5)  |
| 콘텐츠 정제     | 분석 시 Playwright로 재방문 | **로컬 PC** (Ollama Llama 3.2 Vision으로 사전 정제) |
| 상태 흐름       | RAW → ANALYZED              | RAW → SCRAPED → COLLECTED → ANALYZED                |
| 호스팅          | Google Cloud Run (Docker)   | Oracle Cloud Free Tier (ARM)                        |
| 프론트엔드      | Cloudflare Pages            | **유지**                                            |
| DB              | Supabase                    | **유지**                                            |

### 1.3 핵심 원칙

1. **비용 최소화**: 무료 티어 우선, 로컬 GPU 최대 활용
2. **배치 처리**: VRAM 효율을 위해 Phase A/B 분리
3. **느슨한 결합**: 로컬 PC ↔ Oracle 직접 통신 없음, Supabase가 중간 허브
4. **안전장치**: 무한루프 방지, Budget 알림, 에러 시 상태 보존

---

## 2. 전체 아키텍처

```
┌─────────────────────────────────────────────────────┐
│ 🖥️ 로컬 PC (Windows 11)                              │
│ CPU: Ryzen 9 7900 | RAM: 64GB | GPU: RTX 4070S 12GB │
│                                                     │
│  Phase A: 수집 (VRAM 0GB)                            │
│  ├─ scrapeAll() → title/link/date 수집               │
│  ├─ Playwright (headless=false) → 각 URL 방문         │
│  ├─ Readability.js → 본문 추출                        │
│  ├─ 키워드 차단 체크 → 차단 시 스크린샷 저장           │
│  └─ Supabase 저장 (content_raw, status: SCRAPED)     │
│                                                     │
│  Phase B: 정제 (VRAM 8~10GB)                         │
│  ├─ Ollama Llama 3.2 Vision 11B 로딩 (1회)           │
│  ├─ content_raw → 노이즈 제거 → content              │
│  ├─ 애매한 차단 케이스 스크린샷 재확인                  │
│  └─ Supabase 저장 (content, status: COLLECTED)       │
│                                                     │
│  Discord Bot: 차단 알림/수동 처리                      │
│  원격 접속: Chrome Remote Desktop                     │
└──────────────────┬──────────────────────────────────┘
                   │ (Supabase를 통한 간접 통신)
                   ▼
┌─────────────────────────────────────────────────────┐
│ 🗄️ Supabase                                         │
│  ├─ trend 테이블 (content_raw + content)             │
│  ├─ analysis_results (JSONB)                        │
│  ├─ subscriber 테이블                                │
│  └─ Auth (Google OAuth)                             │
└──────────────────┬──────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────┐
│ ☁️ Oracle Cloud (춘천, ARM 4 OCPU / 24GB)            │
│                                                     │
│  Pipeline Controller (PM2, Port 3000)               │
│  ├─ Cron: status=COLLECTED 조회 → 분석 API 호출       │
│  ├─ Gemini 3 Flash (메인, 대량)                      │
│  ├─ Gemini 3 Pro (심층)                              │
│  ├─ Grok 4.1 Fast Reasoning (X 전용)                 │
│  ├─ Kimi K2.5 (보조/멀티모달)                         │
│  ├─ 결과 저장 (status: ANALYZED / REJECTED)           │
│  ├─ 뉴스레터 발송 (Resend)                            │
│  └─ REST API (/api/trends 등)                        │
└─────────────────────────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────┐
│ 🌐 Cloudflare Pages                                 │
│  └─ trendiv-web (SvelteKit + Tailwind CSS v4)       │
└─────────────────────────────────────────────────────┘
```

---

## 3. 데이터 상태 흐름 (Status Lifecycle)

### 3.1 상태 정의

| Status      | 의미                                      | 어디서 설정      | 다음 상태           |
| ----------- | ----------------------------------------- | ---------------- | ------------------- |
| `RAW`       | title/link/date만 존재                    | Phase A (Step 1) | SCRAPED             |
| `SCRAPED`   | content_raw 수집 완료 (원본 텍스트)       | Phase A (Step 3) | COLLECTED           |
| `COLLECTED` | Llama가 content 정제 완료 (깨끗한 텍스트) | Phase B          | ANALYZED / REJECTED |
| `ANALYZED`  | AI 분석 완료, 점수 > 0                    | Oracle Pipeline  | (최종)              |
| `REJECTED`  | AI 분석 완료, 점수 = 0 또는 품질 미달     | Oracle Pipeline  | (최종)              |
| `FAIL`      | 분석 실패 (API 오류 등)                   | Oracle Pipeline  | RAW로 재시도 가능   |

### 3.2 상태 전이 다이어그램

```
                    로컬 PC                          Oracle Cloud
              ┌─────────────────┐            ┌─────────────────────┐
              │                 │            │                     │
  신규 수집 → │  RAW ──→ SCRAPED ──→ COLLECTED ──→ ANALYZED        │
              │                 │            │    │                │
              │                 │            │    └→ REJECTED      │
              │                 │            │                     │
              └─────────────────┘            └─────────────────────┘

  예외 케이스:
  - YouTube: RAW → SCRAPED (콘텐츠 수집 불필요, transcript는 분석 시 처리)
  - X (Twitter): RAW → SCRAPED (Grok이 title+link만으로 분석)
  - 차단된 URL: RAW 유지 → Discord 알림 → 수동 처리 후 재시도
```

### 3.3 카테고리별 처리 방식

| 카테고리                    | 수집 방식         | 콘텐츠 수집              | 분석 모델        |
| --------------------------- | ----------------- | ------------------------ | ---------------- |
| 블로그 (CSS-Tricks, MDN 등) | RSS               | Playwright + Readability | Gemini Flash/Pro |
| Reddit, Hacker News         | RSS               | Playwright + Readability | Gemini Flash/Pro |
| StackOverflow               | API               | API 응답 자체            | Gemini Flash/Pro |
| YouTube                     | RSS + API         | 스킵 (transcript 사용)   | Gemini Flash/Pro |
| X (Twitter)                 | Google Search API | 스킵 (Grok 직접 분석)    | Grok 4.1         |

---

## 4. 데이터베이스 스키마

### 4.1 trend 테이블

| 컬럼               | 타입          | 설명                           | v2 변경                    |
| ------------------ | ------------- | ------------------------------ | -------------------------- |
| `id`               | BIGINT (PK)   | 자동 증가 ID                   | -                          |
| `title`            | TEXT          | 원문 제목                      | -                          |
| `link`             | TEXT (UNIQUE) | 원문 URL                       | -                          |
| `date`             | TIMESTAMPTZ   | 게시일                         | -                          |
| `source`           | TEXT          | 세부 출처 (예: "Kevin Powell") | -                          |
| `category`         | TEXT          | 플랫폼 (예: "YouTube", "X")    | -                          |
| `status`           | TEXT          | 처리 상태                      | ✅ SCRAPED, COLLECTED 추가 |
| `content_raw`      | TEXT          | Phase A 원본 텍스트            | ✅ 신규                    |
| `content`          | TEXT          | Phase B 정제된 텍스트          | -                          |
| `analysis_results` | JSONB         | AI 분석 히스토리 배열          | -                          |
| `represent_result` | JSONB         | 대표 분석 결과 (최고 점수)     | -                          |
| `created_at`       | TIMESTAMPTZ   | 레코드 생성일                  | -                          |

### 4.2 analysis_results JSONB 구조

```json
[
  {
    "aiModel": "gemini-3-flash-preview",
    "score": 8,
    "reason": "최신 CSS :has() 셀렉터 활용법을 심층적으로 다룸",
    "title_ko": "CSS :has() 셀렉터 완벽 가이드",
    "oneLineSummary": "부모 선택이 가능해진 CSS :has()의 실전 활용 패턴 12가지",
    "keyPoints": [
      "부모 셀렉터 기본 문법",
      "폼 유효성 스타일링",
      "다크모드 토글"
    ],
    "tags": ["CSS", "Selectors", "Modern CSS"],
    "analyzedAt": "2026-02-10T09:00:00Z"
  },
  {
    "aiModel": "grok-4-1-fast-reasoning",
    "score": 7,
    "reason": "...",
    "...": "..."
  }
]
```

### 4.3 마이그레이션 SQL

```sql
-- v2 신규 컬럼
ALTER TABLE trend ADD COLUMN IF NOT EXISTS content_raw TEXT;

-- status 인덱스 (자주 필터링)
CREATE INDEX IF NOT EXISTS idx_trend_status ON trend(status);

-- content_raw 정리 (운영 안정화 후)
-- UPDATE trend SET content_raw = NULL WHERE status = 'ANALYZED';
```

---

## 5. 모듈 구조

### 5.1 모노레포 구성

```
trendiv/
├── trendiv-pipeline-controller/   # Oracle에서 실행
│   ├── src/
│   │   ├── index.ts               # Express 서버 + 스케줄러 초기화
│   │   ├── scheduler.ts           # Cron 스케줄 정의
│   │   └── services/
│   │       └── pipeline.service.ts # 분석 파이프라인 로직
│   └── package.json
│
├── trendiv-scraper-module/        # 로컬 PC에서 실행
│   ├── src/
│   │   ├── index.ts               # scrapeAll() 메인 함수
│   │   ├── config/targets.ts      # 수집 대상 목록
│   │   ├── scrapers/              # RSS, HTML, YouTube, Google 등
│   │   └── scripts/
│   │       ├── phase-a-collect.ts  # ✅ v2 Phase A 스크립트
│   │       └── phase-b-refine.ts   # ✅ v2 Phase B 스크립트
│   └── package.json
│
├── trendiv-analysis-module/       # Oracle에서 실행 (pipeline에서 import)
│   ├── src/
│   │   ├── index.ts               # runAnalysis() 메인 함수
│   │   └── services/
│   │       ├── gemini.service.ts   # Gemini API
│   │       ├── grok.service.ts     # Grok API
│   │       ├── browser.service.ts  # Playwright (콘텐츠 fetch)
│   │       └── content.service.ts  # YouTube/Web 분기
│   └── package.json
│
├── trendiv-result-module/         # Oracle에서 실행 (뉴스레터 HTML 생성)
│   └── src/
│
├── trendiv-web/                   # Cloudflare Pages
│   └── src/                       # SvelteKit + Tailwind CSS v4
│
├── pnpm-workspace.yaml
└── .env                           # 공통 환경변수
```

### 5.2 모듈별 실행 위치

| 모듈                        | 실행 위치          | 실행 방법                      |
| --------------------------- | ------------------ | ------------------------------ |
| trendiv-scraper-module      | 로컬 PC (Windows)  | Cron / 수동 실행               |
| trendiv-pipeline-controller | Oracle Cloud (ARM) | PM2 (상시 실행)                |
| trendiv-analysis-module     | Oracle Cloud       | pipeline-controller에서 import |
| trendiv-result-module       | Oracle Cloud       | pipeline-controller에서 import |
| trendiv-web                 | Cloudflare Pages   | 자동 배포 (Git push)           |

---

## 6. Phase A: 수집 스크립트 상세

### 6.1 실행 흐름

```
Step 1: scrapeAll("weekly") → title/link/date 수집
  ↓
Step 2: Supabase에 RAW 저장 (upsert, 중복 스킵)
  ↓
Step 3: RAW 상태 항목 조회
  ↓
Step 4: 각 URL을 Playwright로 방문
  ├─ Readability.js로 본문 추출
  ├─ 실패 시 innerText 폴백
  ├─ 키워드 차단 체크 → 차단 시 스크린샷 + 스킵
  └─ content_raw 저장, status → SCRAPED
  ↓
예외: YouTube/X는 바로 SCRAPED 처리
```

### 6.2 키워드 차단 목록

```typescript
const BLOCK_KEYWORDS = [
  "access denied",
  "blocked",
  "forbidden",
  "captcha",
  "security check",
  "cloudflare",
  "ray id",
  "verify you are human",
  "please wait",
  "checking your browser",
  "error 1020",
  "error 403",
  "403 forbidden",
  "503 service",
  "attention required",
  "just a moment",
  "enable javascript and cookies",
];
```

### 6.3 실행 명령

```bash
# 테스트 (DB 저장 없이)
npx ts-node src/scripts/phase-a-collect.ts --dry-run

# 실제 실행
npx ts-node src/scripts/phase-a-collect.ts
```

---

## 7. Phase B: 정제 스크립트 상세

### 7.1 실행 흐름

```
Step 1: SCRAPED 상태 항목 조회 (content_raw 존재)
  ↓
Step 2: Ollama Llama 3.2 Vision 11B 로딩 (1회)
  ↓
Step 3: 각 content_raw를 Llama로 정제
  ├─ nav, footer, ad, sidebar 등 노이즈 제거
  ├─ 본문 구조 정리
  └─ content 컬럼에 저장, status → COLLECTED
  ↓
Step 4: 콘텐츠 너무 짧은 항목 → 스크린샷으로 차단 재확인
  ↓
Step 5: Llama 언로드 (VRAM 해제)
```

### 7.2 VRAM 운용

| Phase    | 사용 VRAM | 여유 VRAM | 비고                 |
| -------- | --------- | --------- | -------------------- |
| A (수집) | 0GB       | 12GB 전체 | Playwright만 사용    |
| B (정제) | 8~10GB    | 2~4GB     | Llama 3.2 Vision 11B |

### 7.3 실행 명령

```bash
# Phase B (Phase A 완료 후 실행)
npx ts-node src/scripts/phase-b-refine.ts
```

---

## 8. Oracle Cloud 분석 파이프라인

### 8.1 스케줄 (Cron)

| 시간 (KST) | 작업                               | 모델           |
| ---------- | ---------------------------------- | -------------- |
| 09:00      | 메인 파이프라인 (COLLECTED → 분석) | Gemini 3 Flash |
| 10:30      | 심층 분석 (ANALYZED 재분석)        | Gemini 3 Pro   |
| 10:45      | X(Twitter) 분석 + 일반 재분석      | Grok 4.1       |

### 8.2 분석 모델 라인업

| 모델                    | 용도               | 비용           |
| ----------------------- | ------------------ | -------------- |
| Gemini 3 Flash          | 메인 대량 분석     | 무료 티어      |
| Gemini 3 Pro            | 심층 분석 (고품질) | 유료 (소량)    |
| Grok 4.1 Fast Reasoning | X(Twitter) 전용    | 별도 과금      |
| Kimi K2.5               | 보조/멀티모달      | $0.60/1M input |

### 8.3 분석 → 상태 결정 로직

```
분석 결과 수신
  ├─ 모든 모델의 score > 0 → status: ANALYZED
  ├─ 하나라도 score = 0 → status: REJECTED
  └─ API 오류 → status: FAIL (다음 실행 시 재시도)
```

---

## 9. API 엔드포인트

### 9.1 Pipeline Controller (Oracle, Port 3000)

| Method | Path                | 설명                             |
| ------ | ------------------- | -------------------------------- |
| GET    | `/`                 | 헬스 체크                        |
| GET    | `/api/trends`       | 트렌드 목록 (페이지네이션, 필터) |
| POST   | `/api/pipeline/run` | 파이프라인 수동 실행             |

### 9.2 /api/trends 쿼리 파라미터

| 파라미터        | 타입   | 기본값   | 설명                        |
| --------------- | ------ | -------- | --------------------------- |
| `page`          | number | 1        | 페이지 번호                 |
| `limit`         | number | 20       | 페이지당 항목 수 (max 100)  |
| `searchKeyword` | string | null     | 검색어                      |
| `category`      | string | null     | 카테고리 필터 (콤마 구분)   |
| `tagFilter`     | string | null     | 태그 필터 (콤마 구분)       |
| `sortBy`        | string | "latest" | 정렬 (latest / score / old) |
| `minScore`      | number | 0        | 최소 점수 필터              |
| `startDate`     | string | null     | 시작일                      |
| `endDate`       | string | null     | 종료일                      |

---

## 10. 환경변수

### 10.1 공통 (.env)

```env
# Supabase
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_KEY=eyJ...

# AI Models
GEMINI_API_KEY=AIza...
GEMINI_MODEL=gemini-3-flash-preview
GEMINI_MODEL_PRO=gemini-3-pro-preview
GROK_API_KEY=xai-...
GROK_MODEL=grok-4-1-fast-reasoning

# Email
RESEND_API_KEY=re_...

# Google APIs
GOOGLE_SEARCH_API_KEY=AIza...
GOOGLE_SEARCH_CX=xxx

# App
ENABLE_SCHEDULE=true
FRONTEND_URL=https://trendiv.org
```

### 10.2 로컬 PC 전용

```env
OLLAMA_URL=http://localhost:11434
DISCORD_BOT_TOKEN=xxx
```

---

## 11. 인프라

### 11.1 Oracle Cloud

| 항목            | 값                        |
| --------------- | ------------------------- |
| 리전            | 춘천 (ap-chuncheon-1)     |
| Shape           | VM.Standard.A1.Flex (ARM) |
| OCPU            | 4                         |
| Memory          | 24GB                      |
| Boot Volume     | 47GB                      |
| OS              | Oracle Linux 9            |
| 프로세스 매니저 | PM2                       |
| Node.js         | v22 LTS                   |
| 패키지 매니저   | pnpm                      |

### 11.2 비용 관리

- Budget 알림: $0.01 설정
- Always Free 범위: ARM 4 OCPU / 24GB, 부트볼륨 100GB, 트래픽 10TB/월
- Load Balancer: 1개 무료 (미사용)
- Block Volume: 100GB 합산 무료

### 11.3 SSH 접속

```bash
chmod 600 ~/Downloads/ssh-key-2026-02-08.key
ssh -i ~/Downloads/ssh-key-2026-02-08.key opc@{Public IP}
```

---

## 12. Discord Bot (예정)

### 12.1 명령어

| 명령어        | 동작                       |
| ------------- | -------------------------- |
| `!list`       | 차단된 사이트 큐 목록      |
| `!retry`      | 큐의 사이트 재시도         |
| `!done`       | 수동 처리 완료 → 수집 재개 |
| `!skip [url]` | 특정 사이트 스킵           |
| `!status`     | 현재 수집 현황             |

---

## 13. 프론트엔드 (trendiv-web)

### 13.1 기술 스택

- **Framework**: SvelteKit (Svelte 5 Runes)
- **스타일링**: Tailwind CSS v4 (CSS 변수 컬러 시스템)
- **배포**: Cloudflare Pages
- **인증**: Supabase Google OAuth

### 13.2 데이터 조회

프론트엔드는 Oracle 서버의 `/api/trends`를 호출하여 `status: ANALYZED` 항목만 표시.

---

## 14. 마이그레이션 체크리스트

### Phase 0: 인프라 (✅ 완료)

- [x] Oracle ARM 인스턴스 생성 (4 OCPU / 24GB)
- [x] Node.js + pnpm + PM2 설치
- [x] 코드 클론 + 빌드 + .env 설정
- [x] PM2 자동 재시작 설정
- [x] Budget 알림 설정 ($0.01)

### Phase 1: 로컬 수집 (🔄 진행 중)

- [x] Supabase content_raw 컬럼 추가
- [x] Phase A 스크립트 작성
- [x] Readability.js 연동
- [ ] X/YouTube 스킵 처리 완료
- [ ] Phase A 실제 실행 + 검증
- [ ] Phase B 스크립트 작성 (Ollama 연동)
- [ ] Phase B 실행 + 검증

### Phase 2: Oracle 파이프라인 전환

- [ ] pipeline.service.ts: COLLECTED 기준으로 분석 대상 조회 변경
- [ ] 수집(scrapeAll) 로직 제거 (Oracle에서 더 이상 수집 안 함)
- [ ] Kimi K2.5 서비스 추가
- [ ] Cron 스케줄 업데이트
- [ ] 배포 + 테스트

### Phase 3: Discord Bot

- [ ] 차단 알림 기능
- [ ] !list, !retry, !done, !skip, !status 구현
- [ ] Chrome Remote Desktop 설정

### Phase 4: 안정화

- [ ] 로컬 Cron 설정 (Windows Task Scheduler)
- [ ] content_raw 정리 (ANALYZED 항목 NULL 처리)
- [ ] Admin 페이지
- [ ] 대안 LLM 비교 (Qwen 2.5 VL, Gemma 3)

---

## 부록: 수집 대상 (targets.ts)

### Social & Community

| 이름                          | 카테고리      | 수집 방식         |
| ----------------------------- | ------------- | ----------------- |
| X (Twitter)                   | X             | Google Search API |
| Hacker News                   | Hacker News   | RSS               |
| Reddit (css+html+a11y)        | Reddit        | RSS               |
| Reddit (androiddev)           | Reddit        | RSS               |
| StackOverflow (ios+swift)     | StackOverflow | RSS               |
| StackOverflow (css+html+a11y) | StackOverflow | API               |

### YouTube

| 이름                     | 수집 방식        |
| ------------------------ | ---------------- |
| Kevin Powell             | RSS (채널)       |
| Google Chrome Developers | RSS (채널)       |
| Hyperplexed              | RSS (채널)       |
| Deque Systems            | RSS (채널)       |
| TPGi                     | RSS (채널)       |
| YouTube Search (키워드)  | YouTube Data API |

### Official Blogs

| 이름               | 수집 방식  |
| ------------------ | ---------- |
| MDN Web Docs       | RSS        |
| CSS-Tricks         | RSS        |
| Smashing Magazine  | RSS        |
| Apple Developer    | RSS        |
| iOS Dev Weekly     | RSS        |
| Swift.org          | RSS (Atom) |
| Android Developers | RSS        |
| Android Weekly     | RSS        |
| Kotlin Blog        | RSS        |
| XDA Developers     | RSS        |
| React Blog         | RSS        |
| Vercel Blog        | RSS (Atom) |
