/**
 * Pré-flight do install.sh numa reinstalação/atualização, e outros pontos achados ao instalar numa VPS limpa:
 *  1. Os containers do PRÓPRIO painel (tws-panel, paas-caddy, paas-stalwart, paas-webmail, caixa de teste) e os dos
 *     projetos dele não contam como "VPS suja", nem as portas que eles publicam. O trecho de verdade do pré-flight
 *     roda aqui (do "Docker já instalado?" até o veredito), com um docker falso em node que entende os --filter e o
 *     --format que o script usa. Um container de terceiro (inclusive um chamado paas-algo) continua pedindo
 *     "continuar", e numa VPS SEM o painel nenhum container paas-* passa, mesmo com as labels certas.
 *  2. Reexecução via sudo: toda variável que o script lê do ambiente sobrevive (PAAS_ACCESS se perdia).
 *  3. Textos: modo "senha" sem o "SEMPRE pelo túnel" (o padrão é HTTPS), cabeçalho com o clone --branch main e a
 *     pergunta da porta só no modo túnel.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeDirSync } from "./helpers/tmp.js";

const raiz = path.resolve(__dirname, "../../..");
const sh = readFileSync(path.join(raiz, "scripts/install.sh"), "utf8");
const pegar = (nome: string) => {
  const corpo = sh.match(new RegExp(`^${nome}\\(\\) \\{[\\s\\S]*?^\\}`, "m"))?.[0] ?? "";
  expect(corpo, `${nome} não encontrada no install.sh`).not.toBe("");
  return corpo;
};
const linha = (prefixo: string) => {
  const l = sh.split("\n").find((x) => x.startsWith(prefixo)) ?? "";
  expect(l, `linha ${prefixo} não encontrada`).not.toBe("");
  return l;
};
/** Trecho de cima a baixo do script (do início de `de` até antes de `ate`). */
const trecho = (de: string, ate: string) => {
  const i = sh.indexOf(de);
  const j = sh.indexOf(ate, i);
  expect(i, `início "${de}" não encontrado`).toBeGreaterThan(0);
  expect(j, `fim "${ate}" não encontrado`).toBeGreaterThan(i);
  return sh.slice(i, j);
};

const pastas: string[] = [];
afterEach(() => {
  for (const p of pastas.splice(0)) removeDirSync(p);
});
function ambiente() {
  const dir = mkdtempSync(path.join(tmpdir(), "preflight-reinstalacao-"));
  pastas.push(dir);
  return dir;
}
function executavel(dir: string, nome: string, conteudo: string) {
  const arquivo = path.join(dir, nome);
  writeFileSync(arquivo, conteudo);
  chmodSync(arquivo, 0o755);
}
const envDe = (dir: string, extra: Record<string, string> = {}) => ({
  PATH: `${dir}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
  DOCKER_HOST: "unix:///nonexistent.sock",
  ...extra,
});

interface Container {
  name: string;
  labels?: Record<string, string>;
  ports?: string;
  /** parado: só aparece no `docker ps -a` */
  stopped?: boolean;
}

/**
 * docker falso: `docker ps` com -a, -q, --filter name=<regex> e label=<k>=<v>, e --format com {{.Names}},
 * {{.Label "k"}}, {{.Ports}} e {{.ID}} — o mesmo que o docker de verdade faz com esses argumentos.
 */
const DOCKER_FALSO = `#!/usr/bin/env node
const fs = require("node:fs");
const estado = JSON.parse(fs.readFileSync(process.env.FAKE_DOCKER_STATE, "utf8"));
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("Docker version 27.0.0, build falso"); process.exit(0); }
if (args[0] !== "ps") process.exit(1);
let todos = false, quieto = false, formato = "{{.ID}}";
const filtros = [];
for (let i = 1; i < args.length; i++) {
  const a = args[i];
  if (a === "-a" || a === "--all") todos = true;
  else if (a === "-q" || a === "--quiet") quieto = true;
  else if (a === "-aq" || a === "-qa") { todos = true; quieto = true; }
  else if (a === "--filter") filtros.push(args[++i]);
  else if (a === "--format") formato = args[++i];
  else process.exit(2);
}
const passa = (c) => filtros.every((f) => {
  const [chave, ...resto] = f.split("=");
  const valor = resto.join("=");
  if (chave === "name") return new RegExp(valor).test("/" + c.name);
  if (chave === "label") {
    const [k, ...v] = valor.split("=");
    const labels = c.labels || {};
    return v.length ? labels[k] === v.join("=") : k in labels;
  }
  process.exit(3);
});
const saida = [];
estado.forEach((c, i) => {
  if (!todos && c.stopped) return;
  if (!passa(c)) return;
  const id = "id" + i;
  if (quieto) { saida.push(id); return; }
  saida.push(formato
    .replace(/\\{\\{\\.Names\\}\\}/g, c.name)
    .replace(/\\{\\{\\.ID\\}\\}/g, id)
    .replace(/\\{\\{\\.Ports\\}\\}/g, c.ports || "")
    .replace(/\\{\\{\\.Label "([^"]+)"\\}\\}/g, (_, k) => (c.labels || {})[k] ?? ""));
});
if (saida.length) console.log(saida.join("\\n"));
`;

const compose = (project: string, service: string) => ({ "com.docker.compose.project": project, "com.docker.compose.service": service });
const PAINEL: Container = { name: "tws-panel", labels: compose("tws-panel", "panel"), ports: "127.0.0.1:9000->9000/tcp" };
const CADDY: Container = { name: "paas-caddy", labels: { "paas.managed": "true", "paas.role": "caddy" }, ports: "0.0.0.0:80->80/tcp, [::]:80->80/tcp, 0.0.0.0:443->443/tcp, [::]:443->443/tcp" };
const STALWART: Container = {
  name: "paas-stalwart",
  labels: { "paas.managed": "true", "paas.role": "stalwart" },
  ports: "0.0.0.0:25->25/tcp, 0.0.0.0:465->465/tcp, 0.0.0.0:587->587/tcp, 0.0.0.0:143->143/tcp, 0.0.0.0:993->993/tcp, 127.0.0.1:8080->8080/tcp",
};
const WEBMAIL: Container = { name: "paas-webmail", labels: { "paas.managed": "true", "paas.role": "webmail" } };
const MAILTEST: Container = { name: "paas-mailtest-loja", labels: { "paas.managed": "true", "paas.role": "mailtest", "paas.mailtest": "loja" } };
// projeto pelo compose (o container leva o nome que o compose dá) e projeto por `docker run` (label do compose vazia)
const PROJETO_COMPOSE: Container = { name: "paas-loja-web-1", labels: compose("paas-loja", "web") };
const PROJETO_RUN: Container = { name: "blog", labels: { "com.docker.compose.project": "", "paas.managed": "true", "paas.project": "blog" } };
const RESTAURACAO: Container = { name: "tws-rc-0123456789abcdef", labels: { "tws.restore-check": "1", "com.docker.compose.project": "" } };
const PONTE: Container = { name: "paas-host-exec-1a2b3c4d" };
const BUILD: Container = { name: "paas-build-blog" };
const VPS_COM_PAINEL = [PAINEL, CADDY, STALWART, WEBMAIL, MAILTEST, PROJETO_COMPOSE, PROJETO_RUN, RESTAURACAO, PONTE, BUILD];

interface Cenario {
  containers: Container[];
  /** portas ocupadas na VPS (o port_in_use do script é trocado por esta lista) */
  ocupadas?: number[];
  semDocker?: boolean;
}

function preflight(c: Cenario) {
  const dir = ambiente();
  const state = path.join(dir, "docker-state.json");
  writeFileSync(state, JSON.stringify(c.containers));
  if (!c.semDocker) executavel(dir, "docker", DOCKER_FALSO);
  // serviços do host (nginx, apache…) todos parados: o teste não depende da máquina onde roda
  executavel(dir, "systemctl", "#!/bin/bash\nexit 3\n");
  executavel(dir, "pgrep", "#!/bin/bash\nexit 1\n");
  const resposta = path.join(dir, "resposta-vazia");
  writeFileSync(resposta, "");
  const script = [
    "set -euo pipefail",
    'log()  { echo "LOG $*"; }',
    'warn() { echo "AVISO $*"; }',
    'die()  { echo "ERRO $*"; exit 1; }',
    "ISSUES=0",
    'ok()   { echo "OK $*"; }',
    'info() { echo "INFO $*"; }',
    'flag() { echo "FLAG $*"; ISSUES=$((ISSUES + 1)); }',
    "FORCE=0",
    "PORT_PROBE=ss",
    `port_in_use() { case " ${(c.ocupadas ?? []).join(" ")} " in *" $1 "*) return 0 ;; esac; return 1; }`,
    linha("OWN_PS_FORMAT="),
    "PANEL_INSTALLED=0",
    pegar("panel_installed"),
    pegar("own_container"),
    pegar("classify_containers"),
    pegar("port_is_own_container"),
    // do "Docker já instalado?" ao veredito, como está no script; a confirmação lê de um arquivo vazio (ninguém digita)
    trecho("# Docker já instalado? Containers rodando?", "# --- 1b. Terminal do painel").replaceAll("/dev/tty", resposta),
    'echo "FIM ISSUES=$ISSUES"',
  ].join("\n");
  // sem Docker: PATH só com os falsos (o docker de verdade da máquina de teste não pode aparecer)
  const env = c.semDocker ? { PATH: dir, DOCKER_HOST: "unix:///nonexistent.sock" } : envDe(dir, { FAKE_DOCKER_STATE: state });
  const r = spawnSync("/bin/bash", ["-c", script], { encoding: "utf8", env });
  const saida = `${r.stdout}${r.stderr}`;
  return { status: r.status, saida, flags: saida.split("\n").filter((l) => l.startsWith("FLAG ")) };
}

describe("install.sh — pré-flight numa VPS que já tem o painel (reinstalação/atualização)", () => {
  it("só o painel, os serviços dele e os projetos: segue sem pedir 'continuar'", () => {
    const r = preflight({ containers: VPS_COM_PAINEL, ocupadas: [80, 443, 25, 465, 587, 143, 993, 8080, 9000] });
    expect(r.flags).toEqual([]);
    expect(r.saida).toMatch(/INFO Instalação existente do TWS Panel detectada .*Os 10 container\(s\)/);
    expect(r.saida).toMatch(/OK Portas do proxy e do e-mail: as ocupadas \(80 443 25 465 587 143 993 8080\) são do próprio painel/);
    expect(r.saida).toContain("LOG Máquina limpa detectada");
    expect(r.saida).not.toContain("NÃO parece estar limpa");
    expect(r.saida).toContain("FIM ISSUES=0");
    expect(r.status).toBe(0);
  });

  it("painel parado mas proxy e e-mail rodando: ainda é o próprio painel", () => {
    const r = preflight({ containers: [{ ...PAINEL, stopped: true }, CADDY, STALWART], ocupadas: [80, 443, 25] });
    expect(r.flags).toEqual([]);
    expect(r.saida).toContain("FIM ISSUES=0");
  });

  it("container de terceiro junto do painel: aponta só ele e pede 'continuar' (sem resposta, aborta)", () => {
    const r = preflight({ containers: [...VPS_COM_PAINEL, { name: "nginx-antigo" }], ocupadas: [80, 443] });
    expect(r.flags).toEqual(["FLAG Containers Docker em execução que não são do painel: nginx-antigo"]);
    expect(r.saida).toContain("NÃO parece estar limpa (1 ponto(s) acima)");
    expect(r.saida).toContain("ERRO Instalação abortada. Nada foi instalado ou alterado.");
    expect(r.status).toBe(1);
  });

  it("terceiro com nome paas-algo não passa: compose de outro projeto, sem labels, ou com papel errado", () => {
    const terceiros: Container[] = [
      { name: "paas-algo" },
      { name: "paas-loja2-web-1", labels: compose("loja2", "web") },
      // a label do compose decide sozinha: paas.project não vale quando há compose de outro dono
      { name: "paas-forjado", labels: { ...compose("outro", "web"), "paas.managed": "true", "paas.project": "loja" } },
      { name: "paas-caddy-falso", labels: { "paas.managed": "true", "paas.role": "caddy" } },
      { name: "paas-webmail", labels: { "paas.managed": "true", "paas.role": "caddy" } },
      { name: "paas-host-exec-xyz" },
      { name: "tws-rc-123", labels: { "tws.restore-check": "1" } },
    ];
    const r = preflight({ containers: [...VPS_COM_PAINEL.filter((c) => c.name !== "paas-webmail"), ...terceiros] });
    expect(r.flags).toEqual([`FLAG Containers Docker em execução que não são do painel: ${terceiros.map((t) => t.name).join(" ")}`]);
    expect(r.status).toBe(1);
  });

  it("porta reservada ocupada por terceiro continua sendo conflito, mesmo com o painel instalado", () => {
    const r = preflight({ containers: [...VPS_COM_PAINEL.filter((c) => c.name !== "paas-caddy"), { name: "proxy-antigo", ports: "0.0.0.0:80->80/tcp" }], ocupadas: [80, 25] });
    expect(r.flags).toContain("FLAG Portas em uso: 80");
    expect(r.flags).toContain("FLAG Containers Docker em execução que não são do painel: proxy-antigo");
    expect(r.status).toBe(1);
  });

  it("porta ocupada por programa fora do Docker (nginx do sistema) continua sendo conflito", () => {
    const r = preflight({ containers: [PAINEL, STALWART], ocupadas: [80, 25] });
    expect(r.flags).toEqual(["FLAG Portas em uso: 80"]);
  });
});

describe("install.sh — pré-flight numa VPS SEM o painel", () => {
  it("containers com nome e labels do painel não passam sem o painel instalado", () => {
    const r = preflight({ containers: [CADDY, STALWART, PROJETO_COMPOSE, PROJETO_RUN], ocupadas: [80, 443, 25] });
    expect(r.flags).toEqual([
      "FLAG Containers Docker em execução que não são do painel: paas-caddy paas-stalwart paas-loja-web-1 blog",
      "FLAG Portas em uso: 80 443 25",
    ]);
    expect(r.saida).not.toContain("Instalação existente do TWS Panel");
    expect(r.status).toBe(1);
  });

  it("um container chamado tws-panel que não é o serviço 'panel' do compose não é o painel", () => {
    const r = preflight({ containers: [{ name: "tws-panel" }, CADDY], ocupadas: [80] });
    expect(r.flags).toEqual(["FLAG Containers Docker em execução que não são do painel: tws-panel paas-caddy", "FLAG Portas em uso: 80"]);
  });

  it("VPS limpa com Docker: nenhum container, nenhuma pergunta", () => {
    const r = preflight({ containers: [] });
    expect(r.saida).toContain("OK Nenhum container Docker em execução");
    expect(r.saida).toContain("OK Portas do proxy e do e-mail (80/443/25/465/587/143/993/8080) livres");
    expect(r.saida).toContain("FIM ISSUES=0");
  });

  it("VPS limpa sem Docker: segue sem pergunta", () => {
    const r = preflight({ containers: [], semDocker: true });
    expect(r.saida).toContain("OK Docker: ausente (será instalado por este script)");
    expect(r.saida).toContain("FIM ISSUES=0");
    expect(r.status).toBe(0);
  });
});

describe("install.sh — reexecução via sudo preserva as variáveis", () => {
  /** Roda o trecho de verdade com `id -u` falso (usuário comum) e um sudo falso que faz o mesmo que o --preserve-env. */
  function reexec(vars: Record<string, string>) {
    const dir = ambiente();
    executavel(dir, "id", '#!/bin/bash\n[ "$1" = -u ] && { echo 1000; exit 0; }\nexit 1\n');
    // sudo falso: zera o ambiente como o env_reset e devolve só o que veio no --preserve-env
    executavel(
      dir,
      "sudo",
      `#!/bin/bash
lista=""
for a in "$@"; do case "$a" in --preserve-env=*) lista="\${a#--preserve-env=}" ;; esac; done
IFS=',' read -ra nomes <<<"$lista"
for n in "\${nomes[@]}"; do [ -n "\${!n+x}" ] && echo "PRESERVADA $n=\${!n}"; done
exit 0
`,
    );
    const script = ["set -euo pipefail", 'log() { :; }', 'die() { echo "ERRO $*"; exit 1; }', trecho("PRESERVED_ENV=", "# --- Portas: quem já está escutando")].join("\n");
    return spawnSync("bash", ["-c", script], { encoding: "utf8", env: envDe(dir, vars) });
  }

  it("PAAS_ACCESS=tunel chega ao instalador que roda como root", () => {
    const r = reexec({ PAAS_ACCESS: "tunel", PAAS_PORT: "9100", NAO_E_DO_PAINEL: "x" });
    expect(r.stdout).toContain("PRESERVADA PAAS_ACCESS=tunel");
    expect(r.stdout).toContain("PRESERVADA PAAS_PORT=9100");
    expect(r.stdout).not.toContain("NAO_E_DO_PAINEL");
  });

  it("toda variável que o script lê do ambiente está na lista (menos a marca interna TWS_SYNC_REEXEC)", () => {
    const lista = (linha("PRESERVED_ENV=").match(/"([^"]+)"/)?.[1] ?? "").split(",");
    const lidas = new Set([...sh.matchAll(/\$\{((?:PAAS|TWS)_[A-Z_]+|SETUP_TOKEN):-/g)].map((m) => m[1]!));
    // as anunciadas no --help como "(ou $VAR)" / "\$VAR"
    for (const m of pegar("usage").matchAll(/\\\$((?:PAAS|TWS)_[A-Z_]+)/g)) lidas.add(m[1]!);
    lidas.delete("TWS_SYNC_REEXEC");
    expect(lidas.has("PAAS_ACCESS")).toBe(true);
    expect([...lidas].filter((v) => !lista.includes(v))).toEqual([]);
    expect(lista).not.toContain("TWS_SYNC_REEXEC");
  });
});

describe("install.sh — textos alinhados com o acesso HTTPS padrão", () => {
  it("modo 'senha' não manda mais abrir SEMPRE pelo túnel: HTTPS no padrão, túnel no --acesso=tunel", () => {
    const r = spawnSync("bash", ["-c", `say() { printf '%s\\n' "$*"; }\n${pegar("explain_modes")}\nexplain_modes maria`], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).not.toMatch(/SEMPRE pelo túnel/);
    expect(r.stdout).not.toMatch(/sem criptografia/);
    expect(r.stdout).toMatch(/HTTPS \(https:\/\/<ip-com-hífens>\.sslip\.io\)/);
    expect(r.stdout).toMatch(/--acesso=tunel, pelo túnel/);
  });

  it("cabeçalho: clone com --branch main e a pergunta da porta só no modo túnel", () => {
    const cabecalho = sh.slice(0, sh.indexOf("set -euo pipefail"));
    expect(cabecalho).toContain("sudo git clone --branch main https://github.com/kelvindk9w/tws-panel.git /opt/tws-panel");
    expect(cabecalho).not.toMatch(/4ª pergunta/);
    expect(cabecalho).toMatch(/A PERGUNTA só aparece no acesso por túnel \(--acesso=tunel\)/);
  });

  it("o pré-flight não usa mais o critério só pelo nome (port_is_own_caddy)", () => {
    expect(sh).not.toContain("port_is_own_caddy");
    expect(sh).toMatch(/^preflight_containers$/m);
    expect(sh).toMatch(/^preflight_ports$/m);
  });
});
