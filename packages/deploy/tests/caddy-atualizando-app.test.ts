/**
 * Página "Atualizando" também quando o APP responde 502/503/504 ou demora a responder durante o deploy.
 *
 * Caso real: projeto compose com nginx próprio na frente do PHP. No redeploy o compose recria o PHP e o
 * nginx continua de pé: primeiro segura a conexão sem responder e depois devolve o 502 cru dele. O
 * handle_errors do bloco só via erros do próprio Caddy (sem conexão), então o visitante ficava sem
 * resposta e depois via o 502 do nginx. Agora, só durante o deploy, o reverse_proxy do projeto:
 *  - limita a espera pelos cabeçalhos da resposta (response_header_timeout) — o "sem resposta" vira página;
 *  - trata 502/503/504 do app com handle_response, que cai no mesmo handle_errors da página Atualizando.
 * Fora do deploy, as respostas do app passam como estão (o painel não troca a página de erro do app).
 *
 * O comportamento do Caddy com esta configuração foi conferido à parte com o binário 2.11.7 (a versão da
 * imagem fixada em @paas/core): 502 e 503 do app viram a página em milissegundos, um app que aceita a
 * conexão e não responde vira a página em 5 s, porta fechada em 3 s, 500 e 200 passam intactos; sem o
 * aviso, o 502 cru passa e o app mudo segura o visitante sem limite.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@paas/core";
import {
  CaddyManager,
  PROJECT_DOWN_PAGE,
  PROJECT_PENDING_PAGE,
  PROJECT_UPDATING_PAGE,
  UPDATING_HEADER_TIMEOUT_SECONDS,
  renderCaddyfile,
  type CaddyApplyOptions,
  type CaddyTarget,
} from "../src/caddy.js";
import { DeployEngine, type EngineContext } from "../src/engine.js";

const alvo = { domain: "loja.example.com", upstream: "paas-loja:3000", websocket: false };

/** Texto do bloco de site que começa na linha `<endereço> {` (até a chave que o fecha). */
function bloco(caddyfile: string, endereco: string): string {
  const linhas = caddyfile.split("\n");
  const inicio = linhas.findIndex((l) => l === `${endereco} {`);
  if (inicio < 0) throw new Error(`bloco ${endereco} não encontrado`);
  const fim = linhas.findIndex((l, i) => i > inicio && l === "}");
  return linhas.slice(inicio, fim + 1).join("\n");
}

/** Só o reverse_proxy do bloco (as linhas entre `reverse_proxy ... {` e o `}` com um tab). */
function proxyDe(blocoDeSite: string): string {
  const linhas = blocoDeSite.split("\n");
  const inicio = linhas.findIndex((l) => l.startsWith("\treverse_proxy "));
  const fim = linhas.findIndex((l, i) => i > inicio && l === "\t}");
  return linhas.slice(inicio, fim + 1).join("\n");
}

/** O que o handle_errors do bloco responde (a página e os cabeçalhos). */
function paginaDeErro(blocoDeSite: string): string {
  const linhas = blocoDeSite.split("\n");
  const inicio = linhas.findIndex((l) => l.startsWith("\thandle_errors "));
  const fim = linhas.findIndex((l, i) => i > inicio && l === "\t}");
  return linhas.slice(inicio, fim + 1).join("\n");
}

const INTERCEPTA = ["\t\t@app_indisponivel status 502 503 504", "\t\thandle_response @app_indisponivel {", "\t\t\terror 503", "\t\t}"].join("\n");
const LIMITE = ["\t\ttransport http {", `\t\t\tresponse_header_timeout ${UPDATING_HEADER_TIMEOUT_SECONDS}s`, "\t\t}"].join("\n");

describe("durante o deploy: resposta de erro ou demora do app vira a página Atualizando", () => {
  it("o reverse_proxy trata 502, 503 e 504 do app e limita a espera pelos cabeçalhos em poucos segundos", () => {
    const site = bloco(renderCaddyfile([{ ...alvo, published: true, updating: true }]), "loja.example.com");
    const proxy = proxyDe(site);
    expect(proxy).toContain(INTERCEPTA);
    expect(proxy).toContain(LIMITE);
    expect(UPDATING_HEADER_TIMEOUT_SECONDS).toBeLessThanOrEqual(5);
  });

  it("o erro gerado cai no handle_errors da página Atualizando: 503, Retry-After 5 e sem cache", () => {
    const site = bloco(renderCaddyfile([{ ...alvo, published: true, updating: true }]), "loja.example.com");
    // o `error 503` do handle_response precisa de um handle_errors que pegue o 503
    expect(site).toContain("\thandle_errors 502 503 504 {");
    const pagina = paginaDeErro(site);
    expect(pagina).toContain(`respond \`${PROJECT_UPDATING_PAGE}\` 503`);
    expect(pagina).toContain('header Retry-After "5"');
    expect(pagina).toContain('header Cache-Control "no-store"');
    expect(pagina).toContain('header Content-Type "text/html; charset=utf-8"');
  });

  it("só 502, 503 e 504: um 500 ou 404 do app continua chegando ao visitante como o app mandou", () => {
    const proxy = proxyDe(bloco(renderCaddyfile([{ ...alvo, published: true, updating: true }]), "loja.example.com"));
    const matcher = proxy.split("\n").find((l) => l.includes("@app_indisponivel status"));
    expect(matcher?.trim().split(/\s+/).slice(2)).toEqual(["502", "503", "504"]);
  });

  it("app com WebSocket mantém flush_interval e ganha o mesmo tratamento", () => {
    const proxy = proxyDe(bloco(renderCaddyfile([{ ...alvo, websocket: true, published: true, updating: true }]), "loja.example.com"));
    expect(proxy).toContain("flush_interval -1");
    expect(proxy).toContain("stream_close_delay 5m");
    expect(proxy).toContain(INTERCEPTA);
  });

  it("primeiro deploy (nunca publicado): o erro do app também é trocado, pela página 'em manutenção'", () => {
    const site = bloco(renderCaddyfile([{ ...alvo, published: false, updating: true }]), "loja.example.com");
    expect(proxyDe(site)).toContain(INTERCEPTA);
    expect(paginaDeErro(site)).toContain(`respond \`${PROJECT_PENDING_PAGE}\` 503`);
    expect(site).not.toContain(PROJECT_UPDATING_PAGE);
  });

  it("domínio dinâmico (curinga e nome avulso) do projeto em deploy ganha o mesmo tratamento", () => {
    const out = renderCaddyfile([], undefined, [], [], {
      dynamic: {
        askUrl: "http://tws-panel:9101/caddy/ask",
        routes: [{ upstream: "paas-loja:3000", websocket: false, published: true, updating: true, suffixes: ["example.com"], hosts: ["cliente.example.org"] }],
      },
    });
    const site = bloco(out, "cliente.example.org");
    expect(proxyDe(site)).toContain(INTERCEPTA);
    expect(proxyDe(site)).toContain(LIMITE);
    expect(site).toContain("on_demand");
  });
});

describe("fora do deploy: as respostas do app passam como estão", () => {
  it("sem handle_response e sem limite de espera pelos cabeçalhos (padrão do Caddy)", () => {
    const proxy = proxyDe(bloco(renderCaddyfile([{ ...alvo, published: true }]), "loja.example.com"));
    expect(proxy).not.toContain("handle_response");
    expect(proxy).not.toContain("@app_indisponivel");
    expect(proxy).not.toContain("response_header_timeout");
    expect(proxy).not.toContain("transport http");
  });

  it("a página de indisponível segue só para quando o Caddy não alcança o app", () => {
    const site = bloco(renderCaddyfile([{ ...alvo, published: true }]), "loja.example.com");
    expect(paginaDeErro(site)).toContain(`respond \`${PROJECT_DOWN_PAGE}\` 503`);
  });

  it("projeto parado de propósito não ganha o tratamento", () => {
    const proxy = proxyDe(bloco(renderCaddyfile([{ ...alvo, published: true, stopped: true }]), "loja.example.com"));
    expect(proxy).not.toContain("handle_response");
    expect(proxy).not.toContain("response_header_timeout");
  });

  it("só o projeto em deploy muda; o vizinho, o painel e o webmail ficam como estavam", () => {
    const out = renderCaddyfile(
      [
        { ...alvo, published: true, updating: true },
        { domain: "blog.example.com", upstream: "paas-blog:80", websocket: false, published: true },
      ],
      { domain: "203-0-113-10.sslip.io", upstream: "tws-panel:9000" },
      ["mail.example.com"],
      [],
      { webmail: { upstream: "paas-webmail:8000" } },
    );
    expect(proxyDe(bloco(out, "loja.example.com"))).toContain(INTERCEPTA);
    expect(out.split("handle_response @app_indisponivel").length - 1).toBe(1);
    expect(out.split("response_header_timeout").length - 1).toBe(1);
    expect(proxyDe(bloco(out, "blog.example.com"))).not.toContain("handle_response");
  });
});

const proj = (slug: string, over: Partial<Project> = {}): Project =>
  ({
    id: slug,
    slug,
    name: slug,
    ingestMode: "git",
    source: "https://example.com/r.git",
    branch: "main",
    domain: `${slug}.example.com`,
    websocket: false,
    detection: null,
    lastDeployStatus: "success",
    deployedSource: "x",
    ...over,
  }) as unknown as Project;

const ctx = (): EngineContext => ({
  projectsDir: "/nonexistent/projects",
  caddyDir: "/nonexistent/caddy",
  nodeImage: "node:22",
  staticImage: "nginx:alpine",
  caddyHttpPort: 80,
  caddyHttpsPort: 443,
});

/**
 * O Caddyfile que o motor geraria para os projetos: o CaddyManager.apply é substituído (nada de Docker) e
 * os alvos que ele receberia passam pelo mesmo renderCaddyfile que ele usa.
 */
async function caddyfileDoMotor(engine: DeployEngine, projetos: Project[]): Promise<string> {
  let capturado: [CaddyTarget[], string[], CaddyApplyOptions] | null = null;
  const apply = vi.spyOn(CaddyManager.prototype, "apply").mockImplementation(async (targets, _log, mailHosts = [], opts = {}) => {
    capturado = [targets, mailHosts, opts];
  });
  await engine.syncCaddy(projetos);
  apply.mockRestore();
  if (!capturado) throw new Error("o motor não aplicou o Caddy");
  const [targets, mailHosts, opts] = capturado;
  return renderCaddyfile(targets, undefined, mailHosts, [], opts.dynamic ? { dynamic: opts.dynamic } : {});
}

describe("motor: configuração do Caddy de um projeto compose e de um container, durante o deploy e fora dele", () => {
  afterEach(() => vi.restoreAllMocks());

  const compose = proj("loja", {
    detection: { type: "compose", proxyPort: 8080 } as Project["detection"],
    aliases: ["www.loja.example.com"],
  });
  const umContainer = proj("blog", { detection: { type: "dockerfile", proxyPort: 3000 } as Project["detection"] });
  const nextjs = proj("vitrine", { detection: { type: "node-server" } as Project["detection"] });

  it("compose em deploy: o serviço exposto (nginx do projeto) tem os erros e a demora trocados pela página Atualizando", async () => {
    const engine = new DeployEngine(ctx());
    engine.setUpdating("loja", true);
    const site = bloco(await caddyfileDoMotor(engine, [compose, umContainer]), "loja.example.com, www.loja.example.com");
    expect(site).toContain("\treverse_proxy loja:8080 {");
    expect(proxyDe(site)).toContain(INTERCEPTA);
    expect(proxyDe(site)).toContain(LIMITE);
    expect(paginaDeErro(site)).toContain(`respond \`${PROJECT_UPDATING_PAGE}\` 503`);
  });

  it("compose fora do deploy: o 502/503/504 do app passa como está", async () => {
    const engine = new DeployEngine(ctx());
    engine.setUpdating("loja", true);
    engine.setUpdating("loja", false);
    const site = bloco(await caddyfileDoMotor(engine, [compose]), "loja.example.com, www.loja.example.com");
    expect(proxyDe(site)).not.toContain("handle_response");
    expect(proxyDe(site)).not.toContain("response_header_timeout");
    expect(paginaDeErro(site)).toContain(`respond \`${PROJECT_DOWN_PAGE}\` 503`);
  });

  it("um container (Dockerfile e Next.js) em deploy: o mesmo tratamento; o vizinho compose sem deploy fica como está", async () => {
    const engine = new DeployEngine(ctx());
    engine.setUpdating("blog", true);
    engine.setUpdating("vitrine", true);
    const out = await caddyfileDoMotor(engine, [compose, umContainer, nextjs]);
    const blog = bloco(out, "blog.example.com");
    expect(blog).toContain("\treverse_proxy blog:3000 {");
    expect(proxyDe(blog)).toContain(INTERCEPTA);
    expect(proxyDe(blog)).toContain(LIMITE);
    expect(proxyDe(bloco(out, "vitrine.example.com"))).toContain(INTERCEPTA);
    expect(proxyDe(bloco(out, "loja.example.com, www.loja.example.com"))).not.toContain("handle_response");
  });

  it("um container fora do deploy: sem handle_response nem limite de espera", async () => {
    const engine = new DeployEngine(ctx());
    const site = bloco(await caddyfileDoMotor(engine, [umContainer]), "blog.example.com");
    expect(proxyDe(site)).not.toContain("handle_response");
    expect(proxyDe(site)).not.toContain("response_header_timeout");
  });
});
