import dotenv from "dotenv";
import path from "path";
import fs from "fs";
console.log("asd");
// ──────────────────────────────────────────────────────────
// .env 파일 찾기 (모노레포 고려해서 여러 경로 시도)
// ──────────────────────────────────────────────────────────
let envPath = path.resolve(process.cwd(), ".env"); // 1순위: 스크립트 실행한 디렉토리 기준

if (!fs.existsSync(envPath)) {
  envPath = path.resolve(__dirname, "../../.env"); // 2순위: src/scripts → 프로젝트 루트
}

if (!fs.existsSync(envPath)) {
  envPath = path.resolve(__dirname, "../../../.env"); // 3순위: 기존 경로
}

if (!fs.existsSync(envPath)) {
  console.error("❌ .env 파일을 어디서도 찾을 수 없습니다.");
  console.log("현재 cwd:", process.cwd());
  console.log("__dirname:", __dirname);
  process.exit(1);
}

console.log("✅ .env 파일 발견:", envPath);
console.log("파일 크기:", fs.statSync(envPath).size, "bytes");

dotenv.config({ path: envPath, override: true });

// 로드 확인 로그 (중요!)
console.log("GEMINI_API_KEY 로드 여부:", !!process.env.GEMINI_API_KEY);
console.log("SUPABASE_URL 로드 여부:", !!process.env.SUPABASE_URL);

import { performance } from "perf_hooks";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { runAnalysis } from "trendiv-analysis-module";
import { AnalysisResult, FailedAnalysisResult } from "trendiv-analysis-module";

// Dry-run 모드 확인 (CLI 인자 또는 환경변수)
const isDryRun = process.argv.includes("--dry-run");

const main = async () => {
  console.log("\n========================================");
  console.log(
    `🔄 [Manual] Analyze RAW Data Status Start ${isDryRun ? "(DRY-RUN MODE)" : ""}`,
  );
  console.log("========================================");

  const startTime = performance.now();

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.error("❌ Error: Supabase 환경변수가 로드되지 않았습니다.");
    process.exit(1);
  }

  const supabase: SupabaseClient = createClient(supabaseUrl, supabaseKey);
  const targetModel = process.env.GEMINI_MODEL || "gemini-3-flash-preview";

  // 전체 RAW 개수 미리 세기 (진행률 표시용)
  const { count: totalRaw, error: countError } = await supabase
    .from("article")
    .select("*", { count: "exact", head: true })
    .eq("status", "RAW");

  if (countError) {
    console.error("❌ 전체 RAW 개수 조회 실패:", countError.message);
    process.exit(1);
  }

  const totalRawCount = totalRaw || 0;
  console.log(`📊 전체 RAW 항목 수: ${totalRawCount}개`);

  let totalProcessed = 0;
  let totalAnalyzed = 0;
  let totalRejected = 0;
  let totalFail = 0;
  let batchCount = 0;
  const BATCH_SIZE = 10;

  try {
    while (true) {
      batchCount++;
      // 배치당 카운트 초기화
      let batchAnalyzed = 0;
      let batchRejected = 0;
      let batchFail = 0;

      console.log(`\n📦 [Batch ${batchCount}] RAW 데이터를 찾는 중...`);

      const { data: targetItems, error: fetchError } = await supabase
        .from("article")
        .select("*")
        .eq("status", "RAW")
        .order("id", { ascending: true })
        .limit(BATCH_SIZE);

      if (fetchError) {
        console.error("❌ RPC 호출 에러:", fetchError.message);
        break;
      }

      if (!targetItems || targetItems.length === 0) {
        console.log("✅ 모든 RAW 데이터 분석이 완료되었습니다!");
        break;
      }

      console.log(`🎯 ${targetItems.length}개의 항목 분석 시작...`);

      try {
        const analysisResults = await runAnalysis(targetItems);

        if (analysisResults && analysisResults.length > 0) {
          const updates = analysisResults.map((result: any) => {
            const original = targetItems.find((t: any) => t.id === result.id);
            const history = original?.analysis_results || [];

            if ("status" in result && result.status === "FAIL") {
              console.log(
                `❌ ID ${result.id} | ${original.title.substring(0, 60)}`,
              );
              console.log(
                `   → FAIL: ${result.failReason || "Unknown reason"}\n`,
              );
              batchFail++;
              return {
                ...original,
                id: result.id,
                status: "FAIL",
                content: original?.content,
              };
            } else {
              const r = result as AnalysisResult;
              console.log(`✅ ID ${r.id} | ${original.title.substring(0, 60)}`);
              console.log(`   점수: ${r.score}/10`);
              console.log(`   한국어 제목: ${r.title_ko}`);
              console.log(`   한줄 요약: ${r.oneLineSummary}`);
              console.log(`   태그: ${r.tags.join(", ")}`);
              if (r.score === 0) {
                console.log(`   → REJECTED (0점)\n`);
              } else {
                console.log(`   → ANALYZED\n`);
              }
            }

            const successResult = result as AnalysisResult;

            const newEntry = {
              aiModel: successResult.aiModel,
              score: successResult.score,
              reason: successResult.reason || "",
              title_ko: successResult.title_ko || "",
              oneLineSummary: successResult.oneLineSummary || "",
              keyPoints: successResult.keyPoints || [],
              tags: successResult.tags || [],
              analyzedAt: new Date().toISOString(),
            };

            const updatedHistory = [...history, newEntry];
            const representResult = [...updatedHistory].sort(
              (a, b) => b.score - a.score,
            )[0];

            if (successResult.score > 0) {
              batchAnalyzed++;
            } else {
              batchRejected++;
            }

            return {
              ...original,
              id: successResult.id,
              analysis_results: updatedHistory,
              status: successResult.score > 0 ? "ANALYZED" : "REJECTED",
              represent_result: representResult,
              content: successResult.content || original?.content,
            };
          });

          // 배치 결과 출력 (배치 카운트 사용)
          console.log(
            `   → 이번 배치 결과: ANALYZED ${batchAnalyzed}개 | REJECTED ${batchRejected}개 | FAIL ${batchFail}개`,
          );

          // Dry-run 모드에서는 실제 DB 업데이트 스킵 + 미리보기 로그
          if (isDryRun) {
            console.log(`   [DRY-RUN] 실제 DB 업데이트는 하지 않습니다.`);
            console.log(
              `   [DRY-RUN] 업데이트 될 데이터 예시 (${updates.length}건):`,
            );
            updates.forEach((u: any, i: number) => {
              console.log(`     ${i + 1}. ID ${u.id} → status: ${u.status}`);
              if (u.status === "ANALYZED" || u.status === "REJECTED") {
                console.log(
                  `        대표 점수: ${u.represent_result?.score || "N/A"}`,
                );
              }
            });
          } else {
            const { error: upsertError } = await supabase
              .from("article")
              .upsert(updates, { onConflict: "id" });

            if (upsertError) {
              console.error(
                `⚠️ Batch ${batchCount} 저장 실패:`,
                upsertError.message,
              );
            } else {
              totalProcessed += updates.length;
              totalAnalyzed += batchAnalyzed;
              totalRejected += batchRejected;
              totalFail += batchFail;
              console.log(
                `💾 Batch ${batchCount} 완료 (누적: ${totalProcessed}/${totalRawCount})`,
              );
            }
          }
        }
      } catch (analysisError) {
        console.error(
          `⚠️ Batch ${batchCount} 분석 중 에러 발생:`,
          analysisError,
        );
      }

      // 진행률 표시
      const progress = totalProcessed / totalRawCount;
      console.log(
        `진행률: ${totalProcessed}/${totalRawCount} (${(progress * 100).toFixed(1)}%)`,
      );

      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  } catch (error) {
    console.error("❌ 치명적 에러 발생:", error);
    process.exit(1);
  }

  const endTime = performance.now();
  const durationSec = ((endTime - startTime) / 1000).toFixed(1);
  const durationMin = (Number(durationSec) / 60).toFixed(2);

  console.log("\n========================================");
  console.log(`✅ 작업 완료`);
  console.log(`   총 처리 항목: ${totalProcessed} / ${totalRawCount}`);
  console.log(`   ANALYZED: ${totalAnalyzed}`);
  console.log(`   REJECTED: ${totalRejected}}`);
  console.log(`   FAIL    : ${totalFail}`);
  console.log(`   ⏱️  소요 시간: ${durationSec}초 (${durationMin}분)`);
  if (isDryRun) {
    console.log(`   ⚠️ DRY-RUN 모드였으므로 실제 DB는 변경되지 않았습니다.`);
  }
  console.log("========================================");

  process.exit(0);
};

main();
