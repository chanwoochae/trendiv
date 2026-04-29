> **작성일**: 2026-02-09 (v4 — 최종)
> **목표**: Google Cloud Run → Oracle Cloud + 로컬 LLM 기반 수집 파이프라인으로 전환

---

## 1. 현재 → 변경 요약

| 항목              | 현재                      | 변경 후                                          |
| ----------------- | ------------------------- | ------------------------------------------------ |
| **백엔드 호스팅** | Google Cloud Run (Docker) | Oracle Cloud Free Tier (춘천)                    |
| **수집**          | Cloud Run 내 Playwright   | 로컬 PC + Playwright + Ollama (Llama 3.2 Vision) |
| **분석**          | Gemini API + Grok API     | Gemini 3 Flash/Pro + Grok 4.1 + Kimi K2.5        |
| **프론트엔드**    | Cloudflare Pages          | 유지                                             |
| **DB**            | Supabase                  | 유지                                             |

### 1.1 폐기된 방안

- ~~Gemini Nano (Chrome Built-in AI)~~: 미국 지역만 지원, 한국에서 사용 불가
- ~~MoonDream 2 (차단 감지 전용)~~: 배치 처리 방식에서 별도 모델 불필요, 키워드 체크로 대체
- ~~Chrome `channel: 'chrome'` + Persistent Context~~: Gemini Nano 폐기로 불필요

---

## 2. 로컬 PC 스펙

| 항목   | 스펙                                  |
| ------ | ------------------------------------- |
| CPU    | AMD Ryzen 9 7900 12-Core (3.70 GHz)   |
| RAM    | 64GB                                  |
| GPU    | **NVIDIA RTX 4070 SUPER** (12GB VRAM) |
| 저장소 | 3.18 TB                               |
| OS     | Windows 11 (64비트)                   |
| 장치명 | DESKTOP-H6UKEBR (MS-7D76)             |

---

## 3. 전체 아키텍처

```
┌─────────────────────────────────────────────────┐
│ 🖥️ 로컬 PC (Cron 스케줄)                         │
│                                                 │
│  ┌─ Phase A: 수집 타임 (VRAM 0GB) ──────────┐  │
│  │                                           │  │
│  │  Playwright (headless=false)              │  │
│  │  + 키워드 차단 체크 (LLM 없이 즉시 판별)    │  │
│  │  + Readability.js (본문 추출, 실패 시       │  │
│  │    innerText 폴백)                        │  │
│  │                                           │  │
│  │  → 전체 URL 순회                           │  │
│  │  → 정상: content_raw + 스크린샷 저장        │  │
│  │  → 차단: 큐 저장 + Discord 알림 → 스킵      │  │
│  └───────────────────────────────────────────┘  │
│                    │                            │
│                    ▼ Playwright 종료              │
│                                                 │
│  ┌─ Phase B: 다듬기 타임 (~8-10GB VRAM) ─────┐  │
│  │                                           │  │
│  │  Llama 3.2 Vision 11B 로딩 (1회)           │  │
│  │  → 모든 content_raw를 순차적으로 다듬기      │  │
│  │  → 애매한 차단 케이스는 스크린샷으로 재확인    │  │
│  │  → content 컬럼에 저장                     │  │
│  └───────────────────────────────────────────┘  │
│                    │                            │
│                    ▼ Llama 언로드                  │
│                                                 │
│  Supabase 저장 (status: "COLLECTED")             │
│                                                 │
│  Discord Bot (차단 알림 + 수동 처리 명령)          │
│  원격 접속: Chrome Remote Desktop                │
└──────────────┬──────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────┐
│ 🗄️ Supabase (기존 유지)                          │
│  - trend 테이블 (content_raw + content)          │
│  - analysis_results                              │
│  - Auth, Subscriptions                           │
└──────────────┬──────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────┐
│ ☁️ Oracle Cloud (춘천, Free Tier)                 │
│                                                 │
│  현재: AMD Micro (1 CPU / 1GB RAM)               │
│  예정: ARM Ampere (4 OCPU / 24GB) — 유료 업그레이드│
│        완료 후 교체                               │
│                                                 │
│  파이프라인 컨트롤러                               │
│   - Cron: status="COLLECTED" 항목 조회            │
│   - 깨끗한 content를 분석 API에 전달              │
│   - 분석 모델:                                   │
│     • Gemini 3 Flash (메인, 대량 분석)            │
│     • Gemini 3 Pro (심층 분석)                    │
│     • Grok 4.1 Fast Reasoning (X/트위터 전용)     │
│     • Kimi K2.5 (보조/멀티모달)                   │
│   - 분석 결과 → analysis_results 저장             │
│   - status: "COLLECTED" → "ANALYZED"              │
│   - 뉴스레터 발송 (Resend)                        │
└─────────────────────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────┐
│ 🌐 Cloudflare Pages (기존 유지)                   │
│  - trendiv-web (SvelteKit)                       │
└─────────────────────────────────────────────────┘
```

---

## 4. 배치 처리 전략

### 4.1 왜 배치인가

순차 처리(URL마다 Chrome ↔ LLM 교체)는 모델 로딩 오버헤드가 심함:

- 11B 모델을 SSD→VRAM 로딩에 물리적으로 5~8초
- 100회 반복 = ~13분 순수 낭비 + SSD 수명 소모

| 방식     | 모델 로딩 횟수 (50 URL) | 로딩 오버헤드 |
| -------- | ----------------------- | ------------- |
| 순차     | ~100회                  | ~13분 낭비    |
| **배치** | **1회**                 | **~8초** ✅   |

### 4.2 VRAM 운용

```
Phase A (수집)              Phase B (다듬기)
┌──────────────────┐       ┌──────────────────┐
│ Playwright만      │       │ Llama 3.2 Vision │
│ VRAM: 0GB        │       │ VRAM: 8-10GB     │
│ 여유: 12GB 전체   │       │ 여유: 2-4GB      │
└──────────────────┘       └──────────────────┘
```

---

## 5. 차단 처리 시스템

### 5.1 키워드 차단 체크 (Phase A, 즉시)

```typescript
const blockKeywords = [
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

- 차단 시: blocked_queue 저장 + Discord 알림 → 스킵
- 콘텐츠 짧음 (<200자): 스크린샷 저장 → Phase B에서 Llama Vision 재확인

### 5.2 Discord Bot 명령어

| 명령어        | 동작                               |
| ------------- | ---------------------------------- |
| `!list`       | 차단된 사이트 큐 목록              |
| `!retry`      | 큐의 사이트 재시도 (브라우저 열림) |
| `!done`       | 수동 처리 완료 → 수집 재개         |
| `!skip [url]` | 특정 사이트 스킵                   |
| `!status`     | 현재 수집 현황                     |

### 5.3 수동 처리 흐름

원격 접속(Chrome Remote Desktop)으로 모바일에서 캡차/차단 해제 가능.
잠들어있어도 나머지 수집은 정상 동작, 차단된 것만 나중에 처리.

---

## 6. 분석 모델 라인업

| 모델                    | 용도               | 가격 (per 1M tokens)       |
| ----------------------- | ------------------ | -------------------------- |
| Gemini 3 Flash          | 메인 분석 (대량)   | 무료 티어 넉넉             |
| Gemini 3 Pro            | 심층 분석 (고품질) | Flash보다 비쌈             |
| Grok 4.1 Fast Reasoning | X(트위터) 전용     | 별도 과금                  |
| Kimi K2.5               | 보조/멀티모달      | $0.60 input / $3.00 output |

Kimi K2.5: OpenAI SDK 호환 (`api.moonshot.ai/v1`), 자동 캐싱 75% 절감, $1부터 시작.

---

## 7. DB 스키마 변경

```sql
ALTER TABLE trend ADD COLUMN content_raw TEXT;
```

| status      | 의미                                       |
| ----------- | ------------------------------------------ |
| `RAW`       | title/link/date만 저장                     |
| `SCRAPED`   | Phase A 완료 (content_raw + 스크린샷)      |
| `COLLECTED` | Phase B 완료 (Llama가 content 다듬기 완료) |
| `ANALYZED`  | Oracle에서 분석 완료                       |

content_raw 정리: 운영 안정화 후 admin 페이지에서 일괄 NULL 처리.

---

## 8. 통신 흐름

```
로컬 PC → Supabase 저장 (수집 결과)
Oracle  → Supabase 조회 (미분석 항목) → 분석 API 호출 → 결과 저장

※ 로컬 PC ↔ Oracle 직접 통신 없음
※ 포트포워딩 불필요
```

---

## 9. Phase 1 테스트 결과

| #   | 테스트                      | 상태 | 비고                                |
| --- | --------------------------- | ---- | ----------------------------------- |
| 1   | nvidia-smi                  | ✅   | RTX 4070 SUPER 12GB                 |
| 2   | ollama pull moondream       | ✅   | (배치 전략으로 미사용 예정)         |
| 3   | Playwright 기본 동작        | ✅   | 스크린샷 + innerText                |
| 4   | 키워드 차단 체크            | ✅   | 정확도 높음                         |
| 5   | ollama pull llama3.2-vision | ✅   | 11B 다운로드 완료                   |
| 6   | Llama 텍스트 정리           | ✅   | nav/ad/footer 제거 성공             |
| 7   | Llama Vision 스크린샷 분석  | ✅   | 차단/정상 판별 성공                 |
| 8   | Readability.js 안정성       | ✅   | 크래시 없음, 노이즈 27% 제거        |
| 9   | 대안 LLM 비교               | ⬜   | 나중에 (Qwen 2.5 VL 7B, Gemma 3 4B) |
| 10  | Oracle 인스턴스             | ⏳   | AMD Micro 생성 완료, Swap 추가 필요 |
| 11  | Discord Bot                 | ✅   | !status, !list 명령어 동작          |

---

## 10. Oracle Cloud 현재 상태

| 항목      | 상태                                                          |
| --------- | ------------------------------------------------------------- |
| 계정      | ✅ 유료 업그레이드 완료                                        |
| 인스턴스  | ✅ ARM Flex (4 OCPU / 24GB RAM) 업그레이드 완료               |
| Public IP | 168.107.43.222                                                |
| SSH 접속  | `ssh -i ~/Downloads/ssh-key-2026-02-08.key opc@168.107.43.222` |
| OS        | Oracle Linux 9 (aarch64)                                      |
| Swap      | ⚠️ 추가 권장 (안전망용 4GB)                                   |

### Oracle 서버 셋업 (다음에 이어서)

```bash
# Swap 4GB (24GB RAM이지만 안전망으로)
sudo dd if=/dev/zero of=/swapfile bs=1M count=4096
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

### Oracle 서버에 Node.js 설치 (Swap 추가 후)

```bash
sudo dnf update -y
sudo dnf install -y nodejs
node -v
npm -v
```

### 유료 업그레이드 완료 후

ARM 인스턴스 (4 OCPU / 24GB) 생성 → AMD Micro 교체
Budget 알림 설정: Billing → Budgets → $1 알림

---

## 11. 남은 작업 (앞으로 할 것)

### 즉시 (Oracle 서버 세팅 마무리)

1. Oracle Swap 추가 + Node.js 설치
2. 유료 업그레이드 완료 확인 → ARM 인스턴스 교체 (선택)
3. Budget 알림 설정

### Phase 2: 수집 파이프라인 코딩

4. trendiv-scraper-module 리팩토링 (배치 Phase A 구현)
5. Ollama 연동 모듈 (배치 Phase B 구현)
6. Readability.js 통합 (본문 추출 + innerText 폴백)
7. 키워드 차단 체크 통합
8. Supabase content_raw / content 저장 로직

### Phase 3: Discord Bot

9. 차단 알림 기능 (!list, !retry, !done, !skip, !status)
10. Chrome Remote Desktop 설정

### Phase 4: Oracle 분석 파이프라인

11. trendiv-pipeline-controller Oracle 배포
12. Gemini 3 Flash/Pro 서비스 업데이트
13. Kimi K2.5 서비스 추가
14. Cron 스케줄 설정

### Phase 5 이후

15. 대안 LLM 비교 테스트 (Qwen, Gemma)
16. Admin 페이지 (content_raw 정리)
17. Chrome AI 한국어 지원 시 프론트엔드 적용

---

## 부록: 주요 참고 정보

### Discord Bot

- Token: (본인 보관)
- 서버: Trendiv 서버

### Oracle Cloud

- 리전: 춘천
- 유료 업그레이드: 진행중
- Free Tier 한도: ARM 4 OCPU / 24GB, AMD Micro 2개, 부트볼륨 200GB, 트래픽 10TB/월

### Kimi K2.5

- API: `api.moonshot.ai/v1` (OpenAI SDK 호환)
- 가격: $0.60/1M input, $3.00/1M output
- 자동 캐싱: 반복 입력 75% 절감
- 시작: $1 충전, $5 누적 시 $5 보너스

### 포트포워딩

현재 아키텍처에서 불필요. 로컬 PC → Supabase → Oracle 흐름.
