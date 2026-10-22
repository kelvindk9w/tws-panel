/**
 * Deploy — linha de aviso no log quando uma variável de host (SITE_HOST…) foi
 * salva com esquema, barra, porta ou espaço. Só avisa: o deploy segue.
 * Nunca imprime o valor de variável com cara de segredo.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/exec.js", () => ({
  run: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
  runStream: vi.fn(async () => 0),
}));

const { DeployEngine } = await import("../src/engine.js");

type Privado = { warnHostVariables(vars: Record<string, string>, onLog: (c: string) => void): void };
const engine = () =>
  new DeployEngine({ projectsDir: "/tmp/x", caddyDir: "/tmp/x/caddy", nodeImage: "node:22", staticImage: "nginx:alpine", caddyHttpPort: 80, caddyHttpsPort: 443 }) as unknown as Privado;

describe("aviso de variável de host no log do deploy", () => {
  it("acrescenta uma linha por variável estranha e ignora as corretas e as *_URL", () => {
    const log: string[] = [];
    engine().warnHostVariables(
      { SITE_HOST: "http://site.example.com", CARTEIRA_HOST: "https://carteira.example.com/", OK_HOST: "ok.example.com", SITE_URL: "https://x.example.com/" },
      (c) => log.push(c),
    );
    const texto = log.join("");
    expect(log).toHaveLength(2);
    expect(texto).toContain("SITE_HOST");
    expect(texto).toContain("CARTEIRA_HOST");
    expect(texto).toContain("site.example.com");
    expect(texto).not.toContain("OK_HOST");
    expect(texto).not.toContain("SITE_URL");
  });

  it("não imprime o valor de variável com nome de segredo", () => {
    const log: string[] = [];
    engine().warnHostVariables({ AUTH_HOST: "https://oculto.example.com" }, (c) => log.push(c));
    expect(log.join("")).toContain("AUTH_HOST");
    expect(log.join("")).not.toContain("oculto.example.com");
  });

  it("sem variável estranha, não escreve nada", () => {
    const log: string[] = [];
    engine().warnHostVariables({ A_HOST: "a.example.com" }, (c) => log.push(c));
    expect(log).toEqual([]);
  });
});
