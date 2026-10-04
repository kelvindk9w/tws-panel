/**
 * Webmail (Roundcube em container) — pedido do dono do produto (04/10/2026):
 * as pessoas leem, respondem e enviam e-mail das caixas pelo navegador, sem
 * configurar Outlook/Gmail. Aqui: a configuração gerada, o leitor das
 * tentativas de senha errada no log e o ciclo de vida do container.
 *
 * Sem Docker: `run` e `copyFilesToContainer` são dublês.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Result = { code: number; stdout: string; stderr: string };
const ok = (stdout = ""): Result => ({ code: 0, stdout, stderr: "" });
const fail = (stderr: string): Result => ({ code: 1, stdout: "", stderr });

const calls: string[][] = [];
let responder: (args: string[]) => Result;

vi.mock("../src/exec.js", () => ({
  run: vi.fn(async (_file: string, args: string[]) => {
    calls.push(args);
    return responder(args);
  }),
}));

const copies: { container: string; dest: string; files: { name: string; content?: string | Buffer; mode?: number }[] }[] = [];
let copyResult: Result = ok();
vi.mock("../src/container-files.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/container-files.js")>();
  return {
    ...real,
    copyFilesToContainer: vi.fn(async (container: string, dest: string, files: never[]) => {
      copies.push({ container, dest, files });
      calls.push(["<cp>", container, dest]);
      return copyResult;
    }),
  };
});

const {
  ROUNDCUBE_IMAGE,
  WebmailManager,
  generateDesKey,
  isPublicIp,
  parseFailedLogins,
  phpString,
  renderRoundcubeConfig,
} = await import("../src/webmail.js");

const BASE = {
  imapHost: "mail.exemplo.com",
  verifyTls: true,
  desKey: "k".repeat(32),
  trustedHosts: ["mail.exemplo.com", "mail.outro.com.br"],
};

beforeEach(() => {
  calls.length = 0;
  copies.length = 0;
  copyResult = ok();
  responder = () => ok();
});

describe("imagem", () => {
  it("versão fixa por tag e digest (nada de latest)", () => {
    expect(ROUNDCUBE_IMAGE).toMatch(/^roundcube\/roundcubemail:1\.7\.4-apache-nonroot@sha256:[0-9a-f]{64}$/);
  });
});

describe("phpString", () => {
  it("aspas simples com \\ e ' escapados", () => {
    expect(phpString("a'b\\c")).toBe("'a\\'b\\\\c'");
    expect(phpString("simples")).toBe("'simples'");
  });
});

describe("generateDesKey", () => {
  it("32 caracteres (AES-256), diferentes a cada chamada, sem aspas nem barra", () => {
    const a = generateDesKey();
    const b = generateDesKey();
    expect(a).toHaveLength(32);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });
});

describe("renderRoundcubeConfig", () => {
  const php = renderRoundcubeConfig(BASE);

  it("fala só com o servidor de e-mail do painel, por TLS implícito (993 e 465)", () => {
    expect(php.startsWith("<?php\n")).toBe(true);
    expect(php).toContain("$config['imap_host'] = 'ssl://mail.exemplo.com:993';");
    expect(php).toContain("$config['smtp_host'] = 'ssl://mail.exemplo.com:465';");
    // mesmo login do IMAP no SMTP
    expect(php).toContain("$config['smtp_user'] = '%u';");
    expect(php).toContain("$config['smtp_pass'] = '%p';");
  });

  it("confere o certificado pelo nome quando ele já foi instalado", () => {
    expect(php).toContain("'verify_peer' => true");
    expect(php).toContain("'verify_peer_name' => true");
    expect(php).toContain("'peer_name' => 'mail.exemplo.com'");
    expect(php).not.toContain("allow_self_signed");
  });

  it("sem certificado ainda: cifra a conexão interna sem conferir o nome", () => {
    const self = renderRoundcubeConfig({ ...BASE, verifyTls: false });
    expect(self).toContain("'verify_peer' => false");
    expect(self).toContain("'verify_peer_name' => false");
    expect(self).toContain("'allow_self_signed' => true");
  });

  it("sem instalador, sem cadastro, plugins mínimos, português", () => {
    expect(php).toContain("$config['enable_installer'] = false;");
    expect(php).toContain("$config['plugins'] = ['archive', 'zipdownload'];");
    expect(php).toContain("$config['language'] = 'pt_BR';");
    expect(php).toContain("$config['enable_spellcheck'] = false;");
    // uma identidade, sem trocar o endereço: ninguém envia "como" outra caixa
    expect(php).toContain("$config['identities_level'] = 3;");
    expect(php).toContain("$config['login_username_filter'] = 'email';");
    // não diz a versão na tela de login
    expect(php).toContain("$config['display_product_info'] = 0;");
  });

  it("sessão curta, cookie seguro e limites de tentativa", () => {
    expect(php).toContain("$config['session_lifetime'] = 10;");
    expect(php).toContain("$config['session_samesite'] = 'Strict';");
    expect(php).toContain("$config['use_https'] = true;");
    expect(php).toContain("$config['x_frame_options'] = 'deny';");
    expect(php).toContain("$config['login_rate_limit'] = 3;");
  });

  it("aceita só os nomes do webmail no Host e confia no IP do proxy interno", () => {
    expect(php).toContain("$config['trusted_host_patterns'] = ['mail.exemplo.com', 'mail.outro.com.br'];");
    expect(php).toContain("$config['proxy_whitelist'] = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'];");
  });

  it("chave de cifra AES-256 da sessão", () => {
    expect(php).toContain(`$config['des_key'] = '${"k".repeat(32)}';`);
    expect(php).toContain("$config['cipher_method'] = 'AES-256-CBC';");
  });

  it("recusa nome de host fora do formato (vira texto de configuração)", () => {
    expect(() => renderRoundcubeConfig({ ...BASE, imapHost: "mail.x'; system('id');" })).toThrow(/inválido/);
    expect(() => renderRoundcubeConfig({ ...BASE, trustedHosts: ["ok.com", "a b"] })).toThrow(/inválido/);
  });

  it("recusa chave curta", () => {
    expect(() => renderRoundcubeConfig({ ...BASE, desKey: "curta" })).toThrow(/chave/);
  });
});

describe("parseFailedLogins", () => {
  const line = (user: string, from: string) =>
    `[03-Oct-2026 23:10:00 +0000]: <abcd1234> Failed login for ${user} from ${from} in session abcd1234abcd1234 (error: 0)`;

  it("usa o IP real do visitante (X-Forwarded-For do proxy)", () => {
    const log = [
      line("contato@exemplo.com", "172.18.0.5 (X-Forwarded-For: 203.0.113.7)"),
      "[03-Oct-2026 23:10:01 +0000]: <x> Successful login for contato@exemplo.com (ID: 1) from 172.18.0.5",
      line("x@exemplo.com", "172.18.0.5 (X-Real-IP: 198.51.100.2,X-Forwarded-For: 198.51.100.9, 203.0.113.8)"),
    ].join("\n");
    expect(parseFailedLogins(log)).toEqual([
      { ip: "203.0.113.7", user: "contato@exemplo.com" },
      { ip: "203.0.113.8", user: "x@exemplo.com" },
    ]);
  });

  it("sem cabeçalho do proxy, o endereço da conexão; IPv6 também", () => {
    const log = [line("a@b.com", "198.51.100.4"), line("a@b.com", "2001:db8::1")].join("\n");
    expect(parseFailedLogins(log).map((f) => f.ip)).toEqual(["198.51.100.4", "2001:db8::1"]);
  });

  it("ignora linhas sem IP válido e o resto do log", () => {
    const log = [line("a@b.com", "nao-e-ip"), "qualquer coisa", "", line("a@b.com", "172.18.0.5 (X-Forwarded-For: lixo)")].join("\n");
    expect(parseFailedLogins(log)).toEqual([]);
  });
});

describe("isPublicIp", () => {
  it("IP da internet: sim; rede interna, loopback, link-local e CGNAT: não", () => {
    for (const ip of ["203.0.113.7", "8.8.8.8", "2001:db8::1", "2804:14c::1"]) expect(isPublicIp(ip)).toBe(true);
    for (const ip of ["10.1.2.3", "172.18.0.1", "192.168.0.10", "127.0.0.1", "169.254.1.1", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"])
      expect(isPublicIp(ip)).toBe(false);
    expect(isPublicIp("nao-e-ip")).toBe(false);
  });
});

describe("WebmailManager", () => {
  const manager = (extra: Record<string, string> = {}) => new WebmailManager({ config: "<?php // cfg", ...extra });

  function daemon(state: { running: boolean } | null, extra: (a: string[]) => Result | undefined = () => undefined) {
    return (args: string[]): Result => {
      const r = extra(args);
      if (r) return r;
      if (args[0] === "network") return ok();
      if (args[0] === "inspect") return state ? ok(`${state.running}\n`) : fail("No such object");
      return ok();
    };
  }

  it("cria sem porta publicada, na paas-net, com volume, limites e a config antes do start", async () => {
    responder = daemon(null);
    await manager().start();
    expect(calls.map((c) => c[0])).toEqual(["network", "inspect", "create", "<cp>", "start"]);
    const create = calls.find((c) => c[0] === "create")!;
    expect(create).not.toContain("-p");
    expect(create.join(" ")).toContain("--network paas-net");
    expect(create.join(" ")).toContain("-v paas_webmail_data:/var/roundcube");
    expect(create).toEqual(expect.arrayContaining(["--cap-drop", "ALL", "--security-opt", "no-new-privileges"]));
    expect(create.join(" ")).toContain("--memory 256m");
    expect(create.join(" ")).toContain("--label paas.role=webmail");
    expect(create.at(-1)).toBe(ROUNDCUBE_IMAGE);
    expect(copies[0]).toEqual({
      container: "paas-webmail",
      dest: "/var/roundcube/config",
      files: [{ name: "paas.php", content: "<?php // cfg", mode: 0o644 }],
    });
  });

  it("cria a rede ausente; falha ao criá-la é erro claro", async () => {
    responder = daemon(null, (a) => (a[0] === "network" && a[1] === "inspect" ? fail("no") : undefined));
    await manager().start();
    expect(calls[1]).toEqual(["network", "create", "--label", "paas.managed=true", "paas-net"]);
    responder = daemon(null, (a) => (a[0] === "network" ? fail("negado") : undefined));
    await expect(manager().start()).rejects.toThrow(/falha ao criar a rede paas-net: negado/);
  });

  it("existente e parado: regrava a config e inicia; rodando: só regrava", async () => {
    responder = daemon({ running: false });
    await manager().start();
    expect(calls.map((c) => c[0])).toEqual(["network", "inspect", "<cp>", "start"]);
    calls.length = 0;
    responder = daemon({ running: true });
    await manager().start();
    expect(calls.map((c) => c[0])).toEqual(["network", "inspect", "<cp>"]);
  });

  it("não inicia o existente: remove e recria", async () => {
    let starts = 0;
    responder = daemon({ running: false }, (a) => (a[0] === "start" && starts++ === 0 ? fail("quebrado") : undefined));
    await manager().start();
    expect(calls.map((c) => c[0])).toEqual(["network", "inspect", "<cp>", "start", "rm", "create", "<cp>", "start"]);
    expect(calls.find((c) => c[0] === "rm")).toEqual(["rm", "-f", "paas-webmail"]);
  });

  it("propaga falhas de create, cp e start", async () => {
    responder = daemon(null, (a) => (a[0] === "create" ? fail("conflito") : undefined));
    await expect(manager().start()).rejects.toThrow(/falha ao criar paas-webmail: conflito/);
    responder = daemon(null);
    copyResult = fail("sem espaço\n");
    await expect(manager().start()).rejects.toThrow(/falha ao gravar a configuração em paas-webmail: sem espaço$/);
    copyResult = ok();
    responder = daemon(null, (a) => (a[0] === "start" ? fail("erro") : undefined));
    await expect(manager().start()).rejects.toThrow(/falha ao iniciar paas-webmail: erro/);
  });

  it("aceita nome, rede, volume e imagem configuráveis", async () => {
    responder = daemon(null);
    await manager({ containerName: "x-web", network: "x-net", dataVolume: "x_vol", image: "img:1" }).start();
    const create = calls.find((c) => c[0] === "create")!;
    expect(create).toEqual(expect.arrayContaining(["x-web", "x-net", "x_vol:/var/roundcube", "img:1"]));
  });

  it("pushConfig com o container rodando (a config vale na próxima requisição)", async () => {
    await manager().pushConfig();
    expect(copies).toHaveLength(1);
  });

  it("status: instalado/rodando", async () => {
    responder = daemon({ running: true });
    await expect(manager().status()).resolves.toEqual({ installed: true, running: true });
    responder = daemon({ running: false });
    await expect(manager().status()).resolves.toEqual({ installed: true, running: false });
    responder = daemon(null);
    await expect(manager().status()).resolves.toEqual({ installed: false, running: false });
  });

  it("stop e remove: ausência não é erro; outra falha é", async () => {
    responder = () => fail("Error: No such container: paas-webmail");
    await manager().stop();
    await manager().remove();
    responder = () => fail("daemon fora");
    await expect(manager().stop()).rejects.toThrow(/falha ao parar paas-webmail: daemon fora/);
    await expect(manager().remove()).rejects.toThrow(/falha ao remover paas-webmail: daemon fora/);
    responder = () => ok();
    await manager().remove();
    expect(calls.at(-1)).toEqual(["rm", "-f", "paas-webmail"]);
  });

  it("internalIp: o IP na paas-net (para a isenção no Stalwart)", async () => {
    responder = () => ok(JSON.stringify({ "paas-net": { IPAddress: "172.18.0.9" }, bridge: { IPAddress: "172.17.0.2" } }));
    await expect(manager().internalIp()).resolves.toBe("172.18.0.9");
    responder = () => ok(JSON.stringify({ bridge: { IPAddress: "172.17.0.2" } }));
    await expect(manager().internalIp()).resolves.toBeNull();
    responder = () => ok(JSON.stringify({ "paas-net": { IPAddress: "" } }));
    await expect(manager().internalIp()).resolves.toBeNull();
    responder = () => ok("não é json");
    await expect(manager().internalIp()).resolves.toBeNull();
    responder = () => fail("no such");
    await expect(manager().internalIp()).resolves.toBeNull();
  });

  it("logsSince: junta stdout e stderr a partir do horário; sem container, vazio", async () => {
    responder = () => ({ code: 0, stdout: "a\n", stderr: "b\n" });
    await expect(manager().logsSince(1_700_000_000)).resolves.toBe("a\n\nb\n");
    expect(calls.at(-1)).toEqual(["logs", "--since", "1700000000", "paas-webmail"]);
    responder = () => fail("no such");
    await expect(manager().logsSince(1)).resolves.toBe("");
  });
});
