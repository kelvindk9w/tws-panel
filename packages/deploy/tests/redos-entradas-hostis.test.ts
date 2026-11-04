import { describe, expect, it } from "vitest";
import { parseIssuedCertificates } from "../src/caddy-storage.js";
import { checkComposeModel } from "../src/compose-model.js";
import { classifyGitFailure } from "../src/git-access.js";
import { composeVariables } from "../src/project-dotenv.js";

const limite = (t0: number) => expect(Date.now() - t0).toBeLessThan(2000);

describe("entradas gigantes e repetitivas não travam (ReDoS)", () => {
  it("certificados do Caddy: muitos BEGIN seguidos, sem END", () => {
    const t0 = Date.now();
    const out = parseIssuedCertificates(`### /x/a/a.example.com/a.example.com.crt\n${"-----BEGIN CERTIFICATE-----\n".repeat(50_000)}`);
    expect(out.size).toBe(0);
    limite(t0);
  });

  it("falha do git: 'transport' e 'protocol' repetidos, e as mensagens reais seguem reconhecidas", () => {
    const t0 = Date.now();
    expect(classifyGitFailure("transport '".repeat(50_000), false)).toBe("unknown");
    expect(classifyGitFailure("protocol ".repeat(50_000), false)).toBe("unknown");
    limite(t0);
    expect(classifyGitFailure("fatal: transport 'file' not allowed", false)).toBe("unsupported_host");
    expect(classifyGitFailure("fatal: protocol 'foo' is not supported", false)).toBe("unsupported_host");
  });

  it("compose: env_file com milhares de linhas em branco, e as formas comuns continuam detectadas", () => {
    const t0 = Date.now();
    expect(composeVariables("env_file:\n" + "\n".repeat(100_000)).usesEnvFile).toBe(false);
    limite(t0);
    expect(composeVariables("services:\n  a:\n    env_file: .env\n").usesEnvFile).toBe(true);
    expect(composeVariables("services:\n  a:\n    env_file:\n      - .env\n").usesEnvFile).toBe(true);
    expect(composeVariables("services:\n  a:\n    env_file:\n\n      - '.env'\n").usesEnvFile).toBe(true);
    expect(composeVariables("services:\n  a:\n    env_file: ./outro.env\n").usesEnvFile).toBe(false);
  });

  it("compose: caminho com milhares de barras no fim ainda é reconhecido como o socket do Docker", () => {
    const t0 = Date.now();
    const model = { services: { a: { image: "x", volumes: [`/var/run/docker.sock${"/".repeat(100_000)}:/s`] } } };
    const found = checkComposeModel(model, { fileName: "docker-compose.yml", srcRoot: "/srv/app", mode: "canonical" });
    expect(found.length).toBeGreaterThan(0);
    limite(t0);
  });
});
