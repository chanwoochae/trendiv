import * as dotenv from "dotenv";
import * as path from "path";
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

import { notifyXaiBalance } from "../services/xai-balance.service";

notifyXaiBalance("수동 실행").catch((e) => {
  console.error("❌ 오류:", e.message);
  process.exit(1);
});
