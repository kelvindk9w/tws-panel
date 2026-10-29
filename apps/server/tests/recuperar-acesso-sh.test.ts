/**
 * recuperar-acesso-sh.test.ts — scripts/recuperar-acesso.sh com fail2ban-client, docker, curl, ssh-keygen,
 * runuser e getent FALSOS num diretório temporário: nada toca a máquina real. O script NÃO abre SSH por senha
 * (não existe janela, timer nem mexida no sshd); aqui se confere o desbloqueio do fail2ban, o roteamento do
 * menu para os outros scripts, a instalação das chaves de uma conta do GitHub (validação do nome, impressões
 * digitais, confirmação, proteções do authorized_keys), a recusa de root e o --help.
 */
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeDir } from "./helpers/tmp.js";

const SH = path.resolve(__dirname, "../../../scripts/recuperar-acesso.sh");
const MJS = path.resolve(__dirname, "../../../scripts/reset-2fa.mjs");
const SCRIPT_SOURCE = path.resolve(__dirname, "../../../scripts/recuperar-acesso.sh");

let dir: string;
let bin: string;
let scripts: string;
let home: string;
let log: string;

const KEY_A = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIC9JAFDTUqwvSdNKOQH1xA7JKESeoFlhyGblHHhgofBT";
const KEY_B = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILSr6Jdm+iXYbln6BfkP2uCTKNO/eVi89lEjP7rH7dHN";
const KEY_RSA = `ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC${"A".repeat(60)}`;
const KEY_RSA_1024 = `ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAAgQR1024${"B".repeat(60)}`;
const KEY_RSA_2048 = `ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQR2048${"C".repeat(60)}`;
const KEY_SK = "sk-ssh-ed25519@openssh.com AAAAGnNrLXNzaC1lZDI1NTE5QG9wZW5zc2guY29tAAAAIC9JAFDTUqwvSdNKOQH1xA7JKESeoFlhyGblHHhgofBT";

const FAKE_F2B = `#!/usr/bin/env bash
echo "f2b $*" >> "$FAKE_LOG"
if [ "$1" = "status" ]; then
  echo "Status for the jail: $2"
  echo "   |- Currently banned: 2"
  echo '   \`- Banned IP list:   203.0.113.7 198.51.100.9'
fi
exit 0
`;
const FAKE_DOCKER = `#!/usr/bin/env bash
echo "docker $*" >> "$FAKE_LOG"
case "$1" in
  image) exit 0 ;;
  ps) echo tws-panel; exit 0 ;;
  stop|start) exit 0 ;;
  run)
    shift; args=(); seen=0
    for a in "$@"; do
      if [ "$a" = "/app/scripts/reset-2fa.mjs" ]; then seen=1; continue; fi
      [ "$seen" = "1" ] || continue
      [ "$a" = "/data/users.json" ] && a="$FAKE_USERS"
      args+=("$a")
    done
    exec node "$FAKE_MJS" "\${args[@]}" ;;
esac
`;
const FAKE_CURL = `#!/usr/bin/env bash
echo "curl $*" >> "$FAKE_LOG"
[ "\${FAKE_CURL_EXIT:-0}" = "0" ] || exit "$FAKE_CURL_EXIT"
cat "$FAKE_KEYS_BODY"
`;
// os bits vêm do tipo e de marcadores no blob (R1024 / R2048), como o ssh-keygen -l faria
const FAKE_KEYGEN = `#!/usr/bin/env bash
read -r type blob
bits=256
if [ "$type" = "ssh-rsa" ]; then
  case "$blob" in *R1024*) bits=1024 ;; *R2048*) bits=2048 ;; *) bits=3072 ;; esac
fi
echo "$bits SHA256:fp-\${blob:0:12} fake (X)"
`;
// runuser -u USUARIO -- COMANDO...: só descarta o prefixo e executa como quem chamou
const FAKE_RUNUSER = `#!/usr/bin/env bash
echo "runuser $*" >> "$FAKE_LOG"
shift 3
exec "$@"
`;
const FAKE_GETENT = `#!/usr/bin/env bash
echo "$2:x:1000:1000::$FAKE_HOME:/bin/bash"
`;

async function fake(name: string, body: string) {
  const p = path.join(bin, name);
  await writeFile(p, body);
  await chmod(p, 0o755);
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-recuperar-"));
  bin = path.join(dir, "bin");
  scripts = path.join(dir, "scripts");
  home = path.join(dir, "home");
  log = path.join(dir, "calls.log");
  await mkdir(bin);
  await mkdir(scripts);
  await mkdir(home);
  await chmod(home, 0o755);
  await writeFile(log, "");
  await writeFile(path.join(dir, "keys.txt"), `${KEY_A} dono@notebook\n${KEY_B}\n`);
  await fake("fail2ban-client", FAKE_F2B);
  await fake("docker", FAKE_DOCKER);
  await fake("curl", FAKE_CURL);
  await fake("ssh-keygen", FAKE_KEYGEN);
  await fake("runuser", FAKE_RUNUSER);
  await fake("getent", FAKE_GETENT);
  for (const s of ["reativar-acesso-ip.sh", "reset-2fa.sh", "reset-senha.sh"]) {
    await writeFile(path.join(scripts, s), `#!/usr/bin/env bash\necho "sibling ${s} $*" >> "$FAKE_LOG"\n`);
  }
});
afterEach(async () => {
  await removeDir(dir);
});

function run(args: string[], input = "", env: Record<string, string> = {}) {
  return spawnSync("bash", [SH, ...args], {
    input,
    encoding: "utf8",
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      ENV_FILE: path.join(dir, "nao-existe.env"),
      FAIL2BAN_CLIENT: "fail2ban-client",
      DOCKER: "docker",
      CURL: "curl",
      SSH_KEYGEN: "ssh-keygen",
      RUNUSER: "runuser",
      GETENT: "getent",
      PAAS_SCRIPTS_DIR: scripts,
      PAAS_ASSUME_ROOT: "1",
      FAKE_LOG: log,
      FAKE_MJS: MJS,
      FAKE_HOME: home,
      FAKE_KEYS_BODY: path.join(dir, "keys.txt"),
      ...env,
    },
  });
}

const calls = async () => (await readFile(log, "utf8")).trim().split("\n").map((l) => l.trim()).filter(Boolean);
const authorized = () => path.join(home, ".ssh/authorized_keys");

describe("scripts/recuperar-acesso.sh — sem janela de SSH por senha", () => {
  it("o script não tem mais janela, timer, at nem mexida no sshd; subcomandos antigos são recusados", async () => {
    const source = await readFile(SCRIPT_SOURCE, "utf8");
    expect(source).not.toMatch(/PasswordAuthentication|sshd_config|systemctl|schedule_close|atq|OnActiveSec/);
    for (const old of ["janela", "fechar"]) {
      const r = run([old]);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/argumento desconhecido/);
    }
    expect((await calls()).some((l) => l.startsWith("systemctl"))).toBe(false);
  });
});

describe("scripts/recuperar-acesso.sh — instalar chave do GitHub", () => {
  it("mostra as impressões digitais, pede confirmação e grava com permissão 600, pasta 700 e comentário do GitHub", async () => {
    const r = run(["github", "--usuario", "nobody", "--github", "octocat"], "s\n");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/1\) ssh-ed25519 {2}256 bits {2}SHA256:fp-AAAAC3NzaC1l/);
    expect(r.stdout).toMatch(/2\) ssh-ed25519/);
    expect(r.stdout).toMatch(/github\.com\/settings\/keys/);
    const text = await readFile(authorized(), "utf8");
    expect(text).toBe(`${KEY_A} github-octocat\n${KEY_B} github-octocat\n`);
    expect((await stat(authorized())).mode & 0o777).toBe(0o600);
    expect((await stat(path.join(home, ".ssh"))).mode & 0o777).toBe(0o700);
    const c = await calls();
    expect(c.some((l) => l.startsWith("curl") && l.includes("--proto =https") && l.endsWith("https://github.com/octocat.keys"))).toBe(true);
    expect(c.some((l) => l.startsWith("runuser -u nobody -- env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin sh -c"))).toBe(true);
    expect(r.stdout).toMatch(/2 chave\(s\) nova\(s\)/);
  });

  it("sem confirmar (ENTER ou qualquer coisa diferente de s) não grava nada", async () => {
    for (const answer of ["\n", "n\n", "sim\n", ""]) {
      const r = run(["github", "--usuario", "nobody", "--github", "octocat"], answer);
      expect(r.status, r.stderr).toBe(0);
      expect(existsSync(authorized())).toBe(false);
    }
    expect((await calls()).some((l) => l.startsWith("runuser"))).toBe(false);
  });

  it("pelo menu (opção 5) pergunta o usuário do GitHub", async () => {
    const r = run(["--usuario", "nobody"], "5\n octocat \ns\n");
    expect(r.status, r.stderr).toBe(0);
    expect(await readFile(authorized(), "utf8")).toContain("github-octocat");
  });

  it.each(["-ruim", "ruim-", "a--b", "x;rm -rf", "com espaco", "a/b", "../x", "n".repeat(40), "açai", "$(id)"])(
    "nome de usuário do GitHub inválido %j é recusado antes de qualquer download",
    async (name) => {
      const r = run(["github", "--usuario", "nobody", "--github", name], "s\n");
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/inválido/);
      expect((await calls()).some((l) => l.startsWith("curl"))).toBe(false);
      expect(existsSync(authorized())).toBe(false);
    },
  );

  it("aceita nomes válidos com hífen no meio e 39 caracteres", async () => {
    for (const name of ["a", "a-b", "Octo-Cat-1", "a".repeat(39)]) {
      const r = run(["github", "--usuario", "nobody", "--github", name], "n\n");
      expect(r.status, `${name}: ${r.stderr}`).toBe(0);
    }
  });

  it("falha de download (usuário inexistente, sem internet): explica e não grava", async () => {
    const r = run(["github", "--usuario", "nobody", "--github", "octocat"], "s\n", { FAKE_CURL_EXIT: "22" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/não consegui baixar/);
    expect(existsSync(authorized())).toBe(false);
  });

  it("conta sem chaves públicas: avisa e não grava", async () => {
    await writeFile(path.join(dir, "keys.txt"), "\n");
    const r = run(["github", "--usuario", "nobody", "--github", "octocat"], "s\n");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/não tem chave pública aceitável/);
    expect(existsSync(authorized())).toBe(false);
  });

  it("linhas que não são chave comum (opções, tipo desconhecido, base64 curto) são ignoradas, com aviso", async () => {
    await writeFile(
      path.join(dir, "keys.txt"),
      [
        `command="rm -rf /" ${KEY_A}`,
        "ssh-dss AAAAB3NzaC1kc3MAAACBAP",
        "ssh-ed25519 curto",
        "texto qualquer",
        `${KEY_RSA} comentario-do-github`,
        "",
      ].join("\r\n"),
    );
    const r = run(["github", "--usuario", "nobody", "--github", "octocat"], "s\n");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/4 linha\(s\) ignorada\(s\)/);
    expect(await readFile(authorized(), "utf8")).toBe(`${KEY_RSA} github-octocat\n`);
  });

  it("RSA abaixo de 3072 bits é recusada (1024 e 2048), com aviso dos bits; ed25519 e RSA 3072 passam", async () => {
    await writeFile(path.join(dir, "keys.txt"), [KEY_RSA_1024, KEY_RSA_2048, KEY_A, KEY_RSA, ""].join("\n"));
    const r = run(["github", "--usuario", "nobody", "--github", "octocat"], "s\n");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/RSA fraca ignorada: 1024 bits/);
    expect(r.stderr).toMatch(/RSA fraca ignorada: 2048 bits/);
    expect(await readFile(authorized(), "utf8")).toBe(`${KEY_A} github-octocat\n${KEY_RSA} github-octocat\n`);
    expect(r.stdout).toMatch(/Gravar estas 2|2 chave\(s\) nova/);
  });

  it("só RSA fraca: nada é gravado e a mensagem diz por quê", async () => {
    await writeFile(path.join(dir, "keys.txt"), [KEY_RSA_1024, KEY_RSA_2048, ""].join("\n"));
    const r = run(["github", "--usuario", "nobody", "--github", "octocat"], "s\n");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/RSA fraca/);
    expect(existsSync(authorized())).toBe(false);
  });

  it("chaves repetidas na resposta são contadas uma vez só, antes de perguntar", async () => {
    await writeFile(path.join(dir, "keys.txt"), [KEY_A, KEY_B, KEY_A, `${KEY_B} outro-comentario`, ""].join("\n"));
    const r = run(["github", "--usuario", "nobody", "--github", "octocat"], "s\n");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/2 chave\(s\) repetida\(s\)/);
    expect(r.stderr).toContain("Gravar estas 2 chave(s)");
    expect((await readFile(authorized(), "utf8")).trimEnd().split("\n")).toHaveLength(2);
  });

  it("chave de segurança física (sk-*) é ignorada com mensagem própria", async () => {
    await writeFile(path.join(dir, "keys.txt"), [KEY_SK, KEY_A, ""].join("\n"));
    const r = run(["github", "--usuario", "nobody", "--github", "octocat"], "s\n");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/1 chave\(s\) de segurança física/);
    expect(r.stderr).not.toMatch(/tipo de chave desconhecido/);
    expect(await readFile(authorized(), "utf8")).toBe(`${KEY_A} github-octocat\n`);
  });

  it("--silencioso não esconde as impressões digitais e a confirmação continua sendo pedida", async () => {
    const r = run(["github", "--usuario", "nobody", "--github", "octocat", "--silencioso"], "n\n");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/SHA256:fp-/);
    expect(r.stderr).toMatch(/Gravar estas 2 chave/);
    expect(existsSync(authorized())).toBe(false);
  });

  it("resposta enorme sem Content-Length é cortada (teto de 200 KB) e vira falha de download", async () => {
    await fake("curl", `#!/usr/bin/env bash\necho "curl $*" >> "$FAKE_LOG"\nyes "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIC9JAFDTUqwvSdNKOQH1xA7JKESeoFlhyGblHHhgofBT"\n`);
    const r = run(["github", "--usuario", "nobody", "--github", "octocat"], "s\n");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/não consegui baixar/);
    expect(existsSync(authorized())).toBe(false);
  });

  it("o diretório temporário nasce 0700 e só fica legível para o grupo (ou todos, sem root) depois de pronto; some no fim", async () => {
    const tmp = path.join(dir, "tmp");
    await mkdir(tmp);
    const r = run(["github", "--usuario", "nobody", "--github", "octocat"], "n\n", { TMPDIR: tmp });
    expect(r.status, r.stderr).toBe(0);
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(tmp)).toEqual([]);
    const sourceText = await readFile(SCRIPT_SOURCE, "utf8");
    expect(sourceText).toMatch(/\(umask 077; mktemp -d\)/);
  });

  it("mais de 20 chaves: recusa tudo", async () => {
    const many = Array.from({ length: 21 }, (_, i) => `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${String(i).padStart(2, "0")}${"B".repeat(40)}`).join("\n");
    await writeFile(path.join(dir, "keys.txt"), `${many}\n`);
    const r = run(["github", "--usuario", "nobody", "--github", "octocat"], "s\n");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/mais de 20 chaves/);
    expect(existsSync(authorized())).toBe(false);
  });

  it("acrescenta sem apagar o que existe, faz backup datado e não repete chave já instalada", async () => {
    await mkdir(path.join(home, ".ssh"), { mode: 0o700 });
    await writeFile(authorized(), "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEXISTENTEEXISTENTEEXISTENTEEXISTENTEXX antiga", { mode: 0o600 }); // sem quebra de linha final
    const first = run(["github", "--usuario", "nobody", "--github", "octocat"], "s\n");
    expect(first.status, first.stderr).toBe(0);
    const lines = (await readFile(authorized(), "utf8")).trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("antiga");
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(path.join(home, ".ssh")).some((f) => f.startsWith("authorized_keys.paas-bak-"))).toBe(true);
    const second = run(["github", "--usuario", "nobody", "--github", "octocat"], "s\n");
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toMatch(/já estavam/);
    expect((await readFile(authorized(), "utf8")).trimEnd().split("\n")).toHaveLength(3);
  });

  it("authorized_keys que é link simbólico: recusa (nada gravado no alvo) e ensina a corrigir arquivo do root", async () => {
    await mkdir(path.join(home, ".ssh"), { mode: 0o700 });
    const alvo = path.join(dir, "alvo-sensivel");
    await writeFile(alvo, "intocado\n");
    await symlink(alvo, authorized());
    const r = run(["github", "--usuario", "nobody", "--github", "octocat"], "s\n");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/link simbólico/);
    expect(r.stderr).toMatch(/sudo chown -R nobody:/);
    expect(await readFile(alvo, "utf8")).toBe("intocado\n");
  });

  it("pasta ~/.ssh gravável por outros: recusa", async () => {
    await mkdir(path.join(home, ".ssh"));
    await chmod(path.join(home, ".ssh"), 0o777);
    const r = run(["github", "--usuario", "nobody", "--github", "octocat"], "s\n");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/gravável por outros/);
    expect(existsSync(authorized())).toBe(false);
  });

  it("~/.ssh que é link simbólico: recusa", async () => {
    const alvo = path.join(dir, "outra-pasta");
    await mkdir(alvo, { mode: 0o700 });
    await symlink(alvo, path.join(home, ".ssh"));
    const r = run(["github", "--usuario", "nobody", "--github", "octocat"], "s\n");
    expect(r.status).not.toBe(0);
    expect(existsSync(path.join(alvo, "authorized_keys"))).toBe(false);
  });

  it("falha ao gravar (código inesperado) e usuário sem pasta pessoal viram erros claros", async () => {
    await fake("runuser", `#!/usr/bin/env bash\nexit 4\n`);
    let r = run(["github", "--usuario", "nobody", "--github", "octocat"], "s\n");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/não consegui gravar as chaves \(código 4\)/);
    await fake("runuser", `#!/usr/bin/env bash\nexit 9\n`);
    r = run(["github", "--usuario", "nobody", "--github", "octocat"], "s\n");
    expect(r.stderr).toMatch(/outra operação de chaves/);
    await fake("runuser", `#!/usr/bin/env bash\necho nada\n`);
    r = run(["github", "--usuario", "nobody", "--github", "octocat"], "s\n");
    expect(r.stderr).toMatch(/resposta inesperada/);
    r = run(["github", "--usuario", "nobody", "--github", "octocat"], "s\n", { FAKE_HOME: path.join(dir, "nao-existe") });
    expect(r.stderr).toMatch(/pasta pessoal/);
  });

  it.each([
    ["curl", "curl não encontrado"],
    ["ssh-keygen", "ssh-keygen não encontrado"],
    ["runuser", "runuser não encontrado"],
  ])("sem %s: explica", async (tool, msg) => {
    const env: Record<string, string> = { [tool === "curl" ? "CURL" : tool === "ssh-keygen" ? "SSH_KEYGEN" : "RUNUSER"]: "nao-existe-xyz" };
    const r = run(["github", "--usuario", "nobody", "--github", "octocat"], "s\n", env);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(msg);
  });

  it("recusa root e nome de usuário inválido; usuário vem do .env e, na falta, de SUDO_USER", async () => {
    const args = ["github", "--github", "octocat"];
    let r = run([...args, "--usuario", "root"], "n\n");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/não pode ser root/);
    r = run([...args, "--usuario", "Bad;User"], "n\n");
    expect(r.status).not.toBe(0);
    r = run(args, "n\n", { SUDO_USER: "root" });
    expect(r.status).not.toBe(0);
    r = run(args, "n\n");
    expect(r.stderr).toMatch(/--usuario/);
    await writeFile(path.join(dir, "x.env"), "PAAS_TERMINAL_USER='nobody'\n");
    r = run(args, "n\n", { ENV_FILE: path.join(dir, "x.env") });
    expect(r.status, r.stderr).toBe(0);
    r = run(args, "n\n", { SUDO_USER: "nobody" });
    expect(r.status, r.stderr).toBe(0);
  });

  it("usuário inexistente é recusado", async () => {
    const r = run(["github", "--usuario", "nao_existe_xyz", "--github", "octocat"], "s\n");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/não existe/);
  });

  it("exige root (sem PAAS_ASSUME_ROOT, como usuário comum)", async () => {
    if (process.getuid?.() === 0) return;
    const r = run(["github", "--usuario", "nobody", "--github", "octocat"], "s\n", { PAAS_ASSUME_ROOT: "0" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/sudo/);
  });

  it("--github sem nome é recusado", async () => {
    const r = run(["github", "--github"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/--github precisa/);
  });
});

describe("scripts/recuperar-acesso.sh — desbloquear fail2ban", () => {
  it("IP válido: desbloqueia nos dois jails", async () => {
    const r = run(["desbanir", "203.0.113.5"]);
    expect(r.status, r.stderr).toBe(0);
    const c = await calls();
    expect(c).toContain("f2b set sshd unbanip 203.0.113.5");
    expect(c).toContain("f2b set recidive unbanip 203.0.113.5");
  });

  it("IP inválido (inclusive com zero à esquerda) é recusado e nada é enviado ao fail2ban", async () => {
    for (const bad of ["300.1.1.1", "010.0.0.1"]) {
      const r = run(["desbanir", bad]);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/IP inválido/);
    }
    expect((await calls()).some((l) => l.startsWith("f2b set"))).toBe(false);
  });

  it("ENTER (ou --qualquer-ip): desbloqueia todos os listados em cada jail", async () => {
    const r = run(["desbanir"], "\n");
    expect(r.status, r.stderr).toBe(0);
    const c = await calls();
    for (const jail of ["sshd", "recidive"]) {
      expect(c).toContain(`f2b set ${jail} unbanip 203.0.113.7`);
      expect(c).toContain(`f2b set ${jail} unbanip 198.51.100.9`);
    }
  });

  it("sem fail2ban-client: explica", async () => {
    const r = run(["desbanir", "203.0.113.5"], "", { FAIL2BAN_CLIENT: "fail2ban-que-nao-existe" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/não está instalado/);
  });
});

describe("scripts/recuperar-acesso.sh — menu e subcomandos", () => {
  it.each([
    ["2", "sibling reativar-acesso-ip.sh"],
    ["4", "sibling reset-senha.sh"],
    ["3\n1", "sibling reset-2fa.sh"],
  ])("opção %j chama o script certo", async (choice, expected) => {
    const r = run([], `${choice}\n`);
    expect(r.status, r.stderr).toBe(0);
    expect(await calls()).toContain(expected);
  });

  it("o menu não oferece SSH por senha e a opção 1 desbloqueia", async () => {
    const r = run([], "1\n203.0.113.5\n");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toMatch(/SSH por senha por 15/);
    expect(r.stderr).toMatch(/não abre SSH por senha/);
    expect(await calls()).toContain("f2b set sshd unbanip 203.0.113.5");
  });

  it("subcomandos ip, senha e 2fa roteiam para os mesmos scripts (2fa: só o bloqueio, opção 3)", async () => {
    expect(run(["ip"]).status).toBe(0);
    expect(run(["senha"]).status).toBe(0);
    expect(run(["2fa"], "1\n").status).toBe(0);
    expect(run(["2fa"], "3\n").status).toBe(0);
    expect(run(["2fa"], "9\n").stdout).toMatch(/opção inválida/);
    const c = await calls();
    expect(c).toContain("sibling reativar-acesso-ip.sh");
    expect(c).toContain("sibling reset-senha.sh");
    expect(c).toContain("sibling reset-2fa.sh");
    expect(c).toContain("sibling reset-2fa.sh --so-bloqueio");
  });

  it("0 / ENTER sai sem alterar; opção inválida falha", async () => {
    expect(run([], "0\n").status).toBe(0);
    expect(run([], "\n").status).toBe(0);
    const r = run([], "9\n");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/opção inválida/);
    expect(existsSync(authorized())).toBe(false);
  });

  it("email: desliga só o código por e-mail (2FA fica), na ordem parar → gravar → subir; palavra errada cancela", async () => {
    const users = path.join(dir, "users.json");
    const tf = { iv: "a", tag: "b", data: "c", lastStep: 1, recoveryHashes: ["x"], enabledAt: "z" };
    await writeFile(users, JSON.stringify({ users: [{ id: "u1", username: "admin", twoFactor: tf, emailCodeEnabledAt: "z" }] }), { mode: 0o600 });
    let r = run(["email"], "nao\n", { FAKE_USERS: users });
    expect(r.status).toBe(0);
    expect(JSON.parse(await readFile(users, "utf8")).users[0].emailCodeEnabledAt).toBe("z");
    expect((await calls()).some((l) => l.startsWith("docker stop"))).toBe(false);

    r = run(["email"], "desligar\n", { FAKE_USERS: users });
    expect(r.status, r.stderr).toBe(0);
    const saved = JSON.parse(await readFile(users, "utf8")).users[0];
    expect(saved).not.toHaveProperty("emailCodeEnabledAt");
    expect(saved.twoFactor).toEqual(tf);
    const c = await calls();
    const order = ["docker stop", "docker run", "docker start"].map((v) => c.findIndex((l) => l.startsWith(v)));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("--help, argumento e subcomando desconhecidos", async () => {
    const h = run(["--help"]);
    expect(h.status).toBe(0);
    expect(h.stdout).toMatch(/recuperar-acesso/);
    expect(h.stdout).toMatch(/GitHub/);
    expect(run(["--abc"]).status).not.toBe(0);
    expect(run(["desbanir", "203.0.113.5", "203.0.113.6"]).status).not.toBe(0);
    expect(run(["ip", "ip"]).status).not.toBe(0);
  });
});
