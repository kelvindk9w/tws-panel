/**
 * recuperar-acesso-sh.test.ts — scripts/recuperar-acesso.sh com sshd, systemctl,
 * fail2ban-client, ufw e docker FALSOS num diretório temporário (ETC_DIR também
 * temporário): nada toca a máquina real. Confere o drop-in da janela de SSH por
 * senha (com e sem IP), a recusa de IP inválido, o desfazer quando o sshd
 * recusa, o fechamento idempotente, o desbloqueio do fail2ban, o roteamento do
 * menu para os outros scripts, a recusa de root e o --help.
 */
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SH = path.resolve(__dirname, "../../../scripts/recuperar-acesso.sh");
const MJS = path.resolve(__dirname, "../../../scripts/reset-2fa.mjs");

let dir: string;
let etc: string;
let bin: string;
let scripts: string;
let log: string;

const FAKE_SSHD = `#!/usr/bin/env bash
echo "sshd $*" >> "$FAKE_LOG"
case "$1" in
  -t) exit "\${FAKE_SSHD_T_EXIT:-0}" ;;
  -T) echo "port 22"; echo "passwordauthentication \${FAKE_SSHD_PW:-yes}" ;;
esac
`;
const FAKE_SYSTEMCTL = `#!/usr/bin/env bash
echo "systemctl $*" >> "$FAKE_LOG"
if [ "$1" = "reload" ] || [ "$1" = "restart" ]; then exit "\${FAKE_RELOAD_EXIT:-0}"; fi
if [ "$1" = "daemon-reload" ]; then exit "\${FAKE_DAEMON_RELOAD_EXIT:-0}"; fi
if [ "$1" = "enable" ]; then exit "\${FAKE_ENABLE_EXIT:-0}"; fi
if [ "$1" = "is-active" ] || [ "$1" = "is-enabled" ]; then exit "\${FAKE_ACTIVE_EXIT:-0}"; fi
exit 0
`;
const FAKE_F2B = `#!/usr/bin/env bash
echo "f2b $*" >> "$FAKE_LOG"
if [ "$1" = "status" ]; then
  echo "Status for the jail: $2"
  echo "   |- Currently banned: 2"
  echo '   \`- Banned IP list:   203.0.113.7 198.51.100.9'
fi
exit 0
`;
const FAKE_UFW = `#!/usr/bin/env bash
echo "Status: active"
echo "80/tcp ALLOW Anywhere"
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

async function fake(name: string, body: string) {
  const p = path.join(bin, name);
  await writeFile(p, body);
  await chmod(p, 0o755);
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-recuperar-"));
  etc = path.join(dir, "etc");
  bin = path.join(dir, "bin");
  scripts = path.join(dir, "scripts");
  log = path.join(dir, "calls.log");
  await mkdir(path.join(dir, "run-systemd"), { recursive: true });
  await mkdir(bin);
  await mkdir(scripts);
  await writeFile(log, "");
  await fake("sshd", FAKE_SSHD);
  await fake("systemctl", FAKE_SYSTEMCTL);
  await fake("fail2ban-client", FAKE_F2B);
  await fake("ufw", FAKE_UFW);
  await fake("docker", FAKE_DOCKER);
  for (const s of ["reativar-acesso-ip.sh", "reset-2fa.sh", "reset-senha.sh"]) {
    await writeFile(path.join(scripts, s), `#!/usr/bin/env bash\necho "sibling ${s} $*" >> "$FAKE_LOG"\n`);
  }
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function run(args: string[], input = "", env: Record<string, string> = {}) {
  return spawnSync("bash", [SH, ...args], {
    input,
    encoding: "utf8",
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      ETC_DIR: etc,
      ENV_FILE: path.join(dir, "nao-existe.env"),
      SSHD: "sshd",
      SYSTEMCTL: "systemctl",
      FAIL2BAN_CLIENT: "fail2ban-client",
      UFW: "ufw",
      DOCKER: "docker",
      SYSTEMD_RUN_DIR: path.join(dir, "run-systemd"),
      PAAS_SCRIPTS_DIR: scripts,
      PAAS_ASSUME_ROOT: "1",
      FAKE_LOG: log,
      FAKE_MJS: MJS,
      ...env,
    },
  });
}

const calls = async () => (await readFile(log, "utf8")).trim().split("\n").map((l) => l.trim()).filter(Boolean);
const conf = () => path.join(etc, "ssh/sshd_config.d/00-paas-recuperacao.conf");
const expiry = () => path.join(etc, "paas/recuperacao.expira");
const unit = (n: string) => path.join(etc, "systemd/system", `paas-recuperacao-fechar.${n}`);

describe("scripts/recuperar-acesso.sh — janela de SSH por senha", () => {
  it("sem IP: drop-in só para o usuário, prazo gravado, serviço+timer instalados e habilitados, instruções impressas", async () => {
    const r = run(["janela", "--usuario", "nobody"], "\n");
    expect(r.status, r.stderr).toBe(0);
    const text = await readFile(conf(), "utf8");
    expect(text).toMatch(/^Match User nobody$/m);
    expect(text).not.toMatch(/Address/);
    expect(text).toMatch(/^ {4}PasswordAuthentication yes$/m);
    const left = Number(await readFile(expiry(), "utf8")) - Math.floor(Date.now() / 1000);
    expect(left).toBeGreaterThan(14 * 60);
    expect(left).toBeLessThanOrEqual(15 * 60);
    const timer = await readFile(unit("timer"), "utf8");
    expect(timer).toContain("OnActiveSec=15min");
    expect(timer).toContain("OnBootSec=1min");
    const service = await readFile(unit("service"), "utf8");
    expect(service).toContain("Before=ssh.service sshd.service");
    expect(service).toContain("fechar --silencioso");
    const c = await calls();
    expect(c).toContain("systemctl enable --now paas-recuperacao-fechar.timer");
    expect(c).toContain("systemctl enable paas-recuperacao-fechar.service");
    expect(c).toContain("sshd -t");
    expect(c.some((l) => l.startsWith("systemctl reload"))).toBe(true);
    expect(r.stdout).toContain("ssh-copy-id");
    expect(r.stdout).toContain("PowerShell");
    expect(r.stdout).toMatch(/15 minutos/);
  });

  it("com IP: o Match inclui Address; rodar duas vezes não duplica nada", async () => {
    expect(run(["janela", "--usuario", "nobody", "--ip", "203.0.113.10"]).status).toBe(0);
    expect(run(["janela", "--usuario", "nobody", "--ip", "203.0.113.10"]).status).toBe(0);
    const text = await readFile(conf(), "utf8");
    expect(text.match(/^Match /gm)).toHaveLength(1);
    expect(text).toMatch(/^Match User nobody Address 203\.0\.113\.10$/m);
    expect(text.match(/PasswordAuthentication/g)).toHaveLength(1);
  });

  it("pergunta o IP quando não foi dado e aceita o digitado", async () => {
    const r = run(["janela", "--usuario", "nobody"], "2001:db8::1\n");
    expect(r.status, r.stderr).toBe(0);
    expect(await readFile(conf(), "utf8")).toMatch(/Address 2001:db8::1$/m);
  });

  it.each(["999.1.1.1", "1.2.3", "abc", "203.0.113.1; rm -rf /", "1.2.3.4/24"])("IP inválido '%s' é recusado sem criar nada", async (ip) => {
    const r = run(["janela", "--usuario", "nobody", "--ip", ip]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/IP inválido/);
    expect(existsSync(conf())).toBe(false);
    expect(existsSync(unit("timer"))).toBe(false);
  });

  it("sshd -t recusando: desfaz tudo (sem drop-in, prazo ou unidades) e sai com erro", async () => {
    const r = run(["janela", "--usuario", "nobody", "--qualquer-ip"], "", { FAKE_SSHD_T_EXIT: "1" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/recusou a configuração/);
    expect(existsSync(conf())).toBe(false);
    expect(existsSync(expiry())).toBe(false);
    expect(existsSync(unit("timer"))).toBe(false);
    expect(existsSync(unit("service"))).toBe(false);
  });

  it("sshd continuando a recusar senha (outro arquivo vence): desfaz", async () => {
    const r = run(["janela", "--usuario", "nobody", "--qualquer-ip"], "", { FAKE_SSHD_PW: "no" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/continua recusando senha/);
    expect(existsSync(conf())).toBe(false);
  });

  it("falha ao recarregar o sshd: desfaz", async () => {
    const r = run(["janela", "--usuario", "nobody", "--qualquer-ip"], "", { FAKE_RELOAD_EXIT: "1" });
    expect(r.status).not.toBe(0);
    expect(existsSync(conf())).toBe(false);
  });

  it("sem systemd e sem at: não abre nada", async () => {
    const r = run(["janela", "--usuario", "nobody", "--qualquer-ip"], "", {
      SYSTEMD_RUN_DIR: path.join(dir, "nao-existe"),
      AT: "at-que-nao-existe",
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/NADA foi aberto/);
    expect(existsSync(conf())).toBe(false);
  });

  // Regressão da revisão (B1): o agendamento rodava num `if !`, onde o set -e não vale, e a janela abria
  // mesmo sem fechamento agendado. Cada falha do agendamento tem de impedir a abertura e desfazer tudo.
  for (const [nome, env] of [
    ["systemctl daemon-reload falha", { FAKE_DAEMON_RELOAD_EXIT: "1" }],
    ["systemctl enable falha", { FAKE_ENABLE_EXIT: "1" }],
    ["o timer não fica ativo", { FAKE_ACTIVE_EXIT: "3" }],
  ] as const) {
    it(`${nome}: a janela NÃO abre e nada fica instalado`, async () => {
      const r = run(["janela", "--usuario", "nobody", "--qualquer-ip"], "", env);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/NADA foi aberto/);
      expect(r.stdout).not.toMatch(/fecha SOZINHA/);
      expect(existsSync(conf())).toBe(false);
      expect(existsSync(expiry())).toBe(false);
      expect(existsSync(unit("timer"))).toBe(false);
      expect(existsSync(unit("service"))).toBe(false);
    });
  }

  it("sem systemd, o at falha (atd parado): a janela NÃO abre", async () => {
    await fake("at", `#!/usr/bin/env bash\necho "at $*" >> "$FAKE_LOG"\ncat >/dev/null\nexit 1\n`);
    await fake("atq", `#!/usr/bin/env bash\nexit 0\n`);
    const r = run(["janela", "--usuario", "nobody", "--qualquer-ip"], "", { SYSTEMD_RUN_DIR: path.join(dir, "nao-existe") });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/NADA foi aberto/);
    expect(existsSync(conf())).toBe(false);
  });

  it("sem systemd, o at aceita mas a fila fica vazia: a janela NÃO abre", async () => {
    await fake("at", `#!/usr/bin/env bash\ncat >/dev/null\nexit 0\n`);
    await fake("atq", `#!/usr/bin/env bash\nexit 0\n`);
    const r = run(["janela", "--usuario", "nobody", "--qualquer-ip"], "", { SYSTEMD_RUN_DIR: path.join(dir, "nao-existe") });
    expect(r.status).not.toBe(0);
    expect(existsSync(conf())).toBe(false);
  });

  it("IP com zero à esquerda é recusado (pode ser lido como octal)", async () => {
    const r = run(["janela", "--usuario", "nobody", "--ip", "010.0.0.1"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/IP inválido/);
    expect(existsSync(conf())).toBe(false);
  });

  it("janela já aberta: é renovada (fecha e agenda de novo) com o prazo certo", async () => {
    expect(run(["janela", "--usuario", "nobody", "--qualquer-ip"]).status).toBe(0);
    const r = run(["janela", "--usuario", "nobody", "--qualquer-ip"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/renovada/);
    expect(existsSync(conf())).toBe(true);
    expect(existsSync(unit("timer"))).toBe(true);
  });

  it("usuário com senha travada (passwd -S = L): oferece definir a senha e, sem aceitar, não abre", async () => {
    await fake("passwd", `#!/usr/bin/env bash\nif [ "$1" = "-S" ]; then echo "nobody L 2026-01-01 0 99999 7 -1"; exit 0; fi\necho "passwd $*" >> "$FAKE_LOG"\n`);
    const r = run(["janela", "--usuario", "nobody", "--qualquer-ip"], "n\n", { PASSWD_BIN: "passwd" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/SEM senha utilizável/);
    expect(existsSync(conf())).toBe(false);
    const ok = run(["janela", "--usuario", "nobody", "--qualquer-ip"], "s\n", { PASSWD_BIN: "passwd" });
    expect(ok.status, ok.stderr).toBe(0);
    expect((await calls()).join("\n")).toContain("passwd nobody");
  });

  it("fechar: se o sshd não recarrega nem reinicia, avisa em voz alta e sai com erro", async () => {
    expect(run(["janela", "--usuario", "nobody", "--qualquer-ip"]).status).toBe(0);
    const r = run(["fechar"], "", { FAKE_RELOAD_EXIT: "1" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/NÃO consegui recarregar o sshd/);
    expect(existsSync(conf())).toBe(false);
  });

  it("sem systemd, com at: agenda o fechamento pelo at", async () => {
    await fake("at", `#!/usr/bin/env bash\necho "at $*" >> "$FAKE_LOG"\ncat >> "$FAKE_LOG"\n`);
    await fake("atq", `#!/usr/bin/env bash\necho "1 Tue Oct 27 12:15:00 2026 a root"\n`);
    const r = run(["janela", "--usuario", "nobody", "--qualquer-ip"], "", {
      SYSTEMD_RUN_DIR: path.join(dir, "nao-existe"),
    });
    expect(r.status, r.stderr).toBe(0);
    const c = (await calls()).join("\n");
    expect(c).toContain("at now + 15 minutes");
    expect(c).toContain("fechar --silencioso");
    expect(existsSync(conf())).toBe(true);
  });

  it("recusa root e nome inválido; usuário vem do .env e, na falta, de SUDO_USER", async () => {
    let r = run(["janela", "--usuario", "root", "--qualquer-ip"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/não pode ser root/);
    r = run(["janela", "--usuario", "Bad;User", "--qualquer-ip"]);
    expect(r.status).not.toBe(0);
    r = run(["janela", "--qualquer-ip"], "", { SUDO_USER: "root" });
    expect(r.status).not.toBe(0);
    r = run(["janela", "--qualquer-ip"]);
    expect(r.stderr).toMatch(/--usuario/);
    expect(existsSync(conf())).toBe(false);

    await writeFile(path.join(dir, "x.env"), "PAAS_TERMINAL_USER='nobody'\n");
    r = run(["janela", "--qualquer-ip"], "", { ENV_FILE: path.join(dir, "x.env") });
    expect(r.status, r.stderr).toBe(0);
    expect(await readFile(conf(), "utf8")).toMatch(/Match User nobody/);
    run(["fechar"]);
    r = run(["janela", "--qualquer-ip"], "", { SUDO_USER: "nobody" });
    expect(r.status, r.stderr).toBe(0);
  });

  it("usuário inexistente é recusado", async () => {
    const r = run(["janela", "--usuario", "nao_existe_xyz", "--qualquer-ip"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/não existe/);
  });

  it("avisa (sem mexer no firewall) quando o ufw está ativo e o SSH não está liberado", async () => {
    const r = run(["janela", "--usuario", "nobody", "--qualquer-ip"]);
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/ufw/);
    expect((await calls()).some((l) => /ufw|allow/i.test(l))).toBe(false);
  });

  it("exige root (sem PAAS_ASSUME_ROOT, como usuário comum)", async () => {
    if (process.getuid?.() === 0) return;
    const r = run(["janela", "--usuario", "nobody", "--qualquer-ip"], "", { PAAS_ASSUME_ROOT: "0" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/sudo/);
  });
});

describe("scripts/recuperar-acesso.sh — fechar", () => {
  it("remove drop-in, prazo e unidades, desabilita o timer e recarrega o sshd; segunda vez não faz nada e sai 0", async () => {
    expect(run(["janela", "--usuario", "nobody", "--qualquer-ip"]).status).toBe(0);
    await writeFile(log, "");
    let r = run(["fechar"]);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(conf())).toBe(false);
    expect(existsSync(expiry())).toBe(false);
    expect(existsSync(unit("timer"))).toBe(false);
    expect(existsSync(unit("service"))).toBe(false);
    let c = await calls();
    expect(c).toContain("systemctl disable --now paas-recuperacao-fechar.timer");
    expect(c.some((l) => l.startsWith("systemctl reload"))).toBe(true);

    await writeFile(log, "");
    r = run(["fechar"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/nada a fechar/);
    c = await calls();
    expect(c.some((l) => l.startsWith("systemctl reload"))).toBe(false);
  });

  it("--silencioso não imprime nada", async () => {
    run(["janela", "--usuario", "nobody", "--qualquer-ip"]);
    const r = run(["fechar", "--silencioso"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
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

  it("IP inválido é recusado e nada é enviado ao fail2ban", async () => {
    const r = run(["desbanir", "300.1.1.1"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/IP inválido/);
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
    ["3", "sibling reativar-acesso-ip.sh"],
    ["5", "sibling reset-senha.sh"],
    ["4\n1", "sibling reset-2fa.sh"],
  ])("opção %j chama o script certo", async (choice, expected) => {
    const r = run([], `${choice}\n`);
    expect(r.status, r.stderr).toBe(0);
    expect(await calls()).toContain(expected);
  });

  it("opção 1 abre a janela (pergunta o IP) e 2 desbloqueia", async () => {
    let r = run(["--usuario", "nobody"], "1\n203.0.113.20\n");
    expect(r.status, r.stderr).toBe(0);
    expect(await readFile(conf(), "utf8")).toMatch(/Address 203\.0\.113\.20/);
    r = run([], "2\n203.0.113.5\n");
    expect(r.status, r.stderr).toBe(0);
    expect(await calls()).toContain("f2b set sshd unbanip 203.0.113.5");
  });

  it("subcomandos ip, senha e 2fa roteiam para os mesmos scripts", async () => {
    expect(run(["ip"]).status).toBe(0);
    expect(run(["senha"]).status).toBe(0);
    expect(run(["2fa"], "1\n").status).toBe(0);
    const c = await calls();
    expect(c).toContain("sibling reativar-acesso-ip.sh");
    expect(c).toContain("sibling reset-senha.sh");
    expect(c).toContain("sibling reset-2fa.sh");
  });

  it("0 / ENTER sai sem alterar; opção inválida falha", async () => {
    expect(run([], "0\n").status).toBe(0);
    expect(run([], "\n").status).toBe(0);
    const r = run([], "9\n");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/opção inválida/);
    expect(existsSync(conf())).toBe(false);
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
    expect(run(["--abc"]).status).not.toBe(0);
    expect(run(["janela", "ip"]).status).not.toBe(0);
  });
});
