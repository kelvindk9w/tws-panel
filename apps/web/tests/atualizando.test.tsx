/**
 * Durante um deploy/atualização o painel mostra "Atualizando" (azul, com indicador), nunca "parado",
 * "offline" ou erro: no selo, no cartão do Dashboard, na página do projeto e nos containers que somem
 * ou são recriados. Terminado o job, o estado normal volta.
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return { ...real, apiFetch: apiFetchMock };
});

import { containerState } from "@/components/project/ComposeServices";
import { DashboardPage, StatusBadge } from "@/pages/DashboardPage";
import { ProjectDetailPage } from "@/pages/ProjectDetailPage";

const PROJECT = {
  id: "p1",
  name: "loja",
  slug: "loja",
  ingestMode: "git",
  source: "https://example.com/repo/loja.git",
  branch: "main",
  domain: "loja.example.com",
  websocket: false,
  detection: { type: "static", composeFile: null, outputDir: null, packageManager: null, buildCommand: null, proxyService: null, proxyPort: null, warnings: [], details: [] },
  proxyService: null,
  proxyPort: null,
  createdAt: "2026-09-30T10:00:00Z",
  updatedAt: "2026-09-30T10:00:00Z",
  lastDeployAt: "2026-09-30T10:05:00Z",
  lastDeployStatus: "success",
};
const CRED = { configured: false, hint: null, username: null, updatedAt: null };
const BASIC = { project: PROJECT, url: "https://loja.example.com", credential: CRED };
/** Container recriado pelo deploy: parado por um instante. */
const EXITED = { id: "c1", name: "loja-web-1", image: "nginx", state: "exited", status: "Exited (0) 2 seconds ago", managed: true, projectSlug: "loja", composeProject: null };
const UPDATING = { ...BASIC, status: "deploying", containers: [EXITED] };

beforeEach(() => apiFetchMock.mockReset());
afterEach(cleanup);

function route(handlers: Record<string, () => Promise<unknown>>) {
  apiFetchMock.mockImplementation((path: unknown) => {
    const key = String(path ?? "").split("?")[0] as string;
    return handlers[key] ? handlers[key]() : Promise.resolve({});
  });
}

describe("selo Atualizando", () => {
  it("deploying: texto 'Atualizando', azul, com indicador girando; nada de vermelho", () => {
    render(<StatusBadge status="deploying" />);
    const badge = screen.getByTestId("status-updating");
    expect(badge).toHaveTextContent("Atualizando");
    expect(badge.className).toMatch(/sky/);
    expect(badge.className).not.toMatch(/red|destructive/);
    expect(badge.querySelector("svg.animate-spin")).not.toBeNull();
  });

  it("depois do job o selo volta ao normal", () => {
    render(<StatusBadge status="running" />);
    expect(screen.queryByTestId("status-updating")).not.toBeInTheDocument();
    expect(screen.getByText("rodando")).toBeInTheDocument();
  });
});

describe("containers durante o deploy", () => {
  it("ausente ou parado vira 'atualizando' (info), nunca vermelho", () => {
    expect(containerState(undefined, undefined, true)).toMatchObject({ label: "atualizando", variant: "info" });
    expect(containerState({ state: "exited", health: null }, { completed: false, exitCode: 1 }, true)).toMatchObject({ variant: "info" });
  });

  it("rodando continua como rodando, mesmo no deploy; fora do deploy parado segue vermelho", () => {
    expect(containerState({ state: "running", health: null }, undefined, true).variant).toBe("success");
    expect(containerState({ state: "exited", health: null }, { completed: false, exitCode: 1 }).variant).toBe("destructive");
  });
});

describe("Dashboard e página do projeto", () => {
  it("o cartão do Dashboard mostra Atualizando, não 'parado'", async () => {
    route({
      "/api/projects/basic": async () => ({ projects: [BASIC] }),
      "/api/projects": async () => ({ projects: [UPDATING] }),
      "/api/docker/containers": async () => ({ containers: [EXITED] }),
      "/api/metrics/summary": () => new Promise<never>(() => undefined),
    });
    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );
    const card = await screen.findByTestId("project-card");
    await waitFor(() => expect(within(card).getByTestId("status-updating")).toHaveTextContent("Atualizando"));
    expect(within(card).queryByText("parado")).not.toBeInTheDocument();
  });

  it("a página do projeto mostra Atualizando no cabeçalho e na Visão geral, com o container em azul", async () => {
    route({
      "/api/projects/p1/basic": async () => BASIC,
      "/api/projects/p1": async () => UPDATING,
      "/api/projects/p1/jobs": async () => ({ jobs: [] }),
    });
    render(
      <MemoryRouter initialEntries={["/projects/p1"]}>
        <Routes>
          <Route path="/projects/:id" element={<ProjectDetailPage />} />
          <Route path="/projects/:id/:section" element={<ProjectDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId("overview-status")).toHaveTextContent("Atualizando"));
    expect(screen.getAllByTestId("status-updating").length).toBeGreaterThanOrEqual(2);
    const dot = screen.getByTestId("overview-containers").querySelector("span.rounded-full");
    expect(dot?.className).toMatch(/sky/);
    expect(dot?.className).not.toMatch(/red/);
  });
});
