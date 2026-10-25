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
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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

  it("junta sem apagar: o que o Caddy desta VPS já tinha continua; o mesmo caminho é trocado pelo do backup", async () => {
    const vol = path.join(dir, "vol");
    await mkdir(path.join(vol, "caddy/certificates/outro"), { recursive: true });
    await writeFile(path.join(vol, "caddy/certificates/outro/outro.crt"), "desta-vps");
    await mkdir(path.dirname(path.join(vol, ACCT)), { recursive: true });
    await writeFile(path.join(vol, ACCT), "conta-antiga");
    const tar = await makeTar({ [ACCT]: { body: "conta-do-backup", mode: 0o600 }, [CRT]: { body: "crt", mode: 0o600 } });
    expect(runMerge(vol, tar).status).toBe(0);
    expect(await readFile(path.join(vol, "caddy/certificates/outro/outro.crt"), "utf8")).toBe("desta-vps");
    expect(await readFile(path.join(vol, ACCT), "utf8")).toBe("conta-do-backup");
    expect(await readFile(path.join(vol, CRT), "utf8")).toBe("crt");
    // o que já estava lá também fica com permissão fechada
    expect(await mode(path.join(vol, "caddy/certificates/outro/outro.crt"))).toBe("600");
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
