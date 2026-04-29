/**
 * Phase B: Llama 3.2 Vision 텍스트 정리 스크립트
 *
 * 1. SCRAPED 상태 항목 조회 (content_raw 있는 것)
 * 2. Llama 3.2 Vision으로 content_raw 정리 → content 저장
 * 3. 스크린샷 있는 항목은 Vision으로 차단 여부 재확인
 * 4. 정리 완료 → status 유지 (SCRAPED, Oracle이 ANALYZED로 처리)
 *
 * 실행: npx ts-node src/scripts/phase-b-refine.ts
 * 옵션: --dry-run (DB 저장 없이 테스트)
 *       --limit=20 (처리 개수 제한, 기본 100)
 */

import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

const envPath = path.resolve(__dirname, '../../../.env');
if (!fs.existsSync(envPath)) {
  console.error('❌ .env 파일을 찾을 수 없습니다:', envPath);
  process.exit(1);
}
dotenv.config({ path: envPath });

import { performance } from 'perf_hooks';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import axios from 'axios';

// ─── 설정 ───────────────────────────────────────────
const isDryRun = process.argv.includes('--dry-run');
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1]) : 100;
const SCREENSHOT_DIR = path.resolve(__dirname, '../../screenshots');

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen3.6:27b';
const OLLAMA_VISION_MODEL = process.env.OLLAMA_VISION_MODEL || 'gemma4:26b';

// 기본 30분, 실제 응답이 30분 초과하면 그 시간 + 1분으로 늘어남
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
let maxElapsedMs = DEFAULT_TIMEOUT_MS;
function getAdaptiveTimeout(): number {
  return maxElapsedMs > DEFAULT_TIMEOUT_MS
    ? maxElapsedMs + 60000
    : DEFAULT_TIMEOUT_MS;
}

// ─── Ollama: 텍스트 정리 ────────────────────────────
async function refineText(contentRaw: string): Promise<string | null> {
  const prompt = `You are a content cleaner. Extract only the main article body from the following text.
Remove all: navigation menus, headers, footers, sidebars, ads, cookie notices, subscription prompts, social sharing buttons, related article links, author bios, comment sections, and any other non-article content.
Keep only: the article title (if present), the main body paragraphs, and key quotes or code snippets.
Output only the cleaned text, no explanations.

---
${contentRaw.slice(0, 6000)}
---`;

  const t0 = Date.now();
  try {
    const response = await axios.post(
      `${OLLAMA_URL}/api/generate`,
      {
        model: OLLAMA_MODEL,
        prompt,
        stream: false,
        think: false,
        options: { temperature: 0.1, num_predict: 2048 },
      },
      { timeout: getAdaptiveTimeout() },
    );
    const elapsed = Date.now() - t0;
    if (elapsed > maxElapsedMs) maxElapsedMs = elapsed;
    const result = response.data?.response?.trim();
    return result || null;
  } catch (err: any) {
    throw new Error(`Ollama 호출 실패: ${err.message}`);
  }
}

// ─── Ollama: 스크린샷 차단 여부 확인 (gemma4 vision) ────────────
async function checkScreenshotBlocked(screenshotPath: string): Promise<boolean> {
  if (!fs.existsSync(screenshotPath)) return false;

  const imageData = fs.readFileSync(screenshotPath).toString('base64');

  const prompt = `Look at this screenshot of a webpage. Is this a blocked page, CAPTCHA, error page, or access denied page?
Answer with only "BLOCKED" or "OK".`;

  try {
    const response = await axios.post(
      `${OLLAMA_URL}/api/generate`,
      {
        model: OLLAMA_VISION_MODEL,
        prompt,
        images: [imageData],
        stream: false,
        options: { temperature: 0, num_predict: 10 },
      },
      { timeout: 60000 },
    );
    const result = response.data?.response?.trim().toUpperCase();
    return result.includes('BLOCKED');
  } catch {
    return false;
  }
}

// ─── Ollama 연결 확인 ───────────────────────────────
async function checkOllama(): Promise<boolean> {
  try {
    const response = await axios.get(`${OLLAMA_URL}/api/tags`, { timeout: 5000 });
    const models: string[] = response.data?.models?.map((m: any) => m.name) || [];
    const hasModel = models.some((m) => m.includes(OLLAMA_MODEL.split(':')[0]));
    if (!hasModel) {
      console.error(`❌ ${OLLAMA_MODEL} 모델이 없습니다. 설치: ollama pull ${OLLAMA_MODEL}`);
      return false;
    }
    return true;
  } catch {
    console.error(`❌ Ollama 서버에 연결할 수 없습니다. (${OLLAMA_URL})`);
    console.error('   Ollama가 실행 중인지 확인하세요: ollama serve');
    return false;
  }
}

// ─── 메인 ───────────────────────────────────────────
async function main() {
  console.log('\n========================================');
  console.log(`🦙 [Phase B] Llama 정리 시작 ${isDryRun ? '(DRY-RUN)' : ''}`);
  console.log(`   모델: ${OLLAMA_MODEL} | 한도: ${LIMIT}개`);
  console.log('========================================\n');

  const startTime = performance.now();

  // Ollama 연결 확인
  const ollamaOk = await checkOllama();
  if (!ollamaOk) process.exit(1);
  console.log(`✅ Ollama 연결 확인\n`);

  // Supabase 연결
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    console.error('❌ SUPABASE_URL / SUPABASE_KEY 환경변수가 없습니다.');
    process.exit(1);
  }
  const supabase: SupabaseClient = createClient(supabaseUrl, supabaseKey);

  // SCRAPED 상태 + content_raw 있는 항목 조회
  const { data: items, error } = await supabase
    .from('article')
    .select('id, title, link, category, content_raw')
    .eq('status', 'SCRAPED')
    .not('content_raw', 'is', null)
    .is('content', null) // content 미정리된 것만
    .order('id', { ascending: true })
    .limit(LIMIT);

  if (error || !items) {
    console.error('❌ 항목 조회 실패:', error?.message);
    process.exit(1);
  }

  console.log(`📋 정리 대상: ${items.length}개\n`);

  if (items.length === 0) {
    console.log('정리할 항목이 없습니다.');
    process.exit(0);
  }

  let successCount = 0;
  let blockedCount = 0;
  let errorCount = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const progress = `[${i + 1}/${items.length}]`;
    console.log(`${progress} ${item.title?.substring(0, 60)}\n   🔗 ${item.link}`);

    // 스크린샷 있으면 Vision으로 차단 여부 재확인
    const blockedScreenshotPath = path.join(SCREENSHOT_DIR, `blocked_${item.id}.png`);
    const shortScreenshotPath = path.join(SCREENSHOT_DIR, `short_${item.id}.png`);
    const hasBlockedScreenshot = fs.existsSync(blockedScreenshotPath);
    const hasShortScreenshot = fs.existsSync(shortScreenshotPath);

    if (hasBlockedScreenshot) {
      console.log(`   🔍 Vision으로 차단 여부 재확인...`);
      const isBlocked = await checkScreenshotBlocked(blockedScreenshotPath);
      if (isBlocked) {
        console.log(`   ❌ Vision: 차단 확인 → FAIL 처리`);
        if (!isDryRun) {
          await supabase
            .from('article')
            .update({ status: 'FAIL' })
            .eq('id', item.id);
        }
        blockedCount++;
        continue;
      } else {
        console.log(`   ✅ Vision: 차단 아님 → 정리 진행`);
      }
    }

    if (hasShortScreenshot) {
      console.log(`   🔍 Vision으로 짧은 콘텐츠 확인...`);
      const isBlocked = await checkScreenshotBlocked(shortScreenshotPath);
      if (isBlocked) {
        console.log(`   ❌ Vision: 차단 확인 → FAIL 처리`);
        if (!isDryRun) {
          await supabase
            .from('article')
            .update({ status: 'FAIL' })
            .eq('id', item.id);
        }
        blockedCount++;
        continue;
      }
    }

    // 텍스트 정리
    try {
      console.log(`   🦙 Llama 정리 중... (${item.content_raw!.length}자)`);
      const content = await refineText(item.content_raw!);

      if (!content || content.length < 50) {
        console.log(`   ⚠️ 정리 결과 너무 짧음 → 스킵`);
        errorCount++;
        continue;
      }

      console.log(`   ✅ 정리 완료 (${content.length}자)`);

      if (!isDryRun) {
        const { error: updateError } = await supabase
          .from('article')
          .update({ content })
          .eq('id', item.id);

        if (updateError) {
          console.log(`   ⚠️ DB 저장 실패: ${updateError.message}`);
          errorCount++;
        } else {
          successCount++;
        }
      } else {
        console.log(`   [DRY-RUN] 미리보기:\n   ${content.substring(0, 200)}\n`);
        successCount++;
      }
    } catch (err: any) {
      console.error(`   ❌ 오류: ${err.message}`);
      errorCount++;
    }
  }

  // ─── 결과 출력 ───
  const durationSec = ((performance.now() - startTime) / 1000).toFixed(1);
  const durationMin = (Number(durationSec) / 60).toFixed(2);

  console.log('\n========================================');
  console.log('✅ [Phase B] 완료');
  console.log(`   총 대상: ${items.length}개`);
  console.log(`   성공:    ${successCount}개`);
  console.log(`   차단:    ${blockedCount}개 → FAIL`);
  console.log(`   오류:    ${errorCount}개`);
  console.log(`   ⏱️ 소요: ${durationSec}초 (${durationMin}분)`);
  if (isDryRun) console.log(`   ⚠️ DRY-RUN: DB 변경 없음`);
  console.log('========================================\n');

  process.exit(0);
}

main().catch((err) => {
  console.error('❌ 치명적 에러:', err);
  process.exit(1);
});
