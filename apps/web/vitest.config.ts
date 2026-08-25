import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.{ts,tsx}"],
    css: false,
    coverage: {
      provider: "v8",
      // componentes exercitados pelos testes (wizard, saúde, DNS, guardrails)
      include: [
        "src/pages/setup/**",
        "src/pages/MailDomainPage.tsx",
        "src/pages/ProjectDetailPage.tsx",
        "src/components/TerminalPanel.tsx",
        "src/lib/**",
      ],
      reporter: ["text", "html"],
    },
  },
});
