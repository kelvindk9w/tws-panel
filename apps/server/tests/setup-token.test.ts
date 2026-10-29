/**
 * Testes do setup token (setup-token.ts): prioridade da env sobre o arquivo,
 * fallback e comparação em tempo constante.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSetupToken, tokenMatches } from "../src/services/setup-token.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-token-"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("loadSetupToken", () => {
  // Lote 7 (M3): a prioridade se inverteu — o arquivo vale mais que a variável
  // (ver setup-token-ciclo.test.ts); aqui fica só o contrato do fallback.
  it("o arquivo tem prioridade sobre a variável de ambiente SETUP_TOKEN", async () => {
    const file = path.join(dir, "token");
    await writeFile(file, "token-do-arquivo\n");
    vi.stubEnv("SETUP_TOKEN", "token-da-env");
    expect(await loadSetupToken(file)).toBe("token-do-arquivo");
  });

  it("sem arquivo, usa a variável de ambiente", async () => {
    vi.stubEnv("SETUP_TOKEN", "token-da-env");
    expect(await loadSetupToken(path.join(dir, "nao-existe"))).toBe("token-da-env");
  });

  it("lê o arquivo quando a env está ausente (e faz trim)", async () => {
    vi.stubEnv("SETUP_TOKEN", "");
    const file = path.join(dir, "token");
    await writeFile(file, "  token-do-arquivo  \n");
    expect(await loadSetupToken(file)).toBe("token-do-arquivo");
  });

  it("arquivo inexistente e sem env → null", async () => {
    vi.stubEnv("SETUP_TOKEN", "");
    expect(await loadSetupToken(path.join(dir, "nao-existe"))).toBeNull();
  });
});

describe("tokenMatches", () => {
  it("aceita token idêntico e rejeita qualquer divergência", () => {
    expect(tokenMatches("segredo-123", "segredo-123")).toBe(true);
    expect(tokenMatches("segredo-124", "segredo-123")).toBe(false);
  });

  it("rejeita comprimentos diferentes sem lançar (timingSafeEqual exige igual tamanho)", () => {
    expect(tokenMatches("curto", "muito-mais-longo")).toBe(false);
    expect(tokenMatches("", "qualquer")).toBe(false);
  });
});
