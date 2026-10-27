/**
 * Domínios dinâmicos numa instalação normal: o compose precisa repassar ao painel o IP público da VPS e a
 * porta do ask (sem isso o `.env` não tem efeito e nenhum certificado de cliente sai), e o instalador
 * precisa gravar o IP que detecta. Verificação de texto, mais a execução REAL do trecho do install.sh.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const raiz = path.resolve(__dirname, "../../..");
const ler = (arquivo: string) => readFileSync(path.join(raiz, arquivo), "utf8");

const pastas: string[] = [];
afterEach(() => {
  for (const p of pastas.splice(0)) rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("docker-compose.yml", () => {
  it.each(["PAAS_PUBLIC_IP", "PAAS_PUBLIC_IPV6", "PAAS_ASK_PORT"])("repassa %s ao painel, vazia por padrão", (nome) => {
    expect(ler("docker-compose.yml")).toContain(`      ${nome}: \${${nome}:-}`);
  });
});

describe("install.sh grava o IP público detectado", () => {
  /** Roda o bloco real do instalador (env_set, env_value e o `if` do IP) numa pasta com um .env inicial. */
  function rodar(inicial: string | null, httpsIp: string): { env: string; saida: string } {
    const sh = ler("scripts/install.sh");
    const fn = (nome: string) => {
      const m = sh.match(new RegExp(`^${nome}\\(\\) \\{[\\s\\S]*?^\\}`, "m"));
      if (!m) throw new Error(`${nome} não encontrada no install.sh`);
      return m[0];
    };
    const bloco = sh.match(/^if \[ -n "\$\{HTTPS_IP:-\}" \] && \[ -z "\$\(env_value PAAS_PUBLIC_IP\)" \]; then[\s\S]*?^fi$/m);
    if (!bloco) throw new Error("bloco do IP não encontrado no install.sh");
    const pasta = mkdtempSync(path.join(tmpdir(), "ip-install-"));
    pastas.push(pasta);
    if (inicial !== null) writeFileSync(path.join(pasta, ".env"), inicial);
    const script = `EARLY_ENV_FILE=.env\nlog() { echo "$*"; }\n${fn("env_set")}\n${fn("env_value")}\nHTTPS_IP="$1"\n${bloco[0]}\n`;
    const r = spawnSync("bash", ["-c", script, "x", httpsIp], { cwd: pasta, encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
    expect(r.status, r.stderr).toBe(0);
    let env = "";
    try {
      env = readFileSync(path.join(pasta, ".env"), "utf8");
    } catch {
      // sem .env
    }
    return { env, saida: r.stdout };
  }

  it("grava o IP quando o .env ainda não tem valor", () => {
    const r = rodar("PAAS_ACCESS=https\n", "203.0.113.10");
    expect(r.env).toContain("PAAS_PUBLIC_IP=203.0.113.10");
    expect(r.saida).toContain("203.0.113.10");
  });

  it("não sobrescreve um IP já escolhido à mão (atrás de NAT, por exemplo)", () => {
    const r = rodar("PAAS_PUBLIC_IP=198.51.100.5\n", "203.0.113.10");
    expect(r.env).toContain("PAAS_PUBLIC_IP=198.51.100.5");
    expect(r.env).not.toContain("203.0.113.10");
  });

  it("sem IP detectado não grava nada", () => {
    const r = rodar("PAAS_ACCESS=https\n", "");
    expect(r.env).not.toContain("PAAS_PUBLIC_IP");
  });
});
