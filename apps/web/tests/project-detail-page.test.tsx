/**
 * project-detail-page.test.tsx — cabeçalho do projeto. Validação real: não
 * havia botão para abrir o site, e o card dizia "HTTP padrão" com o Caddy
 * servindo HTTPS automático.
 */
import { cleanup, render, screen } from "@testing-library/react";
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
