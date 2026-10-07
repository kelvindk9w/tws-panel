/**
 * reativar-acesso-ip-script.test.ts — saída de emergência de quem desativou o
 * acesso pelo IP e perdeu o acesso pelo domínio (DNS apagado, domínio vencido,
 * certificado que não renovou).
 *
 *  - scripts/reativar-acesso-ip.mjs: no panel-domain.json (volume paas_data),
 *    volta ipAccessDisabled para false e não toca em mais nada.
 *  - scripts/reativar-acesso-ip.sh: para o painel, roda o .mjs dentro da
 *    imagem do painel, sobe o painel (que remonta o proxy com o endereço pelo
 *    IP no boot) e confere que o Caddyfile voltou a ter o endereço. O teste
 *    usa um `docker` falso no PATH: nada de Docker de verdade.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPTS = path.resolve(__dirname, "../../../scripts");
const MJS = path.join(SCRIPTS, "reativar-acesso-ip.mjs");
const SH = path.join(SCRIPTS, "reativar-acesso-ip.sh");
const IP_HOST = "203-0-113-10.sslip.io";
const DOMAIN = "painel.exemplo.com.br";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-reativar-ip-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const desativado = {
  domain: DOMAIN,
  active: true,
  ipAccessDisabled: true,
  lastCheck: null,
  updatedAt: "2026-10-07T10:00:00.000Z",
};

describe("scripts/reativar-acesso-ip.mjs", () => {
  it("reativa o acesso pelo IP e mantém o domínio, com permissão 0600", async () => {
    const file = path.join(dir, "panel-domain.json");
    await writeFile(file, JSON.stringify(desativado), { mode: 0o600 });
    const out = execFileSync("node", [MJS, file], { encoding: "utf8" });
    expect(out).toMatch(/reativado/i);
    const saved = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    expect(saved.ipAccessDisabled).toBe(false);
    expect(saved.domain).toBe(DOMAIN);
    expect(saved.active).toBe(true);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("já ativo, ou sem arquivo: diz isso e não grava nada", async () => {
    const file = path.join(dir, "panel-domain.json");
    expect(execFileSync("node", [MJS, file], { encoding: "utf8" })).toMatch(/já está ativo/i);
    const conteudo = JSON.stringify({ ...desativado, ipAccessDisabled: false });
    await writeFile(file, conteudo);
    expect(execFileSync("node", [MJS, file], { encoding: "utf8" })).toMatch(/já está ativo/i);
    expect(await readFile(file, "utf8")).toBe(conteudo);
  });

  it("arquivo ilegível: troca por um sem domínio (o painel volta só pelo IP) e avisa", async () => {
    const file = path.join(dir, "panel-domain.json");
    await writeFile(file, "{ lixo");
    const out = execFileSync("node", [MJS, file], { encoding: "utf8" });
    expect(out).toMatch(/ilegível/i);
    const saved = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    expect(saved).toMatchObject({ domain: null, ipAccessDisabled: false });
  });

  it("sem argumento: erro de uso (código 2)", () => {
    const r = spawnSync("node", [MJS], { encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/uso/);
  });
});

describe("scripts/reativar-acesso-ip.sh (docker falso)", () => {
  /**
   * Monta /opt/tws-panel de mentira: scripts/reativar-acesso-ip.sh + .env, e
   * um `docker` que registra as chamadas, roda o .mjs de verdade quando o
   * script pede o `docker run`, e mostra um Caddyfile.
   */
  async function montar(opts: { caddyfile: string; panelRunning?: boolean; image?: boolean }) {
    const repo = path.join(dir, "tws-panel");
    const bin = path.join(dir, "bin");
    const data = path.join(dir, "data");
    await mkdir(path.join(repo, "scripts"), { recursive: true });
    await mkdir(bin);
    await mkdir(data);
    await copyFile(SH, path.join(repo, "scripts", "reativar-acesso-ip.sh"));
    await writeFile(path.join(repo, ".env"), `PAAS_PANEL_DOMAIN=${IP_HOST}\n`);
    await writeFile(path.join(data, "panel-domain.json"), JSON.stringify(desativado));
    await writeFile(path.join(dir, "Caddyfile"), opts.caddyfile);
    const log = path.join(dir, "docker.log");
    const fake = `#!/usr/bin/env bash
echo "$*" >> "${log}"
case "$1" in
  image) ${opts.image === false ? "exit 1" : "exit 0"} ;;
  ps) ${opts.panelRunning === false ? "true" : 'echo tws-panel'} ;;
  stop|start) echo "$2" ;;
  run) node "${MJS}" "${data}/panel-domain.json" ;;
  exec) cat "${path.join(dir, "Caddyfile")}" ;;
  *) exit 0 ;;
esac
`;
    await writeFile(path.join(bin, "docker"), fake);
    await chmod(path.join(bin, "docker"), 0o755);
    return { repo, bin, data, log };
  }

  function rodar(m: { repo: string; bin: string }, args: string[] = []) {
    return spawnSync("bash", [path.join(m.repo, "scripts", "reativar-acesso-ip.sh"), ...args], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${m.bin}:${process.env.PATH ?? ""}`, PAAS_WAIT_SECONDS: "1" },
    });
  }

  it("para o painel, reativa no arquivo, sobe o painel e confere o endereço no Caddyfile", async () => {
    const m = await montar({ caddyfile: `${DOMAIN}, ${IP_HOST} {\n}\n` });
    const r = rodar(m);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    const calls = await readFile(m.log, "utf8");
    expect(calls.indexOf("stop tws-panel")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("stop tws-panel")).toBeLessThan(calls.indexOf("run "));
    expect(calls.indexOf("run ")).toBeLessThan(calls.indexOf("start tws-panel"));
    expect(calls).toMatch(/run --rm --entrypoint node -v paas_data:\/data tws-panel:latest \/app\/scripts\/reativar-acesso-ip\.mjs \/data\/panel-domain\.json/);
    expect(JSON.parse(await readFile(path.join(m.data, "panel-domain.json"), "utf8"))).toMatchObject({ ipAccessDisabled: false });
    expect(r.stdout).toContain(`https://${IP_HOST}`);
  });

  it("o Caddyfile não volta a ter o endereço a tempo: avisa onde olhar (código 1)", async () => {
    const m = await montar({ caddyfile: `${DOMAIN} {\n}\n` });
    const r = rodar(m);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/docker logs tws-panel/);
  });

  it("painel parado: não tenta parar; sobe mesmo assim (o boot é que remonta o proxy)", async () => {
    const m = await montar({ caddyfile: `${IP_HOST} {\n}\n`, panelRunning: false });
    const r = rodar(m);
    expect(r.status, r.stderr).toBe(0);
    const calls = await readFile(m.log, "utf8");
    expect(calls).not.toMatch(/^stop /m);
    expect(calls).toMatch(/^start tws-panel/m);
  });

  it("sem a imagem do painel: erro claro e nada é alterado", async () => {
    const m = await montar({ caddyfile: "", image: false });
    const r = rodar(m);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/painel está instalado/);
    expect(JSON.parse(await readFile(path.join(m.data, "panel-domain.json"), "utf8"))).toMatchObject({ ipAccessDisabled: true });
  });

  it("--help mostra o uso; argumento desconhecido é recusado", async () => {
    const m = await montar({ caddyfile: "" });
    expect(rodar(m, ["--help"]).stdout).toMatch(/reativar-acesso-ip\.sh/);
    expect(rodar(m, ["--xyz"]).status).not.toBe(0);
  });

  it("passa no bash -n (sintaxe)", () => {
    expect(spawnSync("bash", ["-n", SH]).status).toBe(0);
  });
});
