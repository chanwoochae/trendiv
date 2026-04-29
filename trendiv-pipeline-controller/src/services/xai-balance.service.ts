import * as dotenv from "dotenv";
import * as path from "path";
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const XAI_MANAGEMENT_KEY = process.env.XAI_MANAGEMENT_KEY;
const TEAM_ID = process.env.XAI_TEAM_ID;
const WEBHOOK_URL =
  process.env.DISCORD_BALANCE_WEBHOOK ||
  process.env.DISCORD_PIPELINE_WEBHOOK;

interface InvoiceLine {
  description: string;
  unitType: string;
  numUnits: string;
  amount: string;
}

interface InvoiceResponse {
  coreInvoice: {
    lines: InvoiceLine[];
    totalWithCorr: { val: string };
    prepaidCredits: { val: string };
    prepaidCreditsUsed: { val: string };
  };
  billingCycle: { year: number; month: number };
}

function aggregateByModel(lines: InvoiceLine[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const line of lines) {
    const amount = parseInt(line.amount, 10);
    if (amount === 0) continue;
    if (!result[line.description]) result[line.description] = 0;
    result[line.description] += amount;
  }
  return result;
}

export async function notifyXaiBalance(trigger?: string): Promise<void> {
  if (!XAI_MANAGEMENT_KEY || !TEAM_ID || !WEBHOOK_URL) {
    console.warn("⚠️ [xAI Balance] 환경변수 누락 — 알림 스킵");
    return;
  }

  try {
    const res = await fetch(
      `https://management-api.x.ai/v1/billing/teams/${TEAM_ID}/postpaid/invoice/preview`,
      {
        headers: {
          Authorization: `Bearer ${XAI_MANAGEMENT_KEY}`,
          "Content-Type": "application/json",
        },
      },
    );

    if (!res.ok) {
      console.warn(`⚠️ [xAI Balance] API 오류 ${res.status} — 알림 스킵`);
      return;
    }

    const data = (await res.json()) as InvoiceResponse;
    const { coreInvoice, billingCycle } = data;

    const prepaidTotal = Math.abs(parseInt(coreInvoice.prepaidCredits.val, 10));
    const prepaidUsed = Math.abs(parseInt(coreInvoice.prepaidCreditsUsed.val, 10));
    const remaining = prepaidTotal - prepaidUsed;
    const thisMonthSpend = parseInt(coreInvoice.totalWithCorr.val, 10);

    const remainingDollar = (remaining / 100).toFixed(2);
    const thisMonthDollar = (thisMonthSpend / 100).toFixed(2);
    const remainingNum = parseFloat(remainingDollar);

    let color = 0x00e5c8;
    let statusEmoji = "✅";
    if (remainingNum < 1) {
      color = 0xef4444;
      statusEmoji = "🚨";
    } else if (remainingNum < 5) {
      color = 0xf59e0b;
      statusEmoji = "⚠️";
    }

    const byModel = aggregateByModel(coreInvoice.lines);
    const modelLines = Object.entries(byModel)
      .sort((a, b) => b[1] - a[1])
      .map(([model, cents]) => `\`${model}\` $${(cents / 100).toFixed(3)}`)
      .join("\n");

    const cycleStr = `${billingCycle.year}.${String(billingCycle.month).padStart(2, "0")}`;
    const triggerStr = trigger ? ` (${trigger} 완료 후)` : "";

    const payload = {
      embeds: [
        {
          title: `${statusEmoji} xAI (Grok) API 잔액 현황${triggerStr}`,
          color,
          fields: [
            {
              name: "💰 남은 잔액",
              value: `**$${remainingDollar}**`,
              inline: true,
            },
            {
              name: `📉 ${cycleStr} 사용액`,
              value: `$${thisMonthDollar}`,
              inline: true,
            },
            ...(modelLines
              ? [{ name: "🤖 모델별 사용", value: modelLines, inline: false }]
              : []),
          ],
          footer: {
            text: `xAI Console • ${new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })} KST`,
          },
        },
      ],
    };

    await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    console.log(`💰 [xAI Balance] 잔액 알림 전송: $${remainingDollar}`);
  } catch (e) {
    console.warn("⚠️ [xAI Balance] 알림 전송 실패:", (e as Error).message);
  }
}
