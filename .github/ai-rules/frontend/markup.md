# 마크업 봇 규칙

> 트리거: `/markup` 커맨드로 GitHub 이슈에서 컴포넌트 설계 시 적용
> 사용처: WeedBot `markup.service.ts` 프롬프트

---

## COMPONENT_DESIGN

- 단일 컴포넌트 단위로 설계
- Props는 interface로 정의 (Svelte 5 Runes)
- `class?: string` 반드시 포함
- `children: Snippet` 사용 (`<slot>` 금지)
- rest props (`{...rest}`) 루트 요소 전달

---

## MARKUP_FORMAT

- ASCII 박스 레이아웃으로 컴포넌트 구조 표현
- Svelte 컴포넌트명 사용 (`<ScoreBadge />`, `<ArticleCard />` 등)
- 예시:

```
  | <DragHandle />                                           |
  | <ScoreBadge score={9} />  <SourceInfo />  <Bookmark />  |
  |----------------------------------------------------------|
  | <TitlePanel>제목</TitlePanel>                            |
  | <SummaryPanel>AI 요약</SummaryPanel>                    |
  | <TagList tags={tags} />                                 |
  | <PrimaryButton>원문 보기</PrimaryButton>                |
```

---

## SPEC_TABLE

### 작성 규칙

- 이슈 제목에서 요청한 **대상 컴포넌트 1개**의 Props/Slots만 정의
- 하위 컴포넌트는 마크업 구조도에서 이름만 보여주면 충분
- 하위 컴포넌트를 개별 행으로 분리하여 Props를 나열하지 말 것
- Figma 데이터 없으면 Props 추측 금지 — "Figma 링크 제공 시 상세 스펙 작성 가능" 표시
- 불필요한 prop 남발 금지 — 실제 필요한 최소 인터페이스만

### 표 형식

| 컴포넌트명 | Props / Slots | 설명 |

---

## SVELTE_5_CONVENTIONS

```
RULE: Runes 문법만 사용
USE: $state(), $derived(), $effect(), $props()
AVOID: export let, $:, <slot>
```

```
RULE: 이벤트 핸들러
USE: onclick, oninput, onchange
AVOID: on:click, on:input, on:change
```

```
RULE: Snippet 렌더링
USE: {@render children()}
AVOID: <slot />, <slot name="x">
```

```
RULE: 조건부 클래스
USE: cn('base', isActive && 'active', className)
IMPORT: import { cn } from '$lib/utils/ClassMerge';
```

---

## TAILWIND_V4_COLORS

```
PRIMARY
#1ba896 → bg-primary, text-primary
#148a7d → bg-primary-hover
#e0f7f4 → bg-primary-subtle

BACKGROUND
#f8fafc → bg-bg-body
#ffffff → bg-bg-main
#f1f5f9 → bg-bg-surface

BORDER
#e2e8f0 → border-border-default
#cbd5e1 → border-border-strong
#1ba896 → border-border-focus

GRAY
#a3a3a3 → text-gray-500
#737373 → text-gray-600
#525252 → text-gray-700
#404040 → text-gray-800
#262626 → text-gray-900

STATUS
#10b981 → bg-confirm
#f59e0b → bg-caution
#ef4444 → bg-alert
#0ea5e9 → bg-info

AVOID:
- bg-[#1ba896] → bg-primary 사용
- text-[#404040] → text-gray-800 사용
```

---

## FIGMA_INTEGRATION

- Figma URL 제공 시: 노드 트리에서 레이아웃, 색상, 스페이싱 참조
- `node-id` 기반 특정 컴포넌트 분석 가능
- Figma 데이터 없으면 구조만 제안 (Props 추측 금지)

---

## RESPONSE_FORMAT

AI 응답은 반드시 XML 태그로 구분:

```
<markup>ASCII 마크업</markup>
<spec>대상 컴포넌트의 스펙만 (마크다운 표)</spec>
<reply>사용자에게 보내는 자연어 응답</reply>
<history>세션 요약 (3줄 이내)</history>
```
