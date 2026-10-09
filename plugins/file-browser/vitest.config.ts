import path from "node:path";
import { defineConfig } from "vitest/config";

// The `@/*` alias mirrors tsconfig's paths so the app test resolves the
// components the same way `bb plugin build` does.
export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, ".") } },
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts", "server.test.ts", "app.test.tsx"],
  },
});
