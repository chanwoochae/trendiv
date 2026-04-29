// @ts-check
"use strict";

const GITHUB_TOKEN    = process.env.GITHUB_TOKEN;
const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY;
const FIGMA_KEY       = process.env.FIGMA_API_KEY;
const ISSUE_NUMBER    = Number(process.env.ISSUE_NUMBER);
const ISSUE_TITLE     = process.env.ISSUE_TITLE ?? "";
const COMMENT_ID      = Number(process.env.COMMENT_ID);
const COMMENT_BODY    = process.env.COMMENT_BODY ?? "";
const REPO_OWNER      = process.env.REPO_OWNER;
const REPO_NAME       = process.env.REPO_NAME;

const GH_BASE = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}`;

// ─── 봇 코멘트 식별자 ────────────────────────────────────────────────────────
const MARKER = {
  markup: "<!-- MARKUP_BOT:markup -->",
  spec:   "<!-- MARKUP_BOT:spec -->",
  thread: "<!-- MARKUP_BOT:thread -->",
};

// ─── GitHub API ──────────────────────────────────────────────────────────────
async function gh(path, opts = {}) {
  const res = await fetch(`${GH_BASE}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/vnd.github.v3+json",
      ...opts.headers,
    },
  });
  if (!res.ok && res.status !== 204) {
    throw new Error(`GitHub ${res.status} ${path}: ${await res.text()}`);
  }
  return res.status === 204 ? null : res.json();
}

const getComments    = ()    => gh(`/issues/${ISSUE_NUMBER}/comments?per_page=100`);
const createComment  = body  => gh(`/issues/${ISSUE_NUMBER}/comments`, { method: "POST", body: JSON.stringify({ body }) });
const updateComment  = (id, body) => gh(`/issues/comments/${id}`, { method: "PATCH", body: JSON.stringify({ body }) });
const deleteComment  = id    => fetch(`${GH_BASE}/issues/comments/${id}`, {
  method: "DELETE",
  headers: { Authorization: `Bearer ${GITHUB_TOKEN}` },
});

// ─── Figma API ───────────────────────────────────────────────────────────────
function parseFigmaUrl(url) {
  const fileMatch = url.match(/figma\.com\/(?:design|file)\/([a-zA-Z0-9]+)/);
  const nodeMatch = url.match(/node-id=([^&\s]+)/);
  if (!fileMatch) return null;
  return {
    fileKey: fileMatch[1],
    nodeId: nodeMatch ? decodeURIComponent(nodeMatch[1]).replace(/-/g, ":") : null,
  };
}

function summarizeFigmaNode(node, depth = 0) {
  if (!node) return "";
  const indent = "  ".repeat(depth);
  const name = node.name ?? "unnamed";
  const type = node.type ?? "";
  const bounds = node.absoluteBoundingBox
    ? ` [${Math.round(node.absoluteBoundingBox.width)}×${Math.round(node.absoluteBoundingBox.height)}]`
    : "";
  const text = node.characters ? ` "${node.characters}"` : "";
  let out = `${indent}- ${name} (${type})${bounds}${text}\n`;
  if (node.children && depth < 4) {
    for (const child of node.children.slice(0, 12)) {
      out += summarizeFigmaNode(child, depth + 1);
    }
    if (node.children.length > 12) {
      out += `${indent}  ... (${node.children.length - 12}개 더)\n`;
    }
  }
  return out;
}

async function fetchFigmaContext(url) {
  if (!FIGMA_KEY || !url) return null;
  const parsed = parseFigmaUrl(url);
  if (!parsed) return null;

  try {
    const endpoint = parsed.nodeId
      ? `https://api.figma.com/v1/files/${parsed.fileKey}/nodes?ids=${encodeURIComponent(parsed.nodeId)}`
      : `https://api.figma.com/v1/files/${parsed.fileKey}`;
    const res = await fetch(endpoint, { headers: { "X-Figma-Token": FIGMA_KEY } });
    if (!res.ok) return null;

    const data = await res.json();
    const node = parsed.nodeId
      ? Object.values(data.nodes ?? {})[0]?.document
      : data.document;
    if (!node) return null;

    return `파일: ${data.name ?? "unknown"}\n컴포넌트 트리:\n${summarizeFigmaNode(node)}`;
  } catch (e) {
    console.warn("Figma fetch failed:", e.message);
    return null;
  }
}

// ─── Claude API ──────────────────────────────────────────────────────────────
async function callClaude(system, messages) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-opus-4-5",
      max_tokens: 4096,
      system,
      messages,
    }),
  });
  if (!res.ok) throw new Error(`Claude ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.content[0].text;
}

// XML 태그에서 섹션 추출
function extract(text, tag) {
  const m = text.match(new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`));
  return m ? m[0].replace(new RegExp(`^<${tag}>|<\\/${tag}>$`, "g"), "").trim() : null;
}

// ─── 코멘트 본문 빌더 ────────────────────────────────────────────────────────
function buildMarkupComment(markup) {
  return `${MARKER.markup}
## 📐 마크업

> 이 코멘트는 대화를 통해 업데이트됩니다.

\`\`\`
${markup}
\`\`\`
`;
}

function buildSpecComment(spec) {
  return `${MARKER.spec}
## 📋 컴포넌트 스펙

${spec}
`;
}

function buildThreadComment(reply, history) {
  const historyBlock = history.trim()
    ? `\n\n---\n\n<details>\n<summary>대화 요약</summary>\n\n${history}\n</details>`
    : "";
  return `${MARKER.thread}
## 💬

${reply}${historyBlock}
`;
}

// ─── 메인 ────────────────────────────────────────────────────────────────────
async function main() {
  const body = COMMENT_BODY.trim();
  const isMarkupCmd = body.startsWith("/markup");

  const comments = await getComments();
  const botComments = {
    markup: comments.find(c => c.body.includes(MARKER.markup)),
    spec:   comments.find(c => c.body.includes(MARKER.spec)),
    thread: comments.find(c => c.body.includes(MARKER.thread)),
  };
  const isInitialized = !!botComments.markup;

  if (!isMarkupCmd && !isInitialized) {
    console.log("Not a /markup command and no active session — skipping.");
    return;
  }

  if (isMarkupCmd) {
    await handleInit(botComments, body);
  } else {
    await handleConversation(botComments, body);
  }
}

// ─── 최초 초기화 ─────────────────────────────────────────────────────────────
async function handleInit(botComments, body) {
  const figmaUrlMatch = body.match(/https?:\/\/(?:www\.)?figma\.com\/\S+/);
  const figmaUrl = figmaUrlMatch?.[0] ?? null;
  const extraInstruction = body.replace("/markup", "").replace(figmaUrl ?? "", "").trim();

  const figmaContext = await fetchFigmaContext(figmaUrl);

  const system = `당신은 Svelte/SvelteKit 컴포넌트 마크업 전문가이자 협업 파트너입니다.
피그마 디자인을 분석해 ASCII 마크업으로 표현하고, 이슈 작성자와 대화하며 마크업을 완성합니다.

## 마크업 규칙
- 컴포넌트를 ASCII 박스 레이아웃으로 표현
- Svelte 컴포넌트명 사용: <ScoreBadge />, <ArticleCard />, <TagChip /> 등
- 예시:
  | <DragHandle />                                          |
  | <ScoreBadge score={9} />  <SourceInfo />  <Bookmark /> |
  |-------------------------------------------------------|
  | <TitlePanel>제목</TitlePanel>                          |
  | <SummaryPanel>AI 요약</SummaryPanel>                  |
  | <TagList tags={tags} />                               |
  | <PrimaryButton>원문 보기</PrimaryButton>              |

## 응답 형식 (반드시 XML 태그 사용)
<markup>ASCII 마크업 전체</markup>
<spec>컴포넌트 스펙 (마크다운 표)</spec>
<reply>사용자에게 보내는 자연어 응답</reply>
<history>첫 설정 요약 (3줄)</history>`;

  const userMsg = [
    `이슈 제목: ${ISSUE_TITLE}`,
    figmaUrl ? `피그마 링크: ${figmaUrl}` : "",
    figmaContext ? `\n피그마 구조:\n${figmaContext}` : "※ 피그마 데이터 없음",
    extraInstruction ? `\n추가 요청: ${extraInstruction}` : "",
  ].filter(Boolean).join("\n");

  const response = await callClaude(system, [{ role: "user", content: userMsg }]);

  const markup  = extract(response, "markup")  ?? response;
  const spec    = extract(response, "spec")    ?? "스펙 정리 중...";
  const reply   = extract(response, "reply")   ?? "마크업 초안을 작성했습니다.";
  const history = extract(response, "history") ?? "";

  // 3개 코멘트 생성 (기존 있으면 업데이트)
  await upsertComment(botComments.markup, buildMarkupComment(markup));
  await upsertComment(botComments.spec,   buildSpecComment(spec));
  await upsertComment(botComments.thread, buildThreadComment(reply, history));

  await deleteComment(COMMENT_ID);
  console.log("✅ Init complete");
}

// ─── 대화 이어가기 ────────────────────────────────────────────────────────────
async function handleConversation(botComments, userMessage) {
  const currentMarkup = extractMarkdownCode(botComments.markup?.body ?? "");
  const currentHistory = extractSummary(botComments.thread?.body ?? "");

  const system = `당신은 Svelte/SvelteKit 컴포넌트 마크업 전문가이자 협업 파트너입니다.
사용자와 대화하며 마크업을 점진적으로 완성합니다.

## 마크업 규칙
- ASCII 박스 레이아웃, Svelte 컴포넌트명 사용
- 변경 없으면 <markup>UNCHANGED</markup>

## 응답 형식 (반드시 XML 태그 사용)
<markup>변경된 마크업 전체 또는 UNCHANGED</markup>
<reply>사용자에게 보내는 자연어 응답 (마크다운)</reply>
<history>전체 대화 내용 압축 요약 (5줄 이내)</history>`;

  const userContent = [
    `현재 마크업:\n\`\`\`\n${currentMarkup}\n\`\`\``,
    currentHistory ? `\n이전 대화 요약:\n${currentHistory}` : "",
    `\n사용자: ${userMessage}`,
  ].join("\n");

  const response = await callClaude(system, [{ role: "user", content: userContent }]);

  const newMarkup = extract(response, "markup");
  const reply     = extract(response, "reply")   ?? response;
  const history   = extract(response, "history") ?? currentHistory;

  // 마크업 변경 시 Comment 1 업데이트
  if (newMarkup && newMarkup !== "UNCHANGED" && botComments.markup) {
    await updateComment(botComments.markup.id, buildMarkupComment(newMarkup));
  }

  // Comment 3 업데이트 (응답 + 요약)
  if (botComments.thread) {
    await updateComment(botComments.thread.id, buildThreadComment(reply, history));
  }

  // 유저 코멘트 삭제
  await deleteComment(COMMENT_ID);
  console.log("✅ Conversation updated");
}

// ─── 유틸 ─────────────────────────────────────────────────────────────────────
async function upsertComment(existing, body) {
  if (existing) {
    await updateComment(existing.id, body);
  } else {
    await createComment(body);
  }
}

function extractMarkdownCode(body) {
  const m = body.match(/```[\s\S]*?\n([\s\S]*?)```/);
  return m?.[1]?.trim() ?? body;
}

function extractSummary(body) {
  const m = body.match(/<summary>대화 요약<\/summary>\n\n([\s\S]*?)\n<\/details>/);
  return m?.[1]?.trim() ?? "";
}

main().catch(err => {
  console.error("❌ Markup bot error:", err);
  process.exit(1);
});
