/**
 * restaurar-painel-script.test.ts — scripts/restaurar-painel.sh, a
 * restauração do painel por SSH (sem entrar no painel).
 *
 * Usa um `docker` falso no PATH que registra as chamadas e a entrada padrão
 * de cada uma (para provar que a senha vai por ela e nunca pela linha de
 * comando). A versão com Docker e 7-Zip de verdade está descrita no
 * relatório (comoFuncionaSistema/_RELATORIO-backups.md).
 */
import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SH = path.resolve(__dirname, "../../../scripts/restaurar-painel.sh");
const SENHA = "cavalo-azul-janela-trigo-mesa-41";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-restaurar-painel-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * docker falso: "7zz t" abre sem senha se o arquivo não tem "cifrado" no
 * nome; com senha, só se a linha recebida for SENHA. "run ... sh -c" (a
 * extração) grava o que recebeu; "exec" diz que o pedido já sumiu.
 */
async function montar(
  opts: {
    image?: boolean;
    running?: boolean;
    markerStays?: boolean;
    extractFails?: boolean;
    halfway?: boolean;
    undone?: boolean;
    /** O backup traz _caddy/caddy-data.tar. */
    caddy?: boolean;
    caddyFails?: boolean;
  } = {},
) {
  const repo = path.join(dir, "tws-panel");
  const bin = path.join(dir, "bin");
  await mkdir(path.join(repo, "scripts"), { recursive: true });
  await mkdir(bin);
  await copyFile(SH, path.join(repo, "scripts", "restaurar-painel.sh"));
  const log = path.join(dir, "docker.log");
  const stdin = path.join(dir, "stdin.log");
  const fake = `#!/usr/bin/env bash
echo "$*" >> "${log}"
case "$1" in
  image) ${opts.image === false ? "exit 1" : "exit 0"} ;;
  ps) ${opts.running === false ? "true" : "echo tws-panel"} ;;
  stop|start) echo "$2" ;;
  exec)
    case "$*" in
      *"node -e"*) ${opts.undone ? 'echo "A troca falhou no meio (disco cheio) e foi desfeita."; exit 2' : "exit 0"} ;;
      *) ${opts.markerStays ? "exit 1" : "exit 0"} ;;
    esac ;;
  run)
    input="$(cat)"
    echo "[$input]" >> "${stdin}"
    case "$*" in
      *"--entrypoint 7zz"*)
        case "$*" in
          *cifrado*) [ "$input" = "${SENHA}" ] || exit 2 ;;
        esac
        exit 0 ;;
      *"-c "*"7zz x"*) ${opts.extractFails ? "exit 2" : "exit 0"} ;;
      *caddy-existe*) ${opts.caddy ? "exit 0" : "exit 1"} ;;
      *caddy-restaurar*) ${opts.caddyFails ? "exit 4" : "exit 0"} ;;
      *" conferir "*) ${opts.halfway ? "exit 1" : "exit 0"} ;;
      *) exit 0 ;;
    esac ;;
  *) exit 0 ;;
esac
`;
  await writeFile(path.join(bin, "docker"), fake);
  await chmod(path.join(bin, "docker"), 0o755);
  return { repo, bin, log, stdin };
}

function rodar(m: { repo: string; bin: string }, args: string[], input = "", env: Record<string, string> = {}) {
  return spawnSync("bash", [path.join(m.repo, "scripts", "restaurar-painel.sh"), ...args], {
    encoding: "utf8",
    input,
    env: { ...process.env, PATH: `${m.bin}:${process.env.PATH ?? ""}`, PAAS_WAIT_SECONDS: "1", ...env },
  });
}

async function arquivo(name: string): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, "7z");
  return file;
}

describe("scripts/restaurar-painel.sh (docker falso)", () => {
  it("backup sem senha: confere, para, extrai no volume, sobe e confere a troca", async () => {
    const m = await montar();
    const file = await arquivo("2026-10-14_03-00.7z");
    const r = rodar(m, [file]);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    const calls = await readFile(m.log, "utf8");
    const order = ["--entrypoint 7zz", "stop tws-panel", "-v paas_data:/data -v", "start tws-panel", "exec tws-panel"].map((s) => calls.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(calls).toContain(`-v ${dir}:/entrada:ro tws-panel:latest t -bso0 -bsp0 /entrada/2026-10-14_03-00.7z`);
    expect(calls).toContain("/data/backups/.restaurar-painel 2026-10-14_03-00.7z");
    expect(r.stdout).toMatch(/Entre no painel com o usuário e a senha do backup/);
  });

  it("a extração no volume fica só para o dono (umask 077 e chmod go-rwx na pasta extraída)", async () => {
    const m = await montar();
    const file = await arquivo("2026-10-14_03-00.7z");
    const r = rodar(m, [file]);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    const calls = await readFile(m.log, "utf8");
    const extracao = calls.slice(calls.indexOf("-v paas_data:/data -v"));
    expect(extracao).toMatch(/umask 077/);
    expect(extracao).toMatch(/chmod -R go-rwx "\$1"/);
    expect(extracao.indexOf("umask 077")).toBeLessThan(extracao.indexOf("7zz x"));
  });

  it("backup cifrado: pergunta a senha e ela vai só pela entrada padrão", async () => {
    const m = await montar();
    const file = await arquivo("cifrado.7z");
    const r = rodar(m, [file], `${SENHA}\n`);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(r.stderr).toContain("Senha do backup:");
    expect(await readFile(m.log, "utf8")).not.toContain(SENHA);
    expect(await readFile(m.stdin, "utf8")).toContain(`[${SENHA}]`);
    expect(r.stdout + r.stderr).not.toContain(SENHA);
  });

  describe("certificados do Caddy (_caddy/caddy-data.tar da cópia cifrada)", () => {
    it("devolve ao volume do Caddy depois de extrair e antes de subir o painel, como root, sem rede, sem apagar nada", async () => {
      const m = await montar({ caddy: true });
      const r = rodar(m, [await arquivo("2026-10-14_03-00.7z")]);
      expect(r.status, r.stderr + r.stdout).toBe(0);
      const calls = await readFile(m.log, "utf8");
      const at = (s: string) => calls.indexOf(s);
      expect(at("7zz x")).toBeGreaterThan(-1);
      expect(at("caddy-restaurar")).toBeGreaterThan(at("7zz x"));
      expect(at("caddy-limpar")).toBeGreaterThan(at("caddy-restaurar"));
      expect(at("start tws-panel")).toBeGreaterThan(at("caddy-limpar"));
      const linha = calls.split("\n").find((l) => l.includes("--user 0"))!;
      expect(linha).toContain("--network none");
      expect(linha).toContain("-v paas_data:/data:ro -v paas_caddy_data:/caddy");
      expect(linha).toContain("tws-panel:latest -c");
      expect(calls).toContain('tar -xf "$1" -C /caddy --strip-components=1');
      expect(calls).toContain("find /caddy -type d -exec chmod 700 {} +");
      expect(calls).toContain("find /caddy -type f -exec chmod 600 {} +");
      expect(calls).not.toMatch(/rm -rf \/caddy|find \/caddy[^\n]*-delete/);
      expect(calls).toContain("caddy-restaurar /data/backups/.restaurar-painel/_caddy/caddy-data.tar");
      expect(r.stdout).toMatch(/certificados do Caddy devolvidos/);
    });

    it("limpa a pasta _caddy do estado do painel e pede a recarga do Caddy (marcador) só quando deu certo", async () => {
      const ok = await montar({ caddy: true });
      expect(rodar(ok, [await arquivo("2026-10-14_03-00.7z")]).status).toBe(0);
      const callsOk = await readFile(ok.log, "utf8");
      expect(callsOk).toMatch(/caddy-limpar \/data\/backups\/\.restaurar-painel \S+ 0\b/);
      expect(callsOk).toContain('rm -rf "$1/_caddy"');
      expect(callsOk).toContain("/data/backups/.caddy-reload-pending");
    });

    it("falha ao devolver: aviso, a restauração do painel segue, a pasta é limpa e o marcador NÃO é pedido", async () => {
      const m = await montar({ caddy: true, caddyFails: true });
      const r = rodar(m, [await arquivo("2026-10-14_03-00.7z")]);
      expect(r.status, r.stderr + r.stdout).toBe(0);
      expect(r.stdout).toMatch(/não foi possível devolver os certificados do Caddy \(código 4\)/);
      const calls = await readFile(m.log, "utf8");
      expect(calls).toMatch(/caddy-limpar \/data\/backups\/\.restaurar-painel \S+ 4\b/);
      expect(calls).toMatch(/^start tws-panel/m);
    });

    it("backup sem os dados do Caddy (cópia da VPS ou antigo): não mexe no volume do Caddy", async () => {
      const m = await montar();
      expect(rodar(m, [await arquivo("2026-10-14_03-00.7z")]).status).toBe(0);
      const calls = await readFile(m.log, "utf8");
      expect(calls).toContain("caddy-existe");
      expect(calls).not.toContain("caddy-restaurar");
      expect(calls).not.toContain("caddy-limpar");
      expect(calls).not.toContain("paas_caddy_data");
    });

    it("extração do painel que falhou: nem tenta o Caddy", async () => {
      const m = await montar({ caddy: true, extractFails: true });
      expect(rodar(m, [await arquivo("2026-10-14_03-00.7z")]).status).toBe(1);
      expect(await readFile(m.log, "utf8")).not.toContain("caddy-restaurar");
    });

    it("o trecho que roda no container (sh + tar de verdade): extrai sem data/, junta sem apagar e fecha as permissões", async () => {
      const sh = await readFile(SH, "utf8");
      const inline = /-c '\n(\s+set -e\n\s+mkdir -p \/caddy[\s\S]*?)\n  ' caddy-restaurar/.exec(sh)![1]!;
      const vol = path.join(dir, "caddy-vol");
      const fonte = path.join(dir, "fonte");
      await mkdir(path.join(fonte, "data/caddy/certificates/le/loja.exemplo.com.br"), { recursive: true });
      await writeFile(path.join(fonte, "data/caddy/certificates/le/loja.exemplo.com.br/loja.exemplo.com.br.key"), "chave-de-teste");
      await chmod(path.join(fonte, "data/caddy/certificates/le/loja.exemplo.com.br/loja.exemplo.com.br.key"), 0o666);
      const tar = path.join(dir, "caddy-data.tar");
      expect(spawnSync("tar", ["-cf", tar, "-C", fonte, "data"]).status).toBe(0);
      await mkdir(path.join(vol, "caddy/acme"), { recursive: true });
      await writeFile(path.join(vol, "caddy/acme/conta.json"), "ja-existia");
      await chmod(path.join(vol, "caddy/acme/conta.json"), 0o644);
      const r = spawnSync("sh", ["-c", inline.replaceAll("/caddy", vol), "sh", tar], { encoding: "utf8" });
      expect(r.status, r.stderr).toBe(0);
      const key = path.join(vol, "caddy/certificates/le/loja.exemplo.com.br/loja.exemplo.com.br.key");
      expect(await readFile(key, "utf8")).toBe("chave-de-teste");
      expect(((await stat(key)).mode & 0o777).toString(8)).toBe("600");
      expect(((await stat(path.dirname(key))).mode & 0o777).toString(8)).toBe("700");
      expect(await readFile(path.join(vol, "caddy/acme/conta.json"), "utf8")).toBe("ja-existia");
      expect(((await stat(path.join(vol, "caddy/acme/conta.json"))).mode & 0o777).toString(8)).toBe("600");
    });

    it("PAAS_CADDY_VOLUME troca o nome do volume", async () => {
      const m = await montar({ caddy: true });
      const r = rodar(m, [await arquivo("2026-10-14_03-00.7z")], "", { PAAS_CADDY_VOLUME: "meu_caddy" });
      expect(r.status).toBe(0);
      expect(await readFile(m.log, "utf8")).toContain("-v meu_caddy:/caddy");
    });
  });

  it("senha errada ou vazia: não para o painel nem mexe no volume", async () => {
    const m = await montar();
    const file = await arquivo("cifrado.7z");
    const errada = rodar(m, [file], "chute-errado\n");
    expect(errada.status).toBe(1);
    expect(errada.stderr).toMatch(/a senha não abre este backup/);
    const vazia = rodar(m, [file], "\n");
    expect(vazia.stderr).toMatch(/nenhuma senha foi digitada/);
    const calls = await readFile(m.log, "utf8");
    expect(calls).not.toMatch(/^stop /m);
    expect(calls).not.toContain("paas_data:/data -v");
  });

  it("senha pela variável PAAS_BACKUP_PASSWORD (sem perguntar)", async () => {
    const m = await montar();
    const file = await arquivo("cifrado.7z");
    const r = rodar(m, [file], "", { PAAS_BACKUP_PASSWORD: SENHA });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toContain("Senha do backup:");
  });

  it("extração que falha: limpa o pedido, sobe o painel como estava e avisa", async () => {
    const m = await montar({ extractFails: true });
    const file = await arquivo("2026-10-14_03-00.7z");
    const r = rodar(m, [file]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/O painel voltou como estava/);
    const calls = await readFile(m.log, "utf8");
    expect(calls).toMatch(/limpar \/data\/backups\/\.restaurar-painel \/data\/backups\/\.restaurar-painel\.json/);
    expect(calls).toMatch(/^start tws-panel/m);
  });

  it("painel parado não é parado; troca que não termina a tempo avisa onde olhar", async () => {
    const m = await montar({ running: false, markerStays: true });
    const file = await arquivo("2026-10-14_03-00.7z");
    const r = rodar(m, [file]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/docker logs tws-panel/);
    expect(await readFile(m.log, "utf8")).not.toMatch(/^stop /m);
  });

  it("troca pela metade no volume: para antes de parar o painel ou apagar a pasta extraída", async () => {
    const m = await montar({ halfway: true });
    const r = rodar(m, [await arquivo("2026-10-14_03-00.7z")]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/restauração do painel pela metade/);
    expect(r.stderr).toMatch(/docker start tws-panel/);
    const calls = await readFile(m.log, "utf8");
    expect(calls).toContain("conferir /data/backups/.restaurar-painel.progresso.json");
    expect(calls).not.toMatch(/^stop /m);
    expect(calls).not.toContain("7zz x");
  });

  it("troca que o painel desfez: avisa que voltou ao estado de antes e por quê (sem dizer 'pronto')", async () => {
    const m = await montar({ undone: true });
    const r = rodar(m, [await arquivo("2026-10-14_03-00.7z")]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/foi desfeita: o painel voltou ao estado de antes/);
    expect(r.stderr).toMatch(/disco cheio/);
    expect(r.stdout).not.toMatch(/pronto\./);
  });

  it("o conferidor do histórico (node) acha o registro certo", async () => {
    // roda o mesmo JavaScript do script contra um histórico de verdade
    const sh = await readFile(SH, "utf8");
    const js = /CHECK_JS='([\s\S]*?)'\n/.exec(sh)![1]!.replace("/data/backups-history.json", path.join(dir, "h.json"));
    const hist = (entries: unknown[]) => writeFile(path.join(dir, "h.json"), JSON.stringify({ entries }));
    const run = (now: string) => spawnSync(process.execPath, ["-e", js, now], { encoding: "utf8" });
    const base = { operation: "restore", target: "panel", queuedAt: "2026-10-14T12:00:00Z" };
    await hist([{ ...base, status: "success" }]);
    expect(run("2026-10-14T12:00:00Z").status).toBe(0);
    await hist([{ ...base, status: "failed", error: "desfeita (motivo)" }]);
    const falha = run("2026-10-14T12:00:00Z");
    expect(falha.status).toBe(2);
    expect(falha.stdout).toContain("desfeita (motivo)");
    expect(run("2026-10-15T00:00:00Z").status).toBe(3);
    await writeFile(path.join(dir, "h.json"), "{");
    expect(run("2026-10-14T12:00:00Z").status).toBe(3);
  });

  it("argumentos: sem arquivo, arquivo que não existe, não .7z, dois arquivos, sem imagem e --help", async () => {
    const m = await montar();
    expect(rodar(m, []).stderr).toMatch(/informe o arquivo do backup/);
    expect(rodar(m, [path.join(dir, "nao-existe.7z")]).stderr).toMatch(/arquivo não encontrado/);
    expect(rodar(m, [await arquivo("x.zip")]).stderr).toMatch(/precisa ser um \.7z/);
    expect(rodar(m, ["a", "b"]).stderr).toMatch(/só o arquivo/);
    expect(rodar(m, ["--help"]).stdout).toMatch(/restaurar-painel\.sh/);
  });

  it("sem a imagem do painel: erro claro", async () => {
    const m = await montar({ image: false });
    const r = rodar(m, [await arquivo("2026-10-14_03-00.7z")]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/instale o painel primeiro/);
  });

  it("passa no bash -n (sintaxe)", () => {
    expect(spawnSync("bash", ["-n", SH]).status).toBe(0);
  });
});
