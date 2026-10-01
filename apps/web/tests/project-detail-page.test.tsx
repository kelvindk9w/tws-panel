/**
 * project-detail-page.test.tsx — cabeçalho do projeto. Validação real: não
 * havia botão para abrir o site, e o card dizia "HTTP padrão" com o Caddy
 * servindo HTTPS automático.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return { ...real, apiFetch: apiFetchMock };
});

import { ProjectDetailPage } from "@/pages/ProjectDetailPage";

const PROJECT = {
  id: "p1",
  name: "devLink",
  slug: "devlink",
  ingestMode: "git",
  source: "https://github.com/kelvin/devLink",
  branch: "main",
  domain: "devlink.203-0-113-10.sslip.io",
  websocket: false,
  detection: { type: "static", composeFile: null, outputDir: null, packageManager: null, buildCommand: null, proxyService: null, proxyPort: null, warnings: [], details: [] },
  proxyService: null,
  proxyPort: null,
  createdAt: "2026-09-30T10:00:00Z",
  updatedAt: "2026-09-30T10:00:00Z",
  lastDeployAt: "2026-09-30T10:05:00Z",
  lastDeployStatus: "success",
  deployedBranch: "main",
  deployedSource: "https://github.com/kelvin/devLink",
};

beforeEach(() => {
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(async (path: string) => {
    if (path === "/api/projects/p1") {
      return {
        project: PROJECT,
        status: "running",
        containers: [],
        url: "https://devlink.203-0-113-10.sslip.io",
        credential: { configured: false, hint: null, username: null, updatedAt: null },
      };
    }
    if (path === "/api/projects/p1/jobs") return { jobs: [] };
    if (path === "/api/projects/p1/repo-visibility") return { visibility: "public" };
    if (path.startsWith("/api/domains/suggest")) return { auto: "x", publicIp: "203.0.113.10" };
    if (path === "/api/projects/p1/env") return { vars: [] };
    return {};
  });
});
afterEach(cleanup);

function abrir(at = "/projects/p1") {
  render(
    <MemoryRouter initialEntries={[at]}>
      <Routes>
        <Route path="/projects/:id" element={<ProjectDetailPage />} />
        <Route path="/projects/:id/:section" element={<ProjectDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ProjectDetailPage — acesso ao site", () => {
  it("botão \"Abrir site\" com o endereço https, em nova aba", async () => {
    abrir();
    const botao = await screen.findByRole("link", { name: /Abrir site/ });
    expect(botao).toHaveAttribute("href", "https://devlink.203-0-113-10.sslip.io");
    expect(botao).toHaveAttribute("target", "_blank");
  });

  it("o card diz HTTPS automático (não \"HTTP padrão\")", async () => {
    abrir();
    expect(await screen.findByText(/HTTPS automático/)).toBeInTheDocument();
    expect(screen.queryByText(/HTTP padrão/)).not.toBeInTheDocument();
  });
});

/**
 * Menu do projeto (pedido do dono do produto): Visão geral, Deploys, Domínios,
 * Git, Variáveis, E-mail e Configurações — cada seção com o seu endereço.
 */
describe("ProjectDetailPage — menu do projeto", () => {
  it("mostra as sete seções e abre a Visão geral por padrão", async () => {
    abrir();
    const nav = await screen.findByTestId("project-nav");
    for (const s of ["Visão geral", "Deploys", "Domínios", "Git", "Variáveis", "E-mail", "Configurações"]) {
      expect(nav).toHaveTextContent(s);
    }
    expect(screen.getByText(/HTTPS automático/)).toBeInTheDocument();
    expect(screen.queryByText(/Zona de perigo/)).not.toBeInTheDocument();
  });

  it("cada seção pelo endereço: Domínios, Git (público, sem token) e Configurações (zona de perigo)", async () => {
    abrir("/projects/p1/domains");
    expect(await screen.findByRole("button", { name: /Conectar novo domínio/ })).toBeInTheDocument();
    cleanup();
    abrir("/projects/p1/git");
    expect(await screen.findByText(/Repositório público/)).toBeInTheDocument();
    expect(screen.queryByText(/Credencial do repositório privado/)).not.toBeInTheDocument();
    cleanup();
    abrir("/projects/p1/settings");
    expect(await screen.findByText(/Zona de perigo/)).toBeInTheDocument();
  });
});

describe("ProjectDetailPage — primeiro deploy automático", () => {
  it("?deploy=1 dispara o deploy uma vez (após consultar os guardrails)", async () => {
    const base = apiFetchMock.getMockImplementation()!;
    apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/projects/p1/guardrails") return { report: null, note: null };
      if (path === "/api/projects/p1/deploy") {
        return { job: { id: "j1", projectId: "p1", status: "running", log: "", startedAt: "2026-09-30T10:00:00Z" } };
      }
      return base(path, init);
    });
    abrir("/projects/p1?deploy=1");
    await vi.waitFor(() => {
      const posts = apiFetchMock.mock.calls.filter(([p, i]) => p === "/api/projects/p1/deploy" && (i as RequestInit)?.method === "POST");
      expect(posts).toHaveLength(1);
    });
    await new Promise((r) => setTimeout(r, 50));
    const posts = apiFetchMock.mock.calls.filter(([p, i]) => p === "/api/projects/p1/deploy" && (i as RequestInit)?.method === "POST");
    expect(posts).toHaveLength(1);
  });

  it("sem ?deploy=1 não faz deploy sozinho", async () => {
    abrir();
    await screen.findByRole("link", { name: /Abrir site/ });
    expect(apiFetchMock.mock.calls.some(([p]) => p === "/api/projects/p1/deploy")).toBe(false);
  });

  it("?deploy=pending na seção Variáveis explica o que falta antes do primeiro deploy", async () => {
    abrir("/projects/p1/env?deploy=pending");
    expect(await screen.findByTestId("deploy-pending")).toHaveTextContent(/obrigatórias/);
  });
});

describe("ProjectDetailPage — arquivo compose em uso", () => {
  it("a visão geral mostra qual compose o deploy usa", async () => {
    const base = apiFetchMock.getMockImplementation()!;
    apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      const r = await base(path, init);
      if (path === "/api/projects/p1") {
        return { ...r, project: { ...r.project, detection: { ...r.project.detection, type: "compose", composeFile: "compose.paas.yaml" } } };
      }
      return r;
    });
    abrir();
    expect(await screen.findByTestId("compose-file")).toHaveTextContent("compose.paas.yaml");
  });
});

const JOB_OK = {
  id: "job-ok-1234",
  projectId: "p1",
  status: "success",
  createdAt: "2026-10-01T10:00:00Z",
  startedAt: "2026-10-01T10:00:00Z",
  finishedAt: "2026-10-01T10:01:30Z",
  steps: [{ name: "Ingestão", status: "done" }],
  log: "=== Etapa 1/5 ===\nok\n",
  error: null,
};
const JOB_RUNNING = {
  ...JOB_OK,
  id: "job-run-5678",
  status: "running",
  finishedAt: null,
  steps: [{ name: "Ingestão", status: "done" }, { name: "Build", status: "running" }],
  log: "=== Etapa 2/5 · Build ===\nlinha recente do build\n",
};

/** Mock da API com jobs, HTTPS e e-mail configuráveis. */
function mockProject(opts: { jobs?: unknown[]; email?: unknown; https?: unknown; extra?: (p: string, i?: RequestInit) => unknown }) {
  const base = apiFetchMock.getMockImplementation()!;
  apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    const extra = opts.extra?.(path, init);
    if (extra !== undefined) return extra;
    if (path === "/api/projects/p1/jobs") return { jobs: opts.jobs ?? [] };
    const job = (opts.jobs ?? []).find((j) => path === `/api/projects/p1/jobs/${(j as { id: string }).id}`);
    if (job) return { job };
    if (path === "/api/projects/p1/https") return opts.https ?? { domains: [] };
    if (path === "/api/projects/p1/email") {
      return { email: opts.email ?? { enabled: false, domain: null, mailbox: null, mailFrom: null, env: {} } };
    }
    return base(path, init);
  });
}

/**
 * Validação real (cassino, 01/10/2026): o deploy rodava com variáveis
 * obrigatórias faltando e morria no compose. Agora o servidor recusa antes
 * (422 missing_env) e a página mostra o que falta e leva às Variáveis.
 */
describe("ProjectDetailPage — deploy com variáveis faltando", () => {
  it("abre a janela com a lista, aponta o E-mail para SMTP_*/MAIL_FROM e leva às Variáveis", async () => {
    const { ApiRequestError } = await import("@/lib/api");
    mockProject({
      extra: (p) => {
        if (p === "/api/projects/p1/guardrails") return { report: null, note: null };
        if (p === "/api/projects/p1/deploy") {
          throw new ApiRequestError(422, "missing_env", "Faltam 3.", { missing: ["KYC_MODO", "MAIL_FROM", "SMTP_HOST"] });
        }
        return undefined;
      },
    });
    abrir();
    fireEvent.click(await screen.findByRole("button", { name: /^Deploy$/ }));
    const janela = await screen.findByTestId("missing-env");
    expect(janela).toHaveTextContent("KYC_MODO");
    expect(janela).toHaveTextContent("SMTP_HOST");
    expect(janela).toHaveTextContent(/E-mail do projeto/);
    fireEvent.click(within(janela).getByRole("link", { name: /Ir para Variáveis/ }));
    expect(await screen.findByTestId("env-list")).toBeInTheDocument();
  });
});

/** Pedido do dono do produto: cada ação com a sua cor, para reconhecer só de olhar. */
describe("ProjectDetailPage — cores das ações", () => {
  it("Abrir site azul, Iniciar verde, Parar vermelho, Deploy violeta", async () => {
    abrir();
    expect((await screen.findByRole("link", { name: /Abrir site/ })).className).toMatch(/sky/);
    expect(screen.getByRole("button", { name: /Iniciar/ }).className).toMatch(/emerald/);
    expect(screen.getByRole("button", { name: /Parar/ }).className).toMatch(/red/);
    expect(screen.getByRole("button", { name: /^Deploy$/ }).className).toMatch(/violet/);
  });
});

/**
 * Pedido do dono do produto: a Visão geral fala de tudo — status, domínio
 * ativo com o HTTPS, e-mail, containers e o deploy (o que está acontecendo).
 */
describe("ProjectDetailPage — visão geral", () => {
  it("domínios com o estado do certificado e o e-mail do projeto", async () => {
    mockProject({
      https: {
        domains: [
          { domain: "devlink.203-0-113-10.sslip.io", ok: true, issuer: "Let's Encrypt", validTo: "2026-12-30T00:00:00.000Z", error: null },
          { domain: "devlink.tws.tec.br", ok: false, issuer: null, validTo: null, error: "unable to verify" },
        ],
      },
      email: { enabled: true, domain: "tws.tec.br", mailbox: "devlink@tws.tec.br", mailFrom: "devlink@tws.tec.br", env: {} },
      extra: (p) =>
        p === "/api/projects/p1"
          ? {
              project: { ...PROJECT, aliases: ["devlink.tws.tec.br"] },
              status: "running",
              containers: [],
              url: "https://devlink.203-0-113-10.sslip.io",
              credential: { configured: false, hint: null, username: null, updatedAt: null },
            }
          : undefined,
    });
    abrir();
    const dominios = await screen.findByTestId("overview-domains");
    await waitFor(() => expect(dominios).toHaveTextContent(/Let's Encrypt/));
    expect(dominios).toHaveTextContent(/30\/12\/2026/);
    expect(within(dominios).getByTestId("https-devlink.tws.tec.br")).toHaveTextContent(/ainda sem certificado válido/);
    expect(await screen.findByTestId("overview-email")).toHaveTextContent("devlink@tws.tec.br");
  });

  it("e-mail não ativado: diz e leva à seção E-mail", async () => {
    mockProject({});
    abrir();
    const email = await screen.findByTestId("overview-email");
    await waitFor(() => expect(email).toHaveTextContent(/não ativado/));
    expect(within(email).getByRole("link", { name: /Ativar/ })).toHaveAttribute("href", "/projects/p1/email");
  });

  it("deploy em andamento: etapas e as últimas linhas do log na própria visão geral", async () => {
    mockProject({ jobs: [JOB_RUNNING, JOB_OK] });
    abrir();
    const atual = await screen.findByTestId("overview-deploy");
    await waitFor(() => expect(atual).toHaveTextContent(/em andamento/));
    expect(atual).toHaveTextContent("linha recente do build");
    expect(atual).toHaveTextContent("Build");
  });

  it("sem deploy rodando: resumo do último (status, duração) com link para os detalhes", async () => {
    mockProject({ jobs: [JOB_OK] });
    abrir();
    const atual = await screen.findByTestId("overview-deploy");
    await waitFor(() => expect(atual).toHaveTextContent(/sucesso/));
    expect(atual).toHaveTextContent(/1min 30s/);
    fireEvent.click(within(atual).getByRole("button", { name: /Ver detalhes/ }));
    expect(await screen.findByTestId("deploy-detail")).toHaveTextContent("=== Etapa 1/5 ===");
  });
});

/** Pedido do dono do produto: Deploys é o histórico; o detalhe abre numa janela. */
describe("ProjectDetailPage — histórico de deploys", () => {
  it("lista sem o log em cima; clicar num deploy abre o detalhe com etapas e log", async () => {
    mockProject({ jobs: [JOB_OK] });
    abrir("/projects/p1/deploys");
    const linha = await screen.findByTestId("job-row-job-ok-1234");
    expect(screen.queryByTestId("deploy-detail")).not.toBeInTheDocument();
    expect(linha).toHaveTextContent(/1min 30s/);
    fireEvent.click(linha);
    const detalhe = await screen.findByTestId("deploy-detail");
    expect(detalhe).toHaveTextContent("=== Etapa 1/5 ===");
    fireEvent.click(within(detalhe).getByRole("button", { name: /Fechar/ }));
    expect(screen.queryByTestId("deploy-detail")).not.toBeInTheDocument();
  });
});
