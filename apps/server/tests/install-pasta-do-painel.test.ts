/**
 * A pasta de instalação do painel (a que guarda o .env com os segredos) precisa chegar ao processo do
 * painel mesmo quando o instalador foi usado com outra pasta que não /opt/tws-panel. Verificação de
 * texto sobre o install.sh e o docker-compose.yml, mais a execução REAL da função env_set extraída
 * do script (o instalador inteiro não é executado aqui).
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
  for (const p of pastas.splice(0)) rmSync(p, { recursive: true, force: true });
});

/** Roda a env_set do install.sh dentro de uma pasta com um .env inicial e devolve o .env final. */
function rodarEnvSet(inicial: string | null, chave: string, valor: string): string {
  const sh = ler("scripts/install.sh");
  const m = sh.match(/^env_set\(\) \{[\s\S]*?^\}/m);
  if (!m) throw new Error("env_set não encontrada no install.sh");
  const pasta = mkdtempSync(path.join(tmpdir(), "envset-"));
  pastas.push(pasta);
  if (inicial !== null) writeFileSync(path.join(pasta, ".env"), inicial);
  const r = spawnSync("bash", ["-c", `${m[0]}\nenv_set "$1" "$2"`, "x", chave, valor], { cwd: pasta, encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
  return readFileSync(path.join(pasta, ".env"), "utf8");
}

describe("PAAS_HOST_REPO_DIR (pasta de instalação no host)", () => {
  it("o docker-compose.yml repassa a variável ao container, com o padrão antigo", () => {
    expect(ler("docker-compose.yml")).toMatch(/PAAS_HOST_REPO_DIR:\s*\$\{PAAS_HOST_REPO_DIR:-\/opt\/tws-panel\}/);
  });

  it("o install.sh grava o caminho REAL da instalação (APP_DIR) no .env, sobrescrevendo valor antigo", () => {
    expect(ler("scripts/install.sh")).toMatch(/env_set PAAS_HOST_REPO_DIR "\$APP_DIR"/);
  });

  it("APP_DIR é resolvido (pwd -P) depois do cd: link e PAAS_DIR relativo viram o caminho real e absoluto", () => {
    const sh = ler("scripts/install.sh");
    expect(sh).toMatch(/cd "\$APP_DIR"\n(#[^\n]*\n)?APP_DIR="\$\(pwd -P\)"/);
    expect(sh).toMatch(/APP_DIR="\$\(cd "\$SCRIPT_DIR\/\.\." && pwd -P\)"/);
  });

  it("env_set aceita '#', '&', '|' e '\\' no caminho (nada de sed com delimitador) e troca o valor antigo", () => {
    const caminho = "/home/x#y/a&b|c\\d/tws-panel";
    const final = rodarEnvSet("A=1\nPAAS_HOST_REPO_DIR=/opt/tws-panel\nB=2\n", "PAAS_HOST_REPO_DIR", caminho);
    expect(final.split("\n")).toContain(`PAAS_HOST_REPO_DIR=${caminho}`);
    expect(final).not.toContain("/opt/tws-panel");
    expect(final).toContain("A=1\n");
    expect(final).toContain("B=2\n");
    expect(final.match(/PAAS_HOST_REPO_DIR=/g)).toHaveLength(1);
  });

  it("env_set cria o .env quando não existe e não confunde chaves com o mesmo prefixo", () => {
    expect(rodarEnvSet(null, "PAAS_HOST_REPO_DIR", "/srv/p")).toBe("PAAS_HOST_REPO_DIR=/srv/p\n");
    const final = rodarEnvSet("PAAS_HOST_REPO_DIR_X=1\n", "PAAS_HOST_REPO_DIR", "/srv/p");
    expect(final).toContain("PAAS_HOST_REPO_DIR_X=1\n");
    expect(final).toContain("PAAS_HOST_REPO_DIR=/srv/p\n");
  });

  it("o PAAS_PROJECTS_DIR também é gravado por env_set (o sed com '#' quebrava com '#' no caminho)", () => {
    expect(ler("scripts/install.sh")).toMatch(/env_set PAAS_PROJECTS_DIR "\$PROJECTS_DIR"/);
  });
});
