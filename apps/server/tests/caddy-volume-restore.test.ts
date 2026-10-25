/**
 * Dados do Caddy na restauração: o script que junta o .tar ao volume (rodado
 * de verdade com sh e tar, em pastas temporárias — sem Docker), o comando do
 * docker (CLI de mentira no PATH), o marcador de recarregamento e a troca do
 * painel na subida (a pasta _caddy nunca entra no diretório de dados).
 *
 * Os arquivos de teste não têm chave de verdade: só texto.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DockerCli, MERGE_VOLUME_SCRIPT } from "../src/services/backup-docker.js";
import { CADDY_RELOAD_MARKER_FILE, caddyReloadPending, consumeCaddyReload } from "../src/services/caddy-restore-reload.js";
import { applyPendingPanelRestore } from "../src/services/panel-restore.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-caddy-restore-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const mode = async (p: string) => ((await stat(p)).mode & 0o777).toString(8);

/** tar como o `docker cp paas-caddy:/data -` entrega: tudo sob "data/". */
async function makeTar(files: Record<string, { body: string; mode: number }>): Promise<string> {
  const src = path.join(dir, "src");
  for (const [rel, f] of Object.entries(files)) {
    const full = path.join(src, "data", rel);
    await mkdir(path.dirname(full), { recursive: true, mode: 0o755 });
    await writeFile(full, f.body);
    await chmod(full, f.mode);
  }
  const out = path.join(dir, "caddy-data.tar");
  execFileSync("tar", ["-cf", out, "-C", src, "data"]);
  return out;
}

function runMerge(volume: string, tarFile: string) {
  return spawnSync("sh", ["-c", MERGE_VOLUME_SCRIPT, "sh", volume], { input: execFileSync("cat", [tarFile]), encoding: "utf8" });
}

describe("MERGE_VOLUME_SCRIPT (sh + tar de verdade)", () => {
  const CRT = "caddy/certificates/acme-v02.api.letsencrypt.org-directory/loja.exemplo.com.br/loja.exemplo.com.br.crt";
  const KEY = "caddy/certificates/acme-v02.api.letsencrypt.org-directory/loja.exemplo.com.br/loja.exemplo.com.br.key";
  const ACCT = "caddy/acme/acme-v02.api.letsencrypt.org-directory/users/default/default.key";

  it("extrai sem o prefixo data/, com pastas 0700 e arquivos 0600 mesmo que o tar traga permissão aberta", async () => {
    const tar = await makeTar({
      [CRT]: { body: "certificado-de-teste", mode: 0o644 },
      [KEY]: { body: "chave-de-teste", mode: 0o666 },
      [ACCT]: { body: "conta-de-teste", mode: 0o755 },
    });
    const vol = path.join(dir, "vol");
    const r = runMerge(vol, tar);
    expect(r.status).toBe(0);
    expect(await readFile(path.join(vol, CRT), "utf8")).toBe("certificado-de-teste");
    expect(existsSync(path.join(vol, "data"))).toBe(false);
    expect(await mode(path.join(vol, KEY))).toBe("600");
    expect(await mode(path.join(vol, CRT))).toBe("600");
    expect(await mode(path.join(vol, ACCT))).toBe("600");
    expect(await mode(path.join(vol, "caddy"))).toBe("700");
    expect(await mode(path.join(vol, "caddy/certificates/acme-v02.api.letsencrypt.org-directory/loja.exemplo.com.br"))).toBe("700");
    expect(await mode(vol)).toBe("700");
  });

  it("junta sem apagar e sem sobrescrever: o que o Caddy desta VPS já tinha (inclusive o mesmo caminho) continua", async () => {
    const vol = path.join(dir, "vol");
    await mkdir(path.join(vol, "caddy/certificates/outro"), { recursive: true });
    await writeFile(path.join(vol, "caddy/certificates/outro/outro.crt"), "desta-vps");
    await mkdir(path.dirname(path.join(vol, ACCT)), { recursive: true });
    await writeFile(path.join(vol, ACCT), "conta-nova-desta-vps");
    await mkdir(path.dirname(path.join(vol, CRT)), { recursive: true });
    await writeFile(path.join(vol, CRT), "certificado-renovado-desta-vps");
    const tar = await makeTar({
      [ACCT]: { body: "conta-velha-do-backup", mode: 0o600 },
      [CRT]: { body: "certificado-velho-do-backup", mode: 0o600 },
      [KEY]: { body: "chave-so-do-backup", mode: 0o600 },
    });
    expect(runMerge(vol, tar).status).toBe(0);
    expect(await readFile(path.join(vol, "caddy/certificates/outro/outro.crt"), "utf8")).toBe("desta-vps");
    expect(await readFile(path.join(vol, ACCT), "utf8")).toBe("conta-nova-desta-vps");
    expect(await readFile(path.join(vol, CRT), "utf8")).toBe("certificado-renovado-desta-vps");
    // o que não existia vem do backup
    expect(await readFile(path.join(vol, KEY), "utf8")).toBe("chave-so-do-backup");
    // o que já estava lá também fica com permissão fechada
    expect(await mode(path.join(vol, "caddy/certificates/outro/outro.crt"))).toBe("600");
    expect(existsSync(path.join(vol, ".restaurando"))).toBe(false);
  });

  it("link simbólico absoluto no tar: recusa o tar inteiro, nada é extraído e nada escapa do volume", async () => {
    const src = path.join(dir, "src");
    await mkdir(path.join(src, "data/caddy"), { recursive: true });
    await writeFile(path.join(src, "data/caddy/ok.crt"), "ok");
    await symlink("/etc", path.join(src, "data/caddy/escape"));
    const tar = path.join(dir, "link.tar");
    execFileSync("tar", ["-cf", tar, "-C", src, "data"]);
    const vol = path.join(dir, "vol");
    const r = runMerge(vol, tar);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/link ou arquivo especial/);
    expect(existsSync(path.join(vol, "caddy"))).toBe(false);
    expect(existsSync(path.join(vol, ".restaurando"))).toBe(false);
  });

  it("link duro e arquivo especial (FIFO) no tar também são recusados", async () => {
    const src = path.join(dir, "src");
    await mkdir(path.join(src, "data/caddy"), { recursive: true });
    await writeFile(path.join(src, "data/caddy/a.crt"), "a");
    await link(path.join(src, "data/caddy/a.crt"), path.join(src, "data/caddy/b.crt"));
    const hard = path.join(dir, "hard.tar");
    execFileSync("tar", ["-cf", hard, "-C", src, "data"]);
    expect(runMerge(path.join(dir, "vol1"), hard).status).not.toBe(0);
    expect(existsSync(path.join(dir, "vol1/caddy"))).toBe(false);

    await rm(path.join(src, "data/caddy/b.crt"));
    execFileSync("mkfifo", [path.join(src, "data/caddy/fila")]);
    const fifo = path.join(dir, "fifo.tar");
    execFileSync("tar", ["-cf", fifo, "-C", src, "data"]);
    expect(runMerge(path.join(dir, "vol2"), fifo).status).not.toBe(0);
    expect(existsSync(path.join(dir, "vol2/caddy"))).toBe(false);
  });

  it("tar do busybox lista link duro como arquivo comum: a conferência depois da extração também recusa", async () => {
    const real = execFileSync("which", ["tar"], { encoding: "utf8" }).trim();
    const bin = path.join(dir, "bin-busybox");
    await mkdir(bin, { recursive: true });
    // `tar -tvf` de mentira: tudo aparece como "-rw-..." (como o busybox faz com o tipo '1'); o resto é o tar de verdade.
    await writeFile(
      path.join(bin, "tar"),
      `#!/bin/sh\nif [ "$1" = "-tvf" ]; then ${real} -tf "$2" | sed 's/^/-rw-r--r-- 0\\/0 1 2027-01-01 00:00 /'; else exec ${real} "$@"; fi\n`,
      { mode: 0o755 },
    );
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    const src = path.join(dir, "src");
    await mkdir(path.join(src, "data/caddy"), { recursive: true });
    await writeFile(path.join(src, "data/caddy/a.crt"), "a");
    await link(path.join(src, "data/caddy/a.crt"), path.join(src, "data/caddy/b.crt"));
    const hard = path.join(dir, "hard.tar");
    execFileSync(real, ["-cf", hard, "-C", src, "data"]);
    const vol = path.join(dir, "vol");
    const r = spawnSync("sh", ["-c", MERGE_VOLUME_SCRIPT, "sh", vol, hard], { env, encoding: "utf8" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/link ou arquivo especial/);
    expect(existsSync(path.join(vol, "caddy"))).toBe(false);
    // arquivo comum sozinho passa pelo mesmo tar de mentira
    await rm(path.join(src, "data/caddy/b.crt"));
    const ok = path.join(dir, "ok.tar");
    execFileSync(real, ["-cf", ok, "-C", src, "data"]);
    expect(spawnSync("sh", ["-c", MERGE_VOLUME_SCRIPT, "sh", path.join(dir, "vol2"), ok], { env, encoding: "utf8" }).status).toBe(0);
    expect(await readFile(path.join(dir, "vol2/caddy/a.crt"), "utf8")).toBe("a");
  });

  it("nomes que começam com .. ou com ponto, e uma pasta .restaurando vinda do tar, entram no volume", async () => {
    const src = path.join(dir, "src");
    await mkdir(path.join(src, "data/caddy/.restaurando"), { recursive: true });
    await writeFile(path.join(src, "data/caddy/..estranho.crt"), "dois-pontos");
    await writeFile(path.join(src, "data/caddy/.oculto.crt"), "oculto");
    await writeFile(path.join(src, "data/caddy/.restaurando/x.crt"), "do-tar");
    await writeFile(path.join(src, "data/caddy/normal.crt"), "normal");
    const tar = path.join(dir, "pontos.tar");
    execFileSync("tar", ["-cf", tar, "-C", src, "data"]);
    const vol = path.join(dir, "vol");
    const r = runMerge(vol, tar);
    expect(r.status, r.stderr).toBe(0);
    expect(await readFile(path.join(vol, "caddy/..estranho.crt"), "utf8")).toBe("dois-pontos");
    expect(await readFile(path.join(vol, "caddy/.oculto.crt"), "utf8")).toBe("oculto");
    expect(await readFile(path.join(vol, "caddy/.restaurando/x.crt"), "utf8")).toBe("do-tar");
    expect(await readFile(path.join(vol, "caddy/normal.crt"), "utf8")).toBe("normal");
    expect((await readdir(vol)).filter((n) => n.startsWith(".restaurando"))).toEqual([]);
  });

  it("tar que falha: a permissão do que já estava no volume é fechada mesmo assim e a pasta de passagem some", async () => {
    const vol = path.join(dir, "vol");
    await mkdir(path.join(vol, "caddy"), { recursive: true });
    await writeFile(path.join(vol, "caddy/antigo.key"), "x");
    await chmod(path.join(vol, "caddy/antigo.key"), 0o666);
    await chmod(path.join(vol, "caddy"), 0o777);
    const tar = await makeTar({ [CRT]: { body: "x".repeat(20000), mode: 0o644 } });
    const inteiro = await readFile(tar);
    await writeFile(tar, inteiro.subarray(0, Math.floor(inteiro.length / 2)));
    const r = runMerge(vol, tar);
    expect(r.status).not.toBe(0);
    expect(await mode(path.join(vol, "caddy/antigo.key"))).toBe("600");
    expect(await mode(path.join(vol, "caddy"))).toBe("700");
    expect(existsSync(path.join(vol, ".restaurando"))).toBe(false);
  });

  it("como root (id = 0) dá chown -R 0:0 no volume, inclusive quando o tar falha", async () => {
    const bin = path.join(dir, "bin");
    await mkdir(bin, { recursive: true });
    const log = path.join(dir, "chown.log");
    await writeFile(path.join(bin, "id"), "#!/bin/sh\necho 0\n", { mode: 0o755 });
    await writeFile(path.join(bin, "chown"), `#!/bin/sh\necho "$@" >> "${log}"\n`, { mode: 0o755 });
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    const vol = path.join(dir, "vol");
    const ok = await makeTar({ [CRT]: { body: "c", mode: 0o600 } });
    expect(spawnSync("sh", ["-c", MERGE_VOLUME_SCRIPT, "sh", vol, ok], { env, encoding: "utf8" }).status).toBe(0);
    const ruim = path.join(dir, "ruim.tar");
    await writeFile(ruim, "isto não é um tar");
    expect(spawnSync("sh", ["-c", MERGE_VOLUME_SCRIPT, "sh", vol, ruim], { env, encoding: "utf8" }).status).not.toBe(0);
    const linhas = (await readFile(log, "utf8")).trim().split("\n");
    expect(linhas).toEqual([`-R 0:0 ${vol}`, `-R 0:0 ${vol}`]);
  });

  it("tar com caminho que sobe de pasta (..) não escreve fora do volume", async () => {
    const payload = path.join(dir, "payload");
    await writeFile(payload, "escapou");
    const tar = path.join(dir, "mau.tar");
    execFileSync("tar", ["-cf", tar, "-C", dir, "--transform", "s|^payload$|data/../../escapou.txt|", "payload"]);
    const vol = path.join(dir, "vols", "vol");
    await mkdir(path.dirname(vol), { recursive: true });
    runMerge(vol, tar);
    expect(existsSync(path.join(dir, "escapou.txt"))).toBe(false);
    expect(existsSync(path.join(dir, "vols", "escapou.txt"))).toBe(false);
  });

  it("tar corrompido: o script sai com erro (nada de sucesso silencioso)", async () => {
    const tar = path.join(dir, "ruim.tar");
    await writeFile(tar, "isto não é um tar");
    expect(runMerge(path.join(dir, "vol"), tar).status).not.toBe(0);
  });
});

describe("DockerCli.mergeVolume", () => {
  let pathAntes: string | undefined;
  beforeEach(() => {
    pathAntes = process.env.PATH;
  });
  afterEach(() => {
    process.env.PATH = pathAntes;
  });

  async function dockerFalso(exit = 0): Promise<{ cli: DockerCli; args: string; stdin: string }> {
    const bin = path.join(dir, "bin");
    await mkdir(bin, { recursive: true });
    const args = path.join(dir, "args.txt");
    const stdin = path.join(dir, "stdin.txt");
    await writeFile(path.join(bin, "docker"), `#!/bin/sh\nfor a in "$@"; do printf '%s\\001' "$a"; done > "${args}"\ncat > "${stdin}"\nexit ${exit}\n`);
    await chmod(path.join(bin, "docker"), 0o755);
    process.env.PATH = `${bin}:${pathAntes}`;
    return { cli: new DockerCli({ socketPath: "/var/run/docker.sock", helperImage: "alpine:3", timeoutMs: 20_000 }), args, stdin };
  }

  it("roda o container auxiliar como root, sem rede, só com o volume do Caddy, e passa o tar pela entrada padrão", async () => {
    const { cli, args, stdin } = await dockerFalso();
    const tar = path.join(dir, "x.tar");
    await writeFile(tar, "conteudo-do-tar");
    await cli.mergeVolume("paas_caddy_data", tar);
    const a = (await readFile(args, "utf8")).split("\u0001");
    expect(a.slice(0, 8)).toEqual(["run", "--rm", "-i", "--network", "none", "--user", "0", "-v"]);
    expect(a).toContain("paas_caddy_data:/v");
    expect(a).toContain("alpine:3");
    expect(a).toContain(MERGE_VOLUME_SCRIPT);
    expect(a.filter((x) => x.startsWith("-v"))).toHaveLength(1);
    expect(a.some((x) => x.includes("conteudo-do-tar"))).toBe(false);
    expect(await readFile(stdin, "utf8")).toBe("conteudo-do-tar");
  });

  it("docker com erro: a promessa rejeita", async () => {
    const { cli } = await dockerFalso(3);
    const tar = path.join(dir, "x.tar");
    await writeFile(tar, "x");
    await expect(cli.mergeVolume("paas_caddy_data", tar)).rejects.toThrow();
  });
});

describe("recarregamento do Caddy depois da restauração", () => {
  const marker = () => path.join(dir, CADDY_RELOAD_MARKER_FILE);

  it("sem marcador: não recarrega", async () => {
    const reload = vi.fn(async () => undefined);
    expect(await caddyReloadPending(dir)).toBe(false);
    expect(await consumeCaddyReload({ backupsDir: dir, reload })).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("com marcador: recarrega (forçado, quem chama) e apaga o marcador", async () => {
    await writeFile(marker(), "{}");
    const reload = vi.fn(async () => undefined);
    expect(await caddyReloadPending(dir)).toBe(true);
    expect(await consumeCaddyReload({ backupsDir: dir, reload })).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(existsSync(marker())).toBe(false);
    expect(await consumeCaddyReload({ backupsDir: dir, reload })).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("recarregamento que falha: o marcador fica para a próxima tentativa e o erro vai para o log", async () => {
    await writeFile(marker(), "{}");
    const logs: string[] = [];
    const ok = await consumeCaddyReload({
      backupsDir: dir,
      reload: async () => {
        throw new Error("proxy ainda subindo");
      },
      log: (m) => logs.push(m),
    });
    expect(ok).toBe(false);
    expect(existsSync(marker())).toBe(true);
    expect(logs.join(" ")).toContain("proxy ainda subindo");
    // sem função de log e com erro que não é Error: não lança
    expect(
      await consumeCaddyReload({
        backupsDir: dir,
        reload: async () => {
          throw "texto";
        },
      }),
    ).toBe(false);
    expect(
      await consumeCaddyReload({
        backupsDir: dir,
        reload: async () => {
          throw "texto solto";
        },
        log: (m) => logs.push(m),
      }),
    ).toBe(false);
    expect(logs.join(" ")).toContain("texto solto");
  });

  it("o marcador fica em data/backups: a troca do painel o preserva", async () => {
    await mkdir(path.join(dir, "backups/.restaurar-painel"), { recursive: true });
    await writeFile(path.join(dir, "backups", CADDY_RELOAD_MARKER_FILE), "{}");
    await writeFile(path.join(dir, "users.json"), "atual");
    await writeFile(path.join(dir, "backups/.restaurar-painel/users.json"), "do-backup");
    await writeFile(path.join(dir, "backups/.restaurar-painel.json"), JSON.stringify({ requestedAt: "2026-10-14T12:00:00Z", fileName: "2026-10-14_03-00.7z", actor: "admin" }));
    await applyPendingPanelRestore(dir, { now: () => new Date("2026-10-14T12:01:00Z") });
    expect(existsSync(path.join(dir, "backups", CADDY_RELOAD_MARKER_FILE))).toBe(true);
  });
});

describe("troca do painel na subida: _caddy nunca entra no diretório de dados", () => {
  it("se sobrou uma pasta _caddy no estado extraído, ela não vai para o /data", async () => {
    const stage = path.join(dir, "backups/.restaurar-painel");
    await mkdir(path.join(stage, "_caddy"), { recursive: true });
    await writeFile(path.join(stage, "_caddy/caddy-data.tar"), "chaves-de-teste");
    await writeFile(path.join(stage, "users.json"), "do-backup");
    await writeFile(path.join(dir, "users.json"), "atual");
    await writeFile(path.join(dir, "backups/.restaurar-painel.json"), JSON.stringify({ requestedAt: "2026-10-14T12:00:00Z", fileName: "2026-10-14_03-00.7z", actor: "admin" }));
    const r = await applyPendingPanelRestore(dir, { now: () => new Date("2026-10-14T12:01:00Z") });
    expect(r).toMatchObject({ outcome: "applied" });
    expect(await readFile(path.join(dir, "users.json"), "utf8")).toBe("do-backup");
    expect(existsSync(path.join(dir, "_caddy"))).toBe(false);
    expect(existsSync(path.join(dir, "caddy-data.tar"))).toBe(false);
  });
});
