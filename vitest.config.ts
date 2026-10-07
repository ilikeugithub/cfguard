import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./example/wrangler.jsonc" },
      miniflare: {
        bindings: {
          CFGUARD_ADMIN_TOKEN: "test-token",
          // $0.001 per 5 minutes: ~1M D1 rows read or ~1K rows written trips the breaker.
          CFGUARD_MAX_USD_5M: "0.001",
          CFGUARD_SYNC_MS: "0",
          CFGUARD_REQ_MAX_ROWS_WRITTEN: "200",
        },
      },
    }),
  ],
  test: { include: ["test/**/*.test.ts"] },
});
