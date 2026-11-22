import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// End-to-end: needs a running worker (see ../scripts/e2e.sh). Not part of `npm test`.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: { include: ["e2e/**/*.e2e.ts"], testTimeout: 20_000, disableConsoleIntercept: true },
});
