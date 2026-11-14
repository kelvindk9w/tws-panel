/**
 * atualizar-sandbox-script.test.ts — scripts/processo/atualizar-sandbox.sh, a etapa "sandbox" do fluxo
 * dev → sandbox → main (docs/processo/forma-de-trabalhar.md).
 *
 * Duas metades, como no script:
 *  - a parte LOCAL roda num clone de verdade de um repositório "origin" (bare) temporário, com `gh`, `ssh` e
 *    `curl` falsos no PATH. O `ssh` falso responde cada modo do destino com uma saída combinada e guarda o
 *    que recebeu (o script do destino chega pela entrada padrão);
 *  - a parte do DESTINO (o texto de --script-remoto) roda aqui mesmo com `bash -s`, numa "instalação" que
 *    é outro clone desse origin, com `docker`, `hostname` e o instalador falsos.
 * O teste de verdade contra a VPS de testes está descrito no relatório da tarefa.
 */
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeDir } from "./helpers/tmp.js";

const SH = path.resolve(__dirname, "../../../scripts/processo/atualizar-sandbox.sh");
const ENDERECO = "painel.example.test";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-atualizar-sandbox-"));
});
afterEach(async () => {
  await removeDir(dir);
});

const GIT_ENV = {
  GIT_AUTHOR_NAME: "Dev",
  GIT_AUTHOR_EMAIL: "dev@example.com",
  GIT_COMMITTER_NAME: "Dev",
  GIT_COMMITTER_EMAIL: "dev@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...GIT_ENV, HOME: dir },
  }).trim();
}

async function escreverExecutavel(file: string, conteudo: string) {
  await writeFile(file, conteudo);
  await chmod(file, 0o755);
}

/**
 * origin (bare) com main → sandbox → dev em linha: main tem 1 commit, sandbox = main + 1, dev = sandbox + 1
 * (ou, com `iguais`, as três no mesmo commit). Devolve o caminho do bare e os SHAs.
 */
async function montarOrigin(opts: { iguais?: boolean; divergir?: boolean; installSh?: string } = {}) {
  const semente = path.join(dir, "semente");
  const origin = path.join(dir, "origin.git");
  await mkdir(semente);
  git(dir, "init", "--quiet", "--bare", "--initial-branch=main", origin);
  git(semente, "init", "--quiet", "--initial-branch=main");
  await mkdir(path.join(semente, "scripts"));
  await escreverExecutavel(
    path.join(semente, "scripts", "install.sh"),
    opts.installSh ??
      `#!/usr/bin/env bash
echo "instalador: atualizando"
exit 0
`,
  );
  await writeFile(path.join(semente, ".gitignore"), ".env\n");
  await writeFile(path.join(semente, "a.txt"), "1\n");
  git(semente, "add", ".");
  git(semente, "commit", "--quiet", "-m", "primeiro");
  const main = git(semente, "rev-parse", "HEAD");
  git(semente, "remote", "add", "origin", origin);
  git(semente, "push", "--quiet", "origin", "HEAD:main");
  let sandbox = main;
  let dev = main;
  if (!opts.iguais) {
    await writeFile(path.join(semente, "a.txt"), "2\n");
    git(semente, "commit", "--quiet", "-am", "segundo");
    sandbox = git(semente, "rev-parse", "HEAD");
    await writeFile(path.join(semente, "a.txt"), "3\n");
    git(semente, "commit", "--quiet", "-am", "feat: terceiro");
    dev = git(semente, "rev-parse", "HEAD");
  }
  if (opts.divergir) {
    git(semente, "checkout", "--quiet", "-b", "outra", main);
    await writeFile(path.join(semente, "b.txt"), "x\n");
    git(semente, "add", ".");
    git(semente, "commit", "--quiet", "-m", "só na sandbox");
    sandbox = git(semente, "rev-parse", "HEAD");
  }
  git(semente, "push", "--quiet", "origin", `${sandbox}:refs/heads/sandbox`, `${dev}:refs/heads/dev`);
  return { origin, main, sandbox, dev };
}

// ---------------------------------------------------------------------------------------------------------
// Parte local
// ---------------------------------------------------------------------------------------------------------

interface Destino {
  /** saída e código de cada modo do destino */
  estado?: string;
  preparar?: [string, number];
  atualizar?: [string, number];
  validar?: string;
}

const CHECKS_OK = [
  "@check=commit|ok|a instalação está na branch sandbox, no commit da origin/sandbox, sem mudança local",
  "@check=imagem|ok|o container do painel roda a imagem construída nesta atualização",
  "@check=saude|ok|container do painel healthy",
  "@check=reinicios|ok|2 container(s) do painel (tws-panel e paas-*), nenhum reiniciando",
  "@check=logs|ok|nenhum erro no log do painel desde a subida",
].join("\n");

async function montarLocal(
  o: { origin: string },
  destino: Destino = {},
  ci: { status?: string; conclusion?: string; vazio?: boolean } = {},
  httpCodigo = "200",
) {
  const clone = path.join(dir, "local");
  git(dir, "clone", "--quiet", o.origin, clone);
  const bin = path.join(dir, "bin");
  const reg = path.join(dir, "reg");
  await mkdir(bin);
  await mkdir(reg);
  const resp = path.join(dir, "resp");
  await mkdir(resp);
  const estado = destino.estado ?? "@branch=sandbox\n@head=x\n@upstream=origin/sandbox\n@sujo=0\n@maquina=teste";
  await writeFile(path.join(resp, "estado.out"), `${estado}\n`);
  await writeFile(path.join(resp, "estado.rc"), "0");
  const [prepOut, prepRc] = destino.preparar ?? ["@preparado=sim", 0];
  await writeFile(path.join(resp, "preparar.out"), `${prepOut}\n`);
  await writeFile(path.join(resp, "preparar.rc"), String(prepRc));
  const [atuOut, atuRc] = destino.atualizar ?? ["instalador: ok\n@inicio=100\n@duracao=42", 0];
  await writeFile(path.join(resp, "atualizar.out"), `${atuOut}\n`);
  await writeFile(path.join(resp, "atualizar.rc"), String(atuRc));
  await writeFile(path.join(resp, "validar.out"), `${destino.validar ?? `${CHECKS_OK}\n@endereco=${ENDERECO}`}\n`);
  await writeFile(path.join(resp, "validar.rc"), "0");

  // ssh falso: o modo é a 1ª palavra depois de "bash -s --"; registra a chamada e o script recebido.
  await escreverExecutavel(
    path.join(bin, "ssh"),
    `#!/usr/bin/env bash
cmd="\${*: -1}"
modo="$(printf '%s' "$cmd" | sed -n 's/.*bash -s -- \\([a-z]*\\).*/\\1/p' | head -n 1)"
printf '%s\\n' "$*" >> "${reg}/ssh.log"
cat > "${reg}/script-\${modo}.sh"
cat "${resp}/\${modo}.out"
exit "$(cat "${resp}/\${modo}.rc")"
`,
  );
  const tsv = ci.vazio ? "" : `${ci.status ?? "completed"}\t${ci.conclusion ?? "success"}\thttps://example.test/run/1`;
  await escreverExecutavel(
    path.join(bin, "gh"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${reg}/gh.log"
${tsv ? `printf '%s\\n' '${tsv}'` : "true"}
`,
  );
  await escreverExecutavel(
    path.join(bin, "curl"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${reg}/curl.log"
printf '%s' "${httpCodigo}"
`,
  );
  return { clone, bin, reg };
}

function rodarLocal(m: { clone: string; bin: string }, args: string[], env: Record<string, string> = {}) {
  return spawnSync("bash", [SH, ...args], {
    cwd: m.clone,
    encoding: "utf8",
    env: {
      ...process.env,
      ...GIT_ENV,
      HOME: dir,
      PATH: `${m.bin}:${process.env.PATH ?? ""}`,
      TWS_SANDBOX_SSH: "vps-de-testes",
      TWS_SANDBOX_ESPERA: "0",
      ...env,
    },
  });
}

async function lerSe(file: string): Promise<string> {
  return existsSync(file) ? readFile(file, "utf8") : "";
}

describe("atualizar-sandbox.sh — parte local", () => {
  it("sem TWS_SANDBOX_SSH: recusa sem consultar nada", async () => {
    const o = await montarOrigin({ iguais: true });
    const m = await montarLocal(o);
    const r = rodarLocal(m, [], { TWS_SANDBOX_SSH: "" });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/defina TWS_SANDBOX_SSH/);
    expect(await lerSe(path.join(m.reg, "ssh.log"))).toBe("");
  });

  it("TWS_SANDBOX_SSH que não é só um alias (espaço, opção do ssh) é recusado", async () => {
    const o = await montarOrigin({ iguais: true });
    const m = await montarLocal(o);
    for (const valor of ["vps -o ProxyCommand=x", "a;b", "-oProxyCommand=x"]) {
      const r = rodarLocal(m, [], { TWS_SANDBOX_SSH: valor });
      expect(r.status, valor).toBe(2);
    }
    // começando com "-", o ssh leria como opção (ProxyCommand roda comando local): nenhum ssh foi chamado
    expect(await lerSe(path.join(m.reg, "ssh.log"))).toBe("");
  });

  it("argumentos inválidos e combinações sem sentido saem com 2", async () => {
    const o = await montarOrigin({ iguais: true });
    const m = await montarLocal(o);
    expect(rodarLocal(m, ["--preparar"]).status).toBe(2);
    expect(rodarLocal(m, ["--preparar=a b"]).status).toBe(2);
    expect(rodarLocal(m, ["--so-validar", "--avancar"]).status).toBe(2);
    expect(rodarLocal(m, ["--qualquer"]).status).toBe(2);
    expect(rodarLocal(m, [], { TWS_SANDBOX_DIR: "relativo" }).status).toBe(2);
    expect(rodarLocal(m, [], { TWS_SANDBOX_ESPERA: "dez" }).status).toBe(2);
  });

  it("sandbox atrás da dev sem --avancar: para e não mexe na sandbox", async () => {
    const o = await montarOrigin();
    const m = await montarLocal(o);
    const r = rodarLocal(m, []);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/atrás da dev.*--avancar/);
    expect(git(dir, "--git-dir", o.origin, "rev-parse", "sandbox")).toBe(o.sandbox);
  });

  it("--avancar com o ci da dev verde: a sandbox avança por fast-forward até a dev e segue", async () => {
    const o = await montarOrigin();
    const m = await montarLocal(o);
    const r = rodarLocal(m, ["--avancar"]);
    expect(r.status, r.stderr).toBe(0);
    expect(git(dir, "--git-dir", o.origin, "rev-parse", "sandbox")).toBe(o.dev);
    expect(await lerSe(path.join(m.reg, "gh.log"))).toContain(`--commit ${o.dev}`);
    expect(r.stdout).toContain(`\`${o.dev.slice(0, 12)}\` (origin/sandbox = origin/dev)`);
  });

  it("--avancar com o ci da dev vermelho, em andamento ou ausente: a sandbox não avança", async () => {
    for (const ci of [{ conclusion: "failure" }, { status: "in_progress", conclusion: "" }, { vazio: true }]) {
      await removeDir(dir);
      await mkdir(dir);
      const o = await montarOrigin();
      const m = await montarLocal(o, {}, ci);
      const r = rodarLocal(m, ["--avancar"]);
      expect(r.status, JSON.stringify(ci)).toBe(2);
      expect(git(dir, "--git-dir", o.origin, "rev-parse", "sandbox")).toBe(o.sandbox);
      expect(await lerSe(path.join(m.reg, "ssh.log"))).toBe("");
    }
  });

  it("sandbox divergente da dev: recusa até com --avancar", async () => {
    const o = await montarOrigin({ divergir: true });
    const m = await montarLocal(o);
    const r = rodarLocal(m, ["--avancar"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/divergiram/);
    expect(git(dir, "--git-dir", o.origin, "rev-parse", "sandbox")).toBe(o.sandbox);
  });

  it("TRAVA: destino na main não é atualizado (código 3, nenhum modo além do estado)", async () => {
    const o = await montarOrigin({ iguais: true });
    const m = await montarLocal(o, { estado: "@branch=main\n@head=x\n@upstream=origin/main\n@sujo=0" });
    const r = rodarLocal(m, []);
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/TRAVA: a instalação do destino está em 'main'/);
    const ssh = await lerSe(path.join(m.reg, "ssh.log"));
    expect(ssh).toContain("bash -s -- estado /opt/tws-panel");
    expect(ssh).not.toMatch(/atualizar|validar|preparar/);
  });

  it("TRAVA: sandbox sem upstream origin/sandbox também é recusada", async () => {
    const o = await montarOrigin({ iguais: true });
    const m = await montarLocal(o, { estado: "@branch=sandbox\n@head=x\n@upstream=origin/main\n@sujo=0" });
    expect(rodarLocal(m, []).status).toBe(3);
  });

  it("--preparar=<máquina> manda o nome e o commit ao destino; recusado lá, sai com o código do destino", async () => {
    const o = await montarOrigin({ iguais: true });
    const m = await montarLocal(o, {
      estado: "@branch=main\n@head=x\n@upstream=origin/main\n@sujo=0",
      preparar: ["@erro=o nome da máquina do destino não confere com --preparar", 3],
    });
    const r = rodarLocal(m, ["--preparar=vps-teste-1"]);
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/--preparar recusado: o nome da máquina/);
    const ssh = await lerSe(path.join(m.reg, "ssh.log"));
    expect(ssh).toContain(`bash -s -- preparar /opt/tws-panel ${o.sandbox} vps-teste-1`);
    expect(ssh).not.toMatch(/atualizar/);
  });

  it("--preparar aceito: segue para a atualização mesmo com o destino antes na main", async () => {
    const o = await montarOrigin({ iguais: true });
    const m = await montarLocal(o, { estado: "@branch=main\n@head=x\n@upstream=origin/main\n@sujo=0" });
    const r = rodarLocal(m, ["--preparar=vps-teste-1"]);
    expect(r.status, r.stderr).toBe(0);
    expect(await lerSe(path.join(m.reg, "ssh.log"))).toMatch(/preparar[\s\S]*atualizar[\s\S]*validar/);
  });

  it("caminho feliz: atualiza, valida, confere HTTP pelo endereço do destino e o resumo não mostra o endereço", async () => {
    const o = await montarOrigin({ iguais: true });
    const m = await montarLocal(o);
    const r = rodarLocal(m, []);
    expect(r.status, r.stderr).toBe(0);
    const curl = await lerSe(path.join(m.reg, "curl.log"));
    expect(curl).toContain(`https://${ENDERECO}/api/healthz`);
    expect(curl).toContain(`https://${ENDERECO}/login`);
    expect(r.stdout + r.stderr).not.toContain(ENDERECO);
    expect(r.stdout).toContain("## Validação na VPS de testes");
    expect(r.stdout).toContain("concluído em 42 s");
    expect(r.stdout).toContain("- [x] /api/healthz respondeu 200 pelo endereço público do painel (HTTPS)");
    expect(r.stdout).toContain("- [x] container do painel healthy");
    expect(r.stdout).toContain("Resultado: tudo validado.");
    // o script do destino vai pela entrada padrão e não leva nada da máquina real
    const remoto = await lerSe(path.join(m.reg, "script-atualizar.sh"));
    expect(remoto).toContain("principal()");
    expect(remoto).toContain("./scripts/install.sh </dev/null");
  });

  it("o instalador parou no \"continuar\": código 4, sem validar e sem forçar", async () => {
    const o = await montarOrigin({ iguais: true });
    const m = await montarLocal(o, {
      atualizar: ['Digite "continuar" para prosseguir:\n@erro=o instalador parou na pergunta "continuar" (atualização sem terminal)', 4],
    });
    const r = rodarLocal(m, []);
    expect(r.status).toBe(4);
    expect(r.stderr).toMatch(/Depende da correção do instalador/);
    expect(await lerSe(path.join(m.reg, "ssh.log"))).not.toMatch(/validar/);
    expect(await lerSe(path.join(m.reg, "script-atualizar.sh"))).not.toMatch(/--force|PAAS_FORCE/);
  });

  it("o instalador falhou: código 5", async () => {
    const o = await montarOrigin({ iguais: true });
    const m = await montarLocal(o, { atualizar: ["@erro=o instalador saiu com código 7", 7] });
    const r = rodarLocal(m, []);
    expect(r.status).toBe(5);
    expect(r.stderr).toMatch(/código 7/);
  });

  it("uma verificação falhou no destino: código 1 e o resumo diz qual", async () => {
    const o = await montarOrigin({ iguais: true });
    const m = await montarLocal(o, {
      validar: `${CHECKS_OK.replace("@check=saude|ok|container do painel healthy", "@check=saude|falha|container do painel: unhealthy")}\n@endereco=${ENDERECO}`,
    });
    const r = rodarLocal(m, []);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("- [ ] FALHOU (saude): container do painel: unhealthy");
    expect(r.stdout).toContain("Resultado: 1 verificação(ões) falharam.");
  });

  it("endereço público sem 200: falha o HTTP", async () => {
    const o = await montarOrigin({ iguais: true });
    const m = await montarLocal(o, {}, {}, "502");
    const r = rodarLocal(m, []);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("- [ ] FALHOU (http/api/healthz)");
  });

  it("--so-validar: não consulta o ci, não atualiza e só valida", async () => {
    const o = await montarOrigin({ iguais: true });
    const m = await montarLocal(o);
    const r = rodarLocal(m, ["--so-validar"]);
    expect(r.status, r.stderr).toBe(0);
    const ssh = await lerSe(path.join(m.reg, "ssh.log"));
    expect(ssh).not.toMatch(/atualizar/);
    expect(ssh).toMatch(/validar \/opt\/tws-panel [0-9a-f]{40} 0 0/);
    expect(await lerSe(path.join(m.reg, "gh.log"))).toBe("");
    expect(r.stdout).toContain("Atualização: não executada (só validação)");
  });
});

// ---------------------------------------------------------------------------------------------------------
// Parte do destino
// ---------------------------------------------------------------------------------------------------------

async function montarDestino(o: { origin: string }, opts: { branch?: string; docker?: string } = {}) {
  const inst = path.join(dir, "instalacao");
  git(dir, "clone", "--quiet", o.origin, inst);
  if (opts.branch === "sandbox") {
    git(inst, "checkout", "--quiet", "-B", "sandbox", "origin/sandbox");
    git(inst, "branch", "--quiet", "--set-upstream-to=origin/sandbox", "sandbox");
  }
  await writeFile(path.join(inst, ".env"), `PAAS_ACCESS=https\nPAAS_PANEL_DOMAIN=${ENDERECO}\nPAAS_PORT=9000\n`);
  const bin = path.join(dir, "bin-destino");
  const reg = path.join(dir, "reg-destino");
  await mkdir(bin);
  await mkdir(reg);
  await escreverExecutavel(path.join(bin, "hostname"), "#!/usr/bin/env bash\necho vps-teste-1\n");
  const agora = new Date().toISOString();
  await escreverExecutavel(
    path.join(bin, "docker"),
    opts.docker ??
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${reg}/docker.log"
case "$1 $3" in
  "inspect {{.Image}}") echo sha256:aaa ;;
  "inspect {{.State.Health.Status}}") echo "\${FAKE_SAUDE:-healthy}" ;;
  "inspect {{.RestartCount}}") echo 0 ;;
  "inspect {{.State.Status}}") if [ "$4" = "\${FAKE_REINICIANDO:-}" ]; then echo restarting; else echo running; fi ;;
  "inspect {{.State.StartedAt}}") echo 2026-01-01T00:00:00Z ;;
esac
case "$1 $2 $4" in
  "image inspect {{.Id}}") echo sha256:aaa ;;
  "image inspect {{.Created}}") echo ${agora} ;;
esac
case "$1" in
  ps) printf 'tws-panel\\npaas-caddy\\noutro-projeto\\n' ;;
  logs) if [ -n "\${FAKE_LOGS:-}" ]; then printf '%s\\n' "$FAKE_LOGS"; else echo '{"level":30,"msg":"ok"}'; fi ;;
  exec) exit 1 ;;
esac
exit 0
`,
  );
  return { inst, bin, reg };
}

function rodarDestino(m: { bin: string }, args: string[], env: Record<string, string> = {}) {
  const script = execFileSync("bash", [SH, "--script-remoto"], { encoding: "utf8" });
  return spawnSync("bash", ["-s", "--", ...args], {
    input: script,
    encoding: "utf8",
    env: {
      ...process.env,
      ...GIT_ENV,
      HOME: dir,
      PATH: `${m.bin}:${process.env.PATH ?? ""}`,
      TWS_SANDBOX_INTERVALO_REINICIO: "0",
      ...env,
    },
  });
}

const INSTALL_REGISTRA = (reg: string, extra = "exit 0") => `#!/usr/bin/env bash
{ echo "stdin=[$(cat)]"; echo "safe=\${GIT_CONFIG_KEY_0:-}=\${GIT_CONFIG_VALUE_0:-}"; } > "${reg}/install.log"
${extra}
`;

describe("atualizar-sandbox.sh — parte do destino", () => {
  it("estado: informa branch, commit, upstream, mudanças locais e o nome da máquina", async () => {
    const o = await montarOrigin({ iguais: true });
    const d = await montarDestino(o);
    const r = rodarDestino(d, ["estado", d.inst]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("@branch=main");
    expect(r.stdout).toContain(`@head=${o.main}`);
    expect(r.stdout).toContain("@upstream=origin/main");
    expect(r.stdout).toContain("@sujo=0");
    expect(r.stdout).toContain("@maquina=vps-teste-1");
  });

  it("pasta que não é repositório: código 2", async () => {
    const o = await montarOrigin({ iguais: true });
    const d = await montarDestino(o);
    const r = rodarDestino(d, ["estado", path.join(dir, "nada")]);
    expect(r.status).toBe(2);
  });

  it("TRAVA: atualizar numa instalação na main não roda o instalador", async () => {
    const o = await montarOrigin({ iguais: true, installSh: INSTALL_REGISTRA(path.join(dir, "reg-destino")) });
    const d = await montarDestino(o);
    const r = rodarDestino(d, ["atualizar", d.inst]);
    expect(r.status).toBe(3);
    expect(r.stdout).toMatch(/@erro=trava: a instalação está em 'main'/);
    expect(existsSync(path.join(d.reg, "install.log"))).toBe(false);
  });

  it("preparar: nome da máquina diferente recusa e nada muda", async () => {
    const o = await montarOrigin();
    const d = await montarDestino(o);
    const r = rodarDestino(d, ["preparar", d.inst, o.sandbox, "producao"]);
    expect(r.status).toBe(3);
    expect(git(d.inst, "symbolic-ref", "--short", "HEAD")).toBe("main");
  });

  it("preparar: com mudança local em arquivo versionado recusa e nada muda", async () => {
    const o = await montarOrigin();
    const d = await montarDestino(o);
    await writeFile(path.join(d.inst, "a.txt"), "mexido\n");
    const r = rodarDestino(d, ["preparar", d.inst, o.sandbox, "vps-teste-1"]);
    expect(r.status).toBe(3);
    expect(r.stdout).toMatch(/mudança local/);
    expect(git(d.inst, "symbolic-ref", "--short", "HEAD")).toBe("main");
  });

  it("preparar: origin/sandbox diferente do commit esperado recusa", async () => {
    const o = await montarOrigin();
    const d = await montarDestino(o);
    const r = rodarDestino(d, ["preparar", d.inst, o.dev, "vps-teste-1"]);
    expect(r.status).toBe(2);
    expect(git(d.inst, "symbolic-ref", "--short", "HEAD")).toBe("main");
  });

  it("preparar: troca para a sandbox com upstream e guarda o commit anterior; segunda vez não faz nada", async () => {
    const o = await montarOrigin();
    const d = await montarDestino(o);
    const r = rodarDestino(d, ["preparar", d.inst, o.sandbox, "vps-teste-1"]);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(r.stdout).toContain("@preparado=sim");
    expect(git(d.inst, "symbolic-ref", "--short", "HEAD")).toBe("sandbox");
    expect(git(d.inst, "rev-parse", "HEAD")).toBe(o.sandbox);
    expect(git(d.inst, "rev-parse", "--abbrev-ref", "sandbox@{upstream}")).toBe("origin/sandbox");
    const backup = git(d.inst, "for-each-ref", "--format=%(objectname)", "refs/tws-backup/");
    expect(backup).toBe(o.main);
    expect(await readFile(path.join(d.inst, ".env"), "utf8")).toContain("PAAS_ACCESS=https");
    const r2 = rodarDestino(d, ["preparar", d.inst, o.sandbox, "vps-teste-1"]);
    expect(r2.stdout).toContain("@preparado=ja");
  });

  it("atualizar na sandbox: roda o instalador sem nada na entrada e com o safe.directory só da pasta", async () => {
    const o = await montarOrigin({ iguais: true, installSh: INSTALL_REGISTRA(path.join(dir, "reg-destino")) });
    const d = await montarDestino(o, { branch: "sandbox" });
    const r = rodarDestino(d, ["atualizar", d.inst]);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    const log = await readFile(path.join(d.reg, "install.log"), "utf8");
    expect(log).toContain("stdin=[]");
    expect(log).toContain(`safe=safe.directory=${d.inst}`);
    expect(r.stdout).toMatch(/@inicio=\d+/);
    expect(r.stdout).toMatch(/@duracao=\d+/);
  });

  it("atualizar: o instalador pediu \"continuar\" → código 4", async () => {
    const extra = `echo 'Digite "continuar" para prosseguir: '; echo 'Instalação abortada. Nada foi instalado ou alterado.' >&2; exit 1`;
    const o = await montarOrigin({ iguais: true, installSh: INSTALL_REGISTRA(path.join(dir, "reg-destino"), extra) });
    const d = await montarDestino(o, { branch: "sandbox" });
    const r = rodarDestino(d, ["atualizar", d.inst]);
    expect(r.status).toBe(4);
    expect(r.stdout).toMatch(/@erro=o instalador parou na pergunta "continuar"/);
  });

  it("atualizar: o instalador falhou por outro motivo → código 5 com o código dele", async () => {
    const o = await montarOrigin({ iguais: true, installSh: INSTALL_REGISTRA(path.join(dir, "reg-destino"), "exit 7") });
    const d = await montarDestino(o, { branch: "sandbox" });
    const r = rodarDestino(d, ["atualizar", d.inst]);
    expect(r.status).toBe(5);
    expect(r.stdout).toContain("@erro=o instalador saiu com código 7");
  });

  it("validar: tudo certo dá todas as verificações ok e o endereço do .env", async () => {
    const o = await montarOrigin({ iguais: true });
    const d = await montarDestino(o, { branch: "sandbox" });
    const r = rodarDestino(d, ["validar", d.inst, o.sandbox, "0", "0"]);
    expect(r.status, r.stderr).toBe(0);
    for (const nome of ["commit", "imagem", "saude", "reinicios", "logs"]) {
      expect(r.stdout, nome).toMatch(new RegExp(`@check=${nome}\\|ok\\|`));
    }
    expect(r.stdout).toContain("2 container(s) do painel");
    expect(r.stdout).toContain(`@endereco=${ENDERECO}`);
  });

  it("validar: commit diferente, container unhealthy, paas-* reiniciando e erro no log falham", async () => {
    const o = await montarOrigin();
    const d = await montarDestino(o, { branch: "sandbox" });
    const r = rodarDestino(d, ["validar", d.inst, o.dev, "100", "0"], {
      FAKE_SAUDE: "unhealthy",
      FAKE_REINICIANDO: "paas-caddy",
      FAKE_LOGS: '{"level":50,"msg":"falhou"}',
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/@check=commit\|falha\|/);
    expect(r.stdout).toMatch(/@check=saude\|falha\|container do painel: unhealthy/);
    expect(r.stdout).toMatch(/@check=reinicios\|falha\|reiniciando: paas-caddy/);
    expect(r.stdout).toMatch(/@check=logs\|falha\|1 linha\(s\) de erro/);
  });

  it("validar: aviso (level 40) no log não é erro", async () => {
    const o = await montarOrigin({ iguais: true });
    const d = await montarDestino(o, { branch: "sandbox" });
    const r = rodarDestino(d, ["validar", d.inst, o.sandbox, "100", "0"], { FAKE_LOGS: '{"level":40,"msg":"aviso"}' });
    expect(r.stdout).toMatch(/@check=logs\|ok\|/);
  });

  it("validar: acesso por túnel confere o HTTP por dentro da VPS e não informa endereço público", async () => {
    const o = await montarOrigin({ iguais: true });
    const d = await montarDestino(o, { branch: "sandbox" });
    await writeFile(path.join(d.inst, ".env"), "PAAS_ACCESS=tunel\nPAAS_PORT=9123\n");
    await escreverExecutavel(
      path.join(d.bin, "curl"),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${d.reg}/curl.log"\nprintf 200\n`,
    );
    const r = rodarDestino(d, ["validar", d.inst, o.sandbox, "100", "0"]);
    expect(r.stdout).toMatch(/^@endereco=$/m);
    expect(r.stdout).toMatch(/@check=http\/api\/healthz\|ok\|/);
    expect(r.stdout).toMatch(/@check=http\/login\|ok\|/);
    expect(await readFile(path.join(d.reg, "curl.log"), "utf8")).toContain("http://127.0.0.1:9123/api/healthz");
  });
});
