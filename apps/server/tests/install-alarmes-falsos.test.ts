/**
 * Alarmes falsos do install.sh numa reinstalação/atualização:
 *  1. deploy_running olha só o status do JOB (jobs[].status). Etapa/fase "running" de um job já terminado não é deploy
 *     em andamento. O script node de verdade roda aqui, contra um deploy-jobs.json de teste (docker falso no PATH).
 *  2. own_panel_domain devolve o domínio próprio quando o acesso pelo IP foi desativado, para o instalador testar e
 *     mostrar o endereço que o painel realmente usa (o sslip.io não existe mais no Caddy nesse caso).
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeDirSync } from "./helpers/tmp.js";

const raiz = path.resolve(__dirname, "../../..");
const sh = readFileSync(path.join(raiz, "scripts/install.sh"), "utf8");
const pegar = (nome: string) => sh.match(new RegExp(`^${nome}\\(\\) \\{[\\s\\S]*?^\\}`, "m"))?.[0] ?? "";

const pastas: string[] = [];
afterEach(() => {
  for (const p of pastas.splice(0)) removeDirSync(p);
});

function ambiente() {
  const dir = mkdtempSync(path.join(tmpdir(), "alarmes-falsos-"));
  pastas.push(dir);
  return dir;
}
function falso(dir: string, corpo: string) {
  const arquivo = path.join(dir, "docker");
  writeFileSync(arquivo, `#!/bin/bash\n${corpo}\n`);
  chmodSync(arquivo, 0o755);
}
const envDe = (dir: string) => ({ PATH: `${dir}:${path.dirname(process.execPath)}:/usr/bin:/bin` });

/** docker falso: `exec tws-panel node -e SCRIPT` roda o SCRIPT aqui, com /data apontando para a pasta de teste. */
function deployRunning(conteudo: string | null): number {
  const dir = ambiente();
  if (conteudo !== null) writeFileSync(path.join(dir, "deploy-jobs.json"), conteudo);
  falso(dir, `[ "$1" = exec ] && [ "$2" = tws-panel ] && [ "$3" = node ] || exit 1\nscript="\${5//\\/data\\//${dir}/}"\nexec node -e "$script"`);
  const r = spawnSync("bash", ["-c", `${pegar("deploy_running")}\ndeploy_running`], { encoding: "utf8", env: envDe(dir) });
  expect(r.stdout).toBe("");
  return r.status ?? -1;
}

const job = (status: string, extra: object = {}) => ({ id: "j", projectId: "p", status, log: "x", ...extra });

describe("install.sh — deploy_running (status do job, não das etapas)", () => {
  it("job terminado com etapa e fase ainda 'running' NÃO conta como deploy", () => {
    const arquivo = JSON.stringify({ jobs: [job("success", { steps: [{ name: "build", status: "running" }], phases: [{ name: "x", status: "running" }] }), job("failed", { steps: [{ name: "a", status: "running" }] })] }, null, 2);
    expect(arquivo).toMatch(/"status": "running"/);
    expect(deployRunning(arquivo)).toBe(1);
  });

  it("job 'running' conta", () => {
    expect(deployRunning(JSON.stringify({ jobs: [job("success"), job("running")] }, null, 2))).toBe(0);
  });

  it("job 'queued' conta", () => {
    expect(deployRunning(JSON.stringify({ jobs: [job("queued")] }))).toBe(0);
  });

  it("arquivo ausente, JSON inválido ou formato inesperado: sem deploy", () => {
    expect(deployRunning(null)).toBe(1);
    expect(deployRunning("{ quebrado")).toBe(1);
    expect(deployRunning(JSON.stringify({ jobs: "x" }))).toBe(1);
    expect(deployRunning("null")).toBe(1);
  });

  it("erro que não é 'sem deploy' (node ausente, 127): segue sem deploy, mas avisa uma vez", () => {
    const dir = ambiente();
    falso(dir, "exit 127");
    const r = spawnSync("bash", ["-c", `warn() { echo "AVISO $*"; }\n${pegar("deploy_running")}\ndeploy_running; a=$?; deploy_running; b=$?; echo "$a $b"`], { encoding: "utf8", env: envDe(dir) });
    expect(r.stdout.match(/AVISO Não consegui conferir/g)).toHaveLength(1);
    expect(r.stdout).toMatch(/código 127/);
    expect(r.stdout.trim().endsWith("1 1")).toBe(true);
  });

  it("painel parado (docker exec falha): sem deploy", () => {
    const dir = ambiente();
    falso(dir, "exit 1");
    const r = spawnSync("bash", ["-c", `warn() { echo "AVISO $*"; }\n${pegar("deploy_running")}\ndeploy_running`], { encoding: "utf8", env: envDe(dir) });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
  });
});

describe("install.sh — domínio do painel numa reinstalação", () => {
  function domainFrom(json: string | null): string {
    const dir = ambiente();
    if (json !== null) writeFileSync(path.join(dir, "panel-domain.json"), json);
    // só responde se o pedido for ler /data/panel-domain.json do volume paas_data
    falso(dir, `args="$*"\ncase "$args" in *"-v paas_data:/data"*"cat /data/panel-domain.json"*) ;; *) exit 1 ;; esac\ncat "${dir}/panel-domain.json" 2>/dev/null || true`);
    const r = spawnSync("bash", ["-c", `set -euo pipefail; VOLUME_NAME=paas_data\n${pegar("own_panel_domain")}\nown_panel_domain`], { encoding: "utf8", env: envDe(dir) });
    expect(r.status).toBe(0);
    return r.stdout.trim();
  }
  const estado = (extra: object) => JSON.stringify({ domain: "painel.example.com", active: true, ipAccessDisabled: false, lastCheck: null, updatedAt: null, ...extra }, null, 2) + "\n";

  it("acesso pelo IP desativado: usa o domínio próprio", () => {
    expect(domainFrom(estado({ ipAccessDisabled: true }))).toBe("painel.example.com");
  });

  it("acesso pelo IP desativado mas domínio ainda não ativo: não usa o domínio próprio", () => {
    expect(domainFrom(estado({ ipAccessDisabled: true, active: false }))).toBe("");
  });

  it("acesso pelo IP ativo, arquivo ausente ou vazio: nada (segue o endereço sslip.io)", () => {
    expect(domainFrom(estado({}))).toBe("");
    expect(domainFrom(null)).toBe("");
    expect(domainFrom("")).toBe("");
  });

  it("o instalador troca o endereço testado só depois de gravar o .env (PAAS_PANEL_DOMAIN não muda)", () => {
    const gravaEnv = sh.indexOf('env_set PAAS_PANEL_DOMAIN "$PANEL_DOMAIN"');
    const consulta = sh.indexOf('OWN_DOMAIN="$(own_panel_domain)"');
    const teste = sh.indexOf('curl -fsS --max-time 5 -o /dev/null "https://$PANEL_DOMAIN/api/healthz"');
    expect(gravaEnv).toBeGreaterThan(0);
    expect(consulta).toBeGreaterThan(gravaEnv);
    expect(teste).toBeGreaterThan(consulta);
  });
});
