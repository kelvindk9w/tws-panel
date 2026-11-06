/**
 * Atualização pelo install.sh quando o repositório remoto é relançado com outro histórico. Execução REAL da função
 * sync_repo extraída do install.sh, com repositórios git temporários (remoto local, sem rede).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeDirSync } from "./helpers/tmp.js";

const raiz = path.resolve(__dirname, "../../..");
const sh = readFileSync(path.join(raiz, "scripts/install.sh"), "utf8");
const pegar = (nome: string) => sh.match(new RegExp(`^${nome}\\(\\) \\{[\\s\\S]*?^\\}`, "m"))?.[0] ?? "";
const preludio = `log() { echo "LOG: $*"; }\nwarn() { echo "AVISO: $*" >&2; }\ndie() { echo "ERRO: $*" >&2; exit 1; }\n`;

const pastas: string[] = [];
afterEach(() => {
  for (const p of pastas.splice(0)) removeDirSync(p);
});

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};
delete (gitEnv as Record<string, string | undefined>).GIT_DIR;
delete (gitEnv as Record<string, string | undefined>).GIT_WORK_TREE;
delete (gitEnv as Record<string, string | undefined>).GIT_INDEX_FILE;

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: gitEnv });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function commit(dir: string, arquivo: string, conteudo: string) {
  mkdirSync(path.dirname(path.join(dir, arquivo)), { recursive: true });
  writeFileSync(path.join(dir, arquivo), conteudo);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", `muda ${arquivo}`);
}

interface Cenario {
  /** "antigo" = clone do histórico original; o remoto é recriado conforme o caso */
  remoto: "relacionado" | "nao-relacionado" | "divergente" | "inacessivel";
  modo?: "completo" | "conservador";
  /** mudança local em arquivo versionado antes de atualizar */
  sujo?: boolean;
  /** HEAD solto */
  headSolto?: boolean;
}

function montar(c: Cenario) {
  const base = mkdtempSync(path.join(tmpdir(), "repo-relancado-"));
  pastas.push(base);
  const remoto = path.join(base, "remoto");
  const local = path.join(base, "local");
  mkdirSync(remoto);
  git(remoto, "init", "-q", "-b", "main");
  commit(remoto, "app.txt", "v1\n");
  commit(remoto, ".gitignore", ".env\ndata/\n");
  git(base, "clone", "-q", remoto, local);
  // arquivos de runtime ignorados, que NUNCA podem sumir
  writeFileSync(path.join(local, ".env"), "SEGREDO=1\n");
  mkdirSync(path.join(local, "data"));
  writeFileSync(path.join(local, "data", "estado.json"), '{"ok":true}');
  const antigo = git(local, "rev-parse", "HEAD");

  if (c.remoto === "relacionado") {
    commit(remoto, "app.txt", "v2\n");
  } else if (c.remoto === "nao-relacionado") {
    // repositório relançado do zero: mesmo conteúdo-base, histórico novo de um único commit
    git(remoto, "checkout", "-q", "--orphan", "novo");
    commit(remoto, "app.txt", "v-novo\n");
    git(remoto, "branch", "-q", "-D", "main");
    git(remoto, "branch", "-q", "-m", "main");
  } else if (c.remoto === "divergente") {
    commit(remoto, "app.txt", "v2\n");
    commit(local, "local.txt", "so local\n");
  } else {
    git(local, "remote", "set-url", "origin", path.join(base, "nao-existe"));
  }
  if (c.sujo) writeFileSync(path.join(local, "app.txt"), "editado na mão\n");
  if (c.headSolto) git(local, "checkout", "-q", "--detach");
  return { base, remoto, local, antigo };
}

interface OpcoesRodar {
  /** REPO_URL oficial; padrão = a URL do remoto do clone (cenário "é o repositório oficial") */
  repoUrl?: string;
  /** diretório com um `git` falso na frente do PATH */
  path?: string;
}

function rodar(local: string, modo: "completo" | "conservador" = "completo", o: OpcoesRodar = {}) {
  const fn = `${pegar("normalize_git_url")}\n${pegar("devolver_dono")}\n${pegar("sync_repo")}`;
  expect(fn.length, "sync_repo não encontrada no install.sh").toBeGreaterThan(400);
  let url = o.repoUrl;
  if (url === undefined) {
    const r = spawnSync("git", ["-C", local, "config", "--get", "remote.origin.url"], { encoding: "utf8", env: gitEnv });
    url = r.stdout.trim();
  }
  const env = o.path ? { ...gitEnv, PATH: `${o.path}:${process.env.PATH ?? ""}` } : gitEnv;
  return spawnSync("bash", ["-c", `${preludio}\nREPO_URL="$3"\n${fn}\nsync_repo "$1" "$2"`, "x", local, modo, url], {
    encoding: "utf8",
    env,
  });
}

const ler = (...p: string[]) => readFileSync(path.join(...p), "utf8");

describe("sync_repo (install.sh): atualização com repositório relançado", () => {
  it("histórico relacionado: avanço rápido normal, sem backup", () => {
    const { local, remoto } = montar({ remoto: "relacionado" });
    const r = rodar(local);
    expect(r.status, r.stderr).toBe(0);
    expect(ler(local, "app.txt")).toBe("v2\n");
    expect(git(local, "rev-parse", "HEAD")).toBe(git(remoto, "rev-parse", "HEAD"));
    expect(git(local, "for-each-ref", "refs/tws-backup")).toBe("");
  });

  it("modo conservador com histórico relacionado e árvore limpa: avança rápido e marca o código como trocado", () => {
    const { local, remoto } = montar({ remoto: "relacionado" });
    const fn = `${pegar("normalize_git_url")}\n${pegar("devolver_dono")}\n${pegar("sync_repo")}`;
    const url = git(local, "config", "--get", "remote.origin.url");
    const r = spawnSync("bash", ["-c", `${preludio}\nREPO_URL="$2"\nSYNC_SWITCHED=0\n${fn}\nsync_repo "$1" conservador\necho "SWITCHED=$SYNC_SWITCHED"`, "x", local, url], {
      encoding: "utf8",
      env: gitEnv,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(git(local, "rev-parse", "HEAD")).toBe(git(remoto, "rev-parse", "HEAD"));
    expect(ler(local, "app.txt")).toBe("v2\n");
    expect(r.stdout).toContain("SWITCHED=1");
    expect(git(local, "for-each-ref", "refs/tws-backup")).toBe("");
    expect(ler(local, ".env")).toBe("SEGREDO=1\n");
  });

  it("modo conservador já na versão do remoto: não faz nada e não pede reexecução", () => {
    const { local } = montar({ remoto: "inacessivel" });
    git(local, "remote", "set-url", "origin", git(local, "rev-parse", "--show-toplevel") + "/.git");
    const fn = `${pegar("normalize_git_url")}\n${pegar("devolver_dono")}\n${pegar("sync_repo")}`;
    const r = spawnSync("bash", ["-c", `${preludio}\nREPO_URL=x\nSYNC_SWITCHED=0\n${fn}\nsync_repo "$1" conservador\necho "SWITCHED=$SYNC_SWITCHED"`, "x", local], { encoding: "utf8", env: gitEnv });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("SWITCHED=0");
    expect(r.stderr).toBe("");
  });

  it("modo conservador com mudança local em arquivo versionado: avisa, não atualiza, não faz stash nem reset", () => {
    const { local, antigo } = montar({ remoto: "relacionado", sujo: true });
    const r = rodar(local, "conservador");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain("mudanças locais em arquivos versionados");
    expect(r.stderr).toContain("app.txt");
    expect(r.stderr).toContain("--sem-atualizar");
    expect(git(local, "rev-parse", "HEAD")).toBe(antigo);
    expect(ler(local, "app.txt")).toBe("editado na mão\n");
    expect(git(local, "stash", "list")).toBe("");
  });

  it("modo conservador com histórico divergente: aviso claro e nenhum reset", () => {
    const { local } = montar({ remoto: "divergente" });
    const localHead = git(local, "rev-parse", "HEAD");
    const r = rodar(local, "conservador");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain("DIVERGIU");
    expect(git(local, "rev-parse", "HEAD")).toBe(localHead);
    expect(ler(local, "local.txt")).toBe("so local\n");
  });

  it("histórico não relacionado e árvore limpa: guarda o commit antigo em refs/tws-backup, troca para o remoto e preserva .env e data/", () => {
    const { local, remoto, antigo } = montar({ remoto: "nao-relacionado" });
    const r = rodar(local);
    expect(r.status, r.stderr).toBe(0);
    expect(git(local, "rev-parse", "HEAD")).toBe(git(remoto, "rev-parse", "HEAD"));
    expect(ler(local, "app.txt")).toBe("v-novo\n");
    const refs = git(local, "for-each-ref", "--format=%(refname) %(objectname)", "refs/tws-backup");
    expect(refs).toMatch(/^refs\/tws-backup\/\d{8}-\d{6} [0-9a-f]{40}$/);
    expect(refs.split(" ")[1]).toBe(antigo);
    expect(git(local, "rev-parse", "--abbrev-ref", "main@{upstream}")).toBe("origin/main");
    // dados do operador intactos
    expect(ler(local, ".env")).toBe("SEGREDO=1\n");
    expect(ler(local, "data", "estado.json")).toBe('{"ok":true}');
    // o log diz o que foi feito e como voltar
    expect(r.stdout).toContain("refs/tws-backup/");
    expect(r.stdout).toContain("checkout -B main refs/tws-backup/");
    // e voltar de fato funciona
    git(local, "checkout", "-q", "-B", "main", refs.split(" ")[0]!);
    expect(git(local, "rev-parse", "HEAD")).toBe(antigo);
    expect(existsSync(path.join(local, "data", "estado.json"))).toBe(true);
  });

  it("modo conservador também trata o histórico não relacionado", () => {
    const { local, remoto } = montar({ remoto: "nao-relacionado" });
    const r = rodar(local, "conservador");
    expect(r.status, r.stderr).toBe(0);
    expect(git(local, "rev-parse", "HEAD")).toBe(git(remoto, "rev-parse", "HEAD"));
  });

  it("histórico não relacionado com mudança local versionada: erro claro e nada alterado", () => {
    const { local, antigo } = montar({ remoto: "nao-relacionado", sujo: true });
    const r = rodar(local);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("outro histórico");
    expect(r.stderr).toContain("app.txt");
    expect(r.stderr).toContain("stash push");
    expect(r.stderr).toContain("-c user.name=tws-panel -c user.email=tws-panel@localhost");
    expect(r.stderr).toContain("/root/tws-mudancas.patch");
    expect(r.stderr).toContain("sudo git");
    expect(git(local, "rev-parse", "HEAD")).toBe(antigo);
    expect(ler(local, "app.txt")).toBe("editado na mão\n");
    expect(git(local, "for-each-ref", "refs/tws-backup")).toBe("");
    expect(ler(local, ".env")).toBe("SEGREDO=1\n");
  });

  it("histórico não relacionado com arquivo não versionado no caminho de um arquivo novo: recusa, sem perder nada", () => {
    const { local, remoto } = montar({ remoto: "nao-relacionado" });
    commit(remoto, "extra.txt", "do remoto\n");
    writeFileSync(path.join(local, "extra.txt"), "meu, não versionado\n");
    const r = rodar(local);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("refs/tws-backup/");
    expect(ler(local, "extra.txt")).toBe("meu, não versionado\n");
    expect(ler(local, ".env")).toBe("SEGREDO=1\n");
  });

  it("histórico divergente (relacionado): aviso claro e nenhum reset", () => {
    const { local, antigo } = montar({ remoto: "divergente" });
    const localHead = git(local, "rev-parse", "HEAD");
    const r = rodar(local);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain("DIVERGIU");
    expect(r.stderr).toContain("reset --hard origin/main");
    expect(git(local, "rev-parse", "HEAD")).toBe(localHead);
    expect(localHead).not.toBe(antigo);
    expect(ler(local, "local.txt")).toBe("so local\n");
    expect(git(local, "for-each-ref", "refs/tws-backup")).toBe("");
  });

  it("falha de rede no fetch: só aviso, segue com a versão local", () => {
    const { local, antigo } = montar({ remoto: "inacessivel" });
    const r = rodar(local);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain("Não consegui consultar o repositório remoto");
    expect(git(local, "rev-parse", "HEAD")).toBe(antigo);
  });

  it("HEAD solto: avisa nos dois modos e não mexe", () => {
    for (const modo of ["conservador", "completo"] as const) {
      const a = montar({ remoto: "nao-relacionado", headSolto: true });
      const r = rodar(a.local, modo);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).toContain("HEAD solto");
      expect(git(a.local, "rev-parse", "HEAD")).toBe(a.antigo);
    }
  });

  it("erro do git (pasta que não é repositório / dubious ownership) não vira 'HEAD solto': avisa com o erro do git", () => {
    const base = mkdtempSync(path.join(tmpdir(), "repo-relancado-"));
    pastas.push(base);
    for (const modo of ["conservador", "completo"] as const) {
      const r = rodar(base, modo, { repoUrl: "x" });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).toContain("não conseguiu usar o repositório");
      expect(r.stderr).not.toContain("HEAD solto");
    }
  });

  it("fetch que falha mostra o erro do git no aviso", () => {
    const { local } = montar({ remoto: "inacessivel" });
    const r = rodar(local);
    expect(r.stderr).toMatch(/Não consegui consultar o repositório remoto \(origin\): .*(fatal|não|does not)/i);
  });

  it("merge-base que falha por outro motivo (128) NÃO é histórico não relacionado: avisa e não mexe", () => {
    const { local, base, antigo } = montar({ remoto: "nao-relacionado" });
    const fake = path.join(base, "fake");
    mkdirSync(fake);
    const real = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
    writeFileSync(path.join(fake, "git"), `#!/bin/bash\nfor a in "$@"; do [ "$a" = merge-base ] && { echo "fatal: simulado" >&2; exit 128; }; done\nexec ${real} "$@"\n`, { mode: 0o755 });
    const r = rodar(local, "completo", { path: fake });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain("código 128");
    expect(git(local, "rev-parse", "HEAD")).toBe(antigo);
    expect(git(local, "for-each-ref", "refs/tws-backup")).toBe("");
  });

  it("remoto que não é o repositório oficial: para, mostra a URL e não altera nada", () => {
    const { local, antigo } = montar({ remoto: "nao-relacionado" });
    const r = rodar(local, "completo", { repoUrl: "https://github.com/kelvindk9w/tws-panel.git" });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("Remoto 'origin':");
    expect(r.stderr).toContain("não é o repositório oficial");
    expect(r.stderr).toContain("checkout -B main origin/main");
    expect(git(local, "rev-parse", "HEAD")).toBe(antigo);
    expect(git(local, "for-each-ref", "refs/tws-backup")).toBe("");
  });

  it("normalize_git_url: https, ssh, .git, barra final e caixa são o mesmo repositório", () => {
    const iguais = [
      "https://github.com/KelvinDK9W/tws-panel.git",
      "https://github.com/kelvindk9w/tws-panel",
      "https://github.com/kelvindk9w/tws-panel/",
      "git@github.com:kelvindk9w/tws-panel.git",
      "ssh://git@github.com/kelvindk9w/tws-panel.git",
      "https://token@github.com/kelvindk9w/tws-panel.git",
    ];
    const saidas = iguais.map((u) =>
      spawnSync("bash", ["-c", `${pegar("normalize_git_url")}\nnormalize_git_url "$1"`, "x", u], { encoding: "utf8" }).stdout,
    );
    expect(new Set(saidas)).toEqual(new Set(["github.com/kelvindk9w/tws-panel"]));
    const outro = spawnSync("bash", ["-c", `${pegar("normalize_git_url")}\nnormalize_git_url "$1"`, "x", "https://github.com/outro/tws-panel.git"], { encoding: "utf8" }).stdout;
    expect(outro).not.toBe(saidas[0]);
    // "@" no caminho não forja o host oficial
    const forjado = spawnSync(
      "bash",
      ["-c", `${pegar("normalize_git_url")}\nnormalize_git_url "$1"`, "x", "https://evil.example/x@github.com/kelvindk9w/tws-panel"],
      { encoding: "utf8" },
    ).stdout;
    expect(forjado).toBe("evil.example/x@github.com/kelvindk9w/tws-panel");
    expect(forjado).not.toBe(saidas[0]);
  });

  it("depois de trocar o código, o chamador reexecuta o install.sh NOVO uma vez, com os mesmos argumentos", () => {
    const { local, remoto, base } = montar({ remoto: "nao-relacionado" });
    commit(remoto, "scripts/install.sh", '#!/bin/bash\necho "NOVO reexec=$TWS_SYNC_REEXEC args=$*"\n');
    const bloco = sh.match(/^ {2}if \[ "\$SYNC_SWITCHED" = 1 \][\s\S]*?^ {2}fi$/m)?.[0] ?? "";
    expect(bloco.length).toBeGreaterThan(50);
    const url = git(local, "config", "--get", "remote.origin.url");
    const prog = `${preludio}\nREPO_URL="$1"\nAPP_DIR="$2"\nshift 2\nORIG_ARGS=("$@")\n${pegar("normalize_git_url")}\n${pegar("devolver_dono")}\n${pegar("sync_repo")}\nsync_repo "$APP_DIR" conservador\n${bloco}\necho "NAO-REEXEC"`;
    const r = spawnSync("bash", ["-c", prog, "x", url, local, "--sem-esperar-deploy", "--port=9100"], { encoding: "utf8", env: gitEnv });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("NOVO reexec=1 args=--sem-esperar-deploy --port=9100");
    expect(r.stdout).not.toContain("NAO-REEXEC");
    expect(base).toBeTruthy();
    // já reexecutado (TWS_SYNC_REEXEC definido): não entra em laço
    expect(bloco).toContain("TWS_SYNC_REEXEC");
  });

  it("devolve os arquivos ao dono da pasta depois do checkout (só quando root e dono diferente)", () => {
    const fn = pegar("devolver_dono");
    expect(pegar("sync_repo")).toMatch(/devolver_dono "\$dir"/);
    expect(fn).toMatch(/id -u/);
    expect(fn).toMatch(/chown -R "\$owner" "\$dir\/\.git"/);
    expect(fn).toMatch(/!= 0/);
    expect(fn).toMatch(/ls-tree -r -d -z --name-only HEAD[^\n]*chown -h/);
    expect(sh).toMatch(/pré-flight e as perguntas iniciais vão aparecer de novo/);
  });

  it("o .gitignore do projeto cobre os caminhos de runtime e o script nunca usa git clean", () => {
    const gi = readFileSync(path.join(raiz, ".gitignore"), "utf8").split("\n");
    expect(gi).toContain("data/");
    expect(gi).toContain(".env");
    const codigo = sh
      .split("\n")
      .filter((l) => !l.trim().startsWith("#"))
      .join("\n");
    expect(codigo).not.toMatch(/git[^\n]*\bclean\b/);
    expect(pegar("sync_repo")).not.toMatch(/^\s*(git -C "\$dir" reset|rm)\b/m);
  });

  it("o fluxo do instalador chama sync_repo nos dois caminhos (repo detectado e repo já existente), salvo --sem-atualizar", () => {
    expect(sh).toMatch(/usando o diretório atual\."\n  if \[ "\$SKIP_UPDATE" = 1 \]; then[\s\S]*?else\n    sync_repo "\$APP_DIR" conservador/);
    expect(sh).toMatch(/sync_repo "\$APP_DIR" completo/);
    expect(sh).toMatch(/--sem-atualizar\) SKIP_UPDATE=1/);
    expect(sh).toMatch(/^ {2}--sem-atualizar /m);
    expect(sh).not.toMatch(/git -C "\$APP_DIR" pull --ff-only \|\|/);
  });
});

describe("install.sh: --sem-atualizar", () => {
  it("o --help documenta a opção e o bloco de reexecução só roda depois de uma atualização real", () => {
    const r = spawnSync("bash", [path.join(raiz, "scripts/install.sh"), "--help"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("--sem-atualizar");
    expect(r.stdout).toMatch(/avanço rápido/);
  });

  it("a mensagem final aponta o instalador como forma de atualizar", () => {
    expect(sh).not.toContain("rebuild/restart (ex.: após git pull)");
    expect(sh).toMatch(/sudo \.\/scripts\/install\.sh\s+# atualiza o código/);
  });
});
