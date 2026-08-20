import { defineConfig } from "vitest/config";

// Cobertura medida sobre as rotas/serviços exercitados pelos testes
// (setup + projects); os demais serviços dependem de Docker/Stalwart.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: [
        "src/routes/setup.ts",
        "src/routes/projects.ts",
        "src/services/setup-state.ts",
        "src/services/setup-token.ts",
        "src/plugins/setup-auth.ts",
      ],
      reporter: ["text", "html"],
      thresholds: { lines: 70, functions: 90, branches: 75, statements: 70 },
    },
  },
});
