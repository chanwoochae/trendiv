// @ts-check
"use strict";

const GITHUB_TOKEN    = process.env.GITHUB_TOKEN;
const FIGMA_KEY       = process.env.FIGMA_ACCESS_TOKEN;
const WEEDBOT_URL     = process.env.WEEDBOT_URL ?? "http://168.107.43.222:3002";
const WEEDBOT_API_KEY = process.env.WEEDBOT_API_KEY;
const ISSUE_NUMBER    = Number(process.env.ISSUE_NUMBER);
const ISSUE_TITLE     = process.env.ISSUE_TITLE ?? "";
const COMMENT_ID      = Number(process.env.COMMENT_ID);
const COMMENT_BODY    = process.env.COMMENT_BODY ?? "";
const REPO_OWNER      = process.env.REPO_OWNER;
const REPO_NAME       = process.env.REPO_NAME;

// ─── 디버그 ───────────────────────────────────────────────────────────────────
console.log(`[DEBUG] WEEDBOT_URL: ${WEEDBOT_URL}`);
console.log(`[DEBUG] WEEDBOT_API_KEY: ${WEEDBOT_API_KEY ? `${WEEDBOT_API_KEY.slice(0,6)}...${WEEDBOT_API_KEY.slice(-4)} (len=${WEEDBOT_API_KEY.length})` : "❌ 없음"}`);
console.log(`[DEBUG] COMMENT_BODY: ${COMMENT_BODY.slice(0, 80)}`);

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

// ─── WeedBot API ─────────────────────────────────────────────────────────────
async function callWeedBot(payload) {
  const url = `${WEEDBOT_URL}/api/markup`;
  console.log(`[DEBUG] POST ${url} (type=${payload.type})`);

  // health check 먼저
  try {
    const health = await fetch(`${WEEDBOT_URL}/health`);
    console.log(`[DEBUG] Health: ${health.status} ${await health.text()}`);
  } catch (e) {
    console.log(`[DEBUG] Health check 실패: ${e.message}`);
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${WEEDBOT_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  const responseText = await res.text();
  console.log(`[DEBUG] Response ${res.status}: ${responseText.slice(0, 200)}`);

  if (!res.ok) throw new Error(`WeedBot ${res.status}: ${responseText}`);
  return JSON.parse(responseText);
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

  const result = await callWeedBot({
    type: "init",
    issueTitle: ISSUE_TITLE,
    figmaContext: figmaContext ?? null,
    extraInstruction: extraInstruction || undefined,
  });

  const markup  = result.markup  ?? "마크업 생성 실패";
  const spec    = result.spec    ?? "스펙 정리 중...";
  const reply   = result.reply   ?? "마크업 초안을 작성했습니다.";
  const history = result.history ?? "";

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

  const result = await callWeedBot({
    type: "conversation",
    currentMarkup,
    currentHistory,
    userMessage,
  });

  const newMarkup = result.markup;
  const reply     = result.reply   ?? userMessage;
  const history   = result.history ?? currentHistory;

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
