/**
 * Phase A: 로컬 수집 스크립트
 *
 * 1. 기존 scrapeAll()로 title/link/date 수집
 * 2. Supabase에 RAW 상태로 저장 (중복 스킵)
 * 3. 각 URL을 Playwright로 방문
 * 4. Readability.js로 본문 추출 (실패 시 innerText 폴백)
 * 5. 키워드 차단 체크
 * 6. content_raw + 스크린샷 저장 → status: SCRAPED
 *
 * 실행: npx ts-node src/scripts/phase-a-collect.ts
 * 옵션: --dry-run (DB 저장 없이 테스트)
 */

import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

// .env 로딩
const envPath = path.resolve(__dirname, '../../../.env');
if (!fs.existsSync(envPath)) {
  console.error('❌ .env 파일을 찾을 수 없습니다:', envPath);
  process.exit(1);
}
dotenv.config({ path: envPath });

import { performance } from 'perf_hooks';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { chromium, Browser, Page } from 'playwright';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import { scrapeAll } from '../index';

// ─── 설정 ───────────────────────────────────────────
const isDryRun = process.argv.includes('--dry-run');
const FETCH_DAYS = 7;
const CONTENT_MIN_LENGTH = 200; // 이 미만이면 차단 의심
const SCREENSHOT_DIR = path.resolve(__dirname, '../../screenshots');

// ─── 차단 키워드 ────────────────────────────────────
const BLOCK_KEYWORDS = [
  'access denied',
  'blocked',
  'forbidden',
  'captcha',
  'security check',
  'cloudflare',
  'ray id',
  'verify you are human',
  'please wait',
  'checking your browser',
  'error 1020',
  'error 403',
  '403 forbidden',
  '503 service',
  'attention required',
  'just a moment',
  'enable javascript and cookies',
];

// ─── 키워드 차단 체크 ───────────────────────────────
function isBlocked(text: string): boolean {
  const lower = text.toLowerCase();
  if (lower.length > 1000) return false;
  return BLOCK_KEYWORDS.some((keyword) => lower.includes(keyword));
}

// ─── Readability.js로 본문 추출 ─────────────────────
function extractWithReadability(html: string, url: string): string | null {
  try {
    const doc = new JSDOM(html, { url });
    const reader = new Readability(doc.window.document);
    const article = reader.parse();
    return article?.textContent?.trim() || null;
  } catch {
    return null;
  }
}

// ─── 단일 URL 콘텐츠 수집 ──────────────────────────
async function fetchPageContent(
  page: Page,
  url: string,
): Promise<{
  content_raw: string | null;
  screenshot: Buffer | null;
  blocked: boolean;
  blockReason?: string;
}> {
  try {
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForTimeout(2000);

    // 팝업/쿠키 배너 닫기
    await page
      .click(
        '[aria-label*="close"], .js-consent-banner button, [class*="cookie"] button',
        {
          timeout: 2000,
        },
      )
      .catch(() => {});

    // HTML 가져오기
    const html = await page.content();
    const innerText = await page.evaluate(() => document.body.innerText);

    // 1. 키워드 차단 체크
    if (isBlocked(innerText)) {
      const screenshot = await page.screenshot({ type: 'png' });
      return {
        content_raw: null,
        screenshot,
        blocked: true,
        blockReason: 'keyword_match',
      };
    }

    // 2. Readability.js로 본문 추출
    let content_raw = extractWithReadability(html, url);

    // 3. 실패 시 innerText 폴백
    if (!content_raw || content_raw.length < 100) {
      // innerText에서 기본 노이즈 제거
      content_raw = innerText.replace(/\n{3,}/g, '\n\n').trim();
    }

    // 4. 콘텐츠가 너무 짧으면 차단 의심 → 스크린샷 저장
    if (!content_raw || content_raw.length < CONTENT_MIN_LENGTH) {
      const screenshot = await page.screenshot({ type: 'png' });
      return {
        content_raw: content_raw || null,
        screenshot,
        blocked: false, // 확실한 차단은 아님, Phase B에서 Llama가 재확인
        blockReason: 'content_too_short',
      };
    }

    return {
      content_raw,
      screenshot: null,
      blocked: false,
    };
  } catch (error: any) {
    console.error(`      ❌ 페이지 로드 실패: ${error.message}`);
    return {
      content_raw: null,
      screenshot: null,
      blocked: true,
      blockReason: `fetch_error: ${error.message}`,
    };
  }
}

// ─── 유튜브 URL 판별 ────────────────────────────────
function isYoutubeUrl(url: string): boolean {
  return url.includes('youtube.com') || url.includes('youtu.be');
}

// ─── 메인 ───────────────────────────────────────────
async function main() {
  console.log('\n========================================');
  console.log(`🚀 [Phase A] 로컬 수집 시작 ${isDryRun ? '(DRY-RUN)' : ''}`);
  console.log('========================================\n');

  const startTime = performance.now();

  // Supabase 연결
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.error('❌ SUPABASE_URL / SUPABASE_KEY 환경변수가 없습니다.');
    process.exit(1);
  }

  const supabase: SupabaseClient = createClient(supabaseUrl, supabaseKey);

  // 스크린샷 디렉토리 생성
  if (!fs.existsSync(SCREENSHOT_DIR)) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  }

  // ─── Step 1: 링크 수집 (기존 scrapeAll 활용) ───
  console.log('📡 Step 1: 링크 수집 중...\n');
  const rawItems = await scrapeAll('weekly', FETCH_DAYS);

  console.log(`\n✅ ${rawItems.length}개 링크 수집 완료\n`);

  if (rawItems.length === 0) {
    console.log('수집된 항목이 없습니다. 종료.');
    process.exit(0);
  }

  // ─── Step 2: Supabase에 RAW 저장 (중복 스킵) ───
  console.log('💾 Step 2: RAW 상태로 DB 저장...\n');

  const dbRawData = rawItems.map((item) => ({
    title: item.title,
    link: item.link,
    date: item.date || new Date().toISOString(),
    status: 'RAW',
    source: item.source,
    category: item.category,
  }));

  if (!isDryRun) {
    const { error } = await supabase
      .from('article')
      .upsert(dbRawData, { onConflict: 'link', ignoreDuplicates: true });

    if (error) {
      console.error('⚠️ RAW 저장 실패:', error.message);
    } else {
      console.log(`✅ ${dbRawData.length}개 RAW 저장/스킵 완료\n`);
    }
  }

  // ─── Step 3: RAW 상태 항목 가져와서 콘텐츠 수집 ───
  console.log('🌐 Step 3: 콘텐츠 수집 시작 (Playwright + Readability)...\n');

  // RAW 상태인 항목만 조회 (아직 콘텐츠 수집 안 된 것들)
  const { data: rawDbItems, error: fetchError } = await supabase
    .from('article')
    .select('id, title, link, category, status')
    .is('content_raw', null)
    .in('status', ['RAW', 'ANALYZED'])
    .order('id', { ascending: true })
    .limit(50);

  if (fetchError || !rawDbItems) {
    console.error('❌ RAW 항목 조회 실패:', fetchError?.message);
    process.exit(1);
  }

  console.log(`📋 수집 대상: ${rawDbItems.length}개\n`);

  // YouTube는 Phase A에서 스킵 (transcript/description은 분석 시 처리)
  const webItems = rawDbItems.filter(
    (item) => !isYoutubeUrl(item.link) && !item.link.includes('x.com'),
  );
  const youtubeItems = rawDbItems.filter((item) => isYoutubeUrl(item.link));

  console.log(`🌐 웹 페이지: ${webItems.length}개`);
  console.log(`📹 YouTube (스킵): ${youtubeItems.length}개\n`);

  // YouTube는 바로 SCRAPED로 변경 (콘텐츠 수집 불필요)
  if (youtubeItems.length > 0 && !isDryRun) {
    const youtubeIds = youtubeItems.map((item) => item.id);
    await supabase
      .from('article')
      .update({ status: 'SCRAPED' })
      .in('id', youtubeIds);
    console.log(`📹 YouTube ${youtubeItems.length}개 → SCRAPED 처리\n`);
  }

  const xItems = rawDbItems.filter((item) => item.link.includes('x.com'));
  if (xItems.length > 0 && !isDryRun) {
    const xIds = xItems.map((item) => item.id);
    await supabase.from('article').update({ status: 'SCRAPED' }).in('id', xIds);
    console.log(
      `🐦 X(Twitter) ${xItems.length}개 → SCRAPED 처리 (Grok 담당)\n`,
    );
  }

  // Playwright 브라우저 시작 (headless=false로 차단 우회)
  const browser: Browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
  });

  // 수정: route 핸들러에 try-catch 추가 + URL 필터링
  await context.route('**/*', async (route) => {
    try {
      const url = route.request().url();
      // 브라우저 내부 URL은 무조건 통과
      if (
        url.startsWith('data:') ||
        url.startsWith('blob:') ||
        url.startsWith('about:')
      ) {
        return await route.continue();
      }
      const type = route.request().resourceType();
      if (['media', 'font'].includes(type)) {
        return await route.abort();
      }
      return await route.continue();
    } catch {
      // route가 이미 처리된 경우 무시
    }
  });

  const page = await context.newPage();

  let successCount = 0;
  let blockedCount = 0;
  let errorCount = 0;

  for (let i = 0; i < webItems.length; i++) {
    const item = webItems[i];
    const progress = `[${i + 1}/${webItems.length}]`;

    console.log(`${progress} ${item.title?.substring(0, 60)}...`);
    console.log(`         ${item.link}`);

    const result = await fetchPageContent(page, item.link);

    if (result.blocked) {
      blockedCount++;
      console.log(`         ❌ 차단: ${result.blockReason}`);

      // 스크린샷 저장
      if (result.screenshot) {
        const screenshotPath = path.join(
          SCREENSHOT_DIR,
          `blocked_${item.id}.png`,
        );
        try {
          fs.writeFileSync(screenshotPath, result.screenshot);
          console.log(`         📸 스크린샷 저장: ${screenshotPath}`);
        } catch (fsErr) {
          console.warn(`         ⚠️ 스크린샷 저장 실패 (무시): ${fsErr}`);
        }
      }
      continue;
    }

    if (!result.content_raw) {
      errorCount++;
      console.log(`         ⚠️ 콘텐츠 추출 실패`);
      continue;
    }

    // 콘텐츠가 짧은 경우 스크린샷도 저장
    if (result.screenshot) {
      const screenshotPath = path.join(SCREENSHOT_DIR, `short_${item.id}.png`);
      try {
        fs.writeFileSync(screenshotPath, result.screenshot);
        console.log(`         📸 짧은 콘텐츠 스크린샷: ${screenshotPath}`);
      } catch (fsErr) {
        console.warn(`         ⚠️ 스크린샷 저장 실패 (무시): ${fsErr}`);
      }
    }

    // DB 업데이트
    if (!isDryRun) {
      const updateData: any = { content_raw: result.content_raw };
      if (item.status === 'RAW') {
        updateData.status = 'SCRAPED';
      }

      const { error: updateError } = await supabase
        .from('article')
        .update(updateData)
        .eq('id', item.id);

      if (updateError) {
        console.log(`         ⚠️ DB 업데이트 실패: ${updateError.message}`);
        errorCount++;
      } else {
        successCount++;
        console.log(`         ✅ 저장 완료 (${result.content_raw.length}자)`);
        console.log(`         ─── 콘텐츠 미리보기 ───`);
        console.log(result.content_raw.substring(0, 300));
        console.log(`         ─── 끝 ───\n`);
      }
    } else {
      successCount++;
      console.log(
        `         [DRY-RUN] 콘텐츠 ${result.content_raw.length}자 추출됨`,
      );
      console.log(`         ─── 콘텐츠 미리보기 ───`);
      console.log(result.content_raw.substring(0, 300));
      console.log(`         ─── 끝 ───\n`);
    }

    // 요청 간 딜레이 (1~2초 랜덤)
    const delay = 1000 + Math.random() * 1000;
    await new Promise((r) => setTimeout(r, delay));
  }

  // 브라우저 종료
  await browser.close();

  // ─── 결과 출력 ───
  const endTime = performance.now();
  const durationSec = ((endTime - startTime) / 1000).toFixed(1);
  const durationMin = (Number(durationSec) / 60).toFixed(2);

  console.log('\n========================================');
  console.log('✅ [Phase A] 수집 완료');
  console.log(`   총 대상: ${webItems.length}개`);
  console.log(`   성공: ${successCount}개`);
  console.log(`   차단: ${blockedCount}개`);
  console.log(`   실패: ${errorCount}개`);
  console.log(`   YouTube (스킵): ${youtubeItems.length}개`);
  console.log(`   ⏱️ 소요: ${durationSec}초 (${durationMin}분)`);
  if (isDryRun) {
    console.log(`   ⚠️ DRY-RUN: DB 변경 없음`);
  }
  console.log('========================================\n');

  process.exit(0);
}

main().catch((err) => {
  console.error('❌ 치명적 에러:', err);
  process.exit(1);
});
