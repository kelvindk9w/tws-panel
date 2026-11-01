/**
 * Carregamento progressivo, casos de borda: dado antigo sinalizado quando o Docker deixa de
 * responder, projeto novo sem espera eterna, "?deploy=1" que não repete o deploy e o cadastro
 * rápido pedido uma vez só.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return { ...real, apiFetch: apiFetchMock };
});

import { ApiRequestError } from "@/lib/api";
import { DashboardPage } from "@/pages/DashboardPage";
import { ProjectDetailPage } from "@/pages/ProjectDetailPage";

const mkProject = (id: string, name: string) => ({
  id,
  name,
  slug: name,
  ingestMode: "git",
  source: "https://example.com/repo/x.git",
  branch: "main",
  domain: `${name}.example.com`,
  websocket: false,
  detection: null,
  proxyService: null,
  proxyPort: null,
  createdAt: "2026-09-30T10:00:00Z",
  updatedAt: "2026-09-30T10:00:00Z",
  lastDeployAt: null,
  lastDeployStatus: null,
});
const CRED = { configured: false, hint: null, username: null, updatedAt: null };
const basicOf = (id: string, name: string) => ({ project: mkProject(id, name), url: `https://${name}.example.com`, credential: CRED });
const liveOf = (id: string, name: string) => ({ ...basicOf(id, name), status: "running", containers: [] });

beforeEach(() => apiFetchMock.mockReset());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const fail = () => Promise.reject(new ApiRequestError(503, "docker_unavailable", "Docker fora"));

describe("Dashboard — Docker deixa de responder depois de uma carga boa", () => {
  it("avisa que o estado e os externos estão desatualizados, e o projeto novo vira \"indisponível\"", async () => {
    let dockerUp = true;
    let projects = [basicOf("p1", "loja")];
    apiFetchMock.mockImplementation((path: unknown) => {
      const key = String(path).split("?")[0];
      if (key === "/api/projects/basic") return Promise.resolve({ projects });
      if (key === "/api/projects") return dockerUp ? Promise.resolve({ projects: [liveOf("p1", "loja")] }) : fail();
      if (key === "/api/docker/containers") return dockerUp ? Promise.resolve({ containers: [] }) : fail();
      if (key === "/api/metrics/summary") return new Promise(() => undefined);
      return Promise.resolve({});
    });
    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText("rodando")).toBeInTheDocument());
    expect(screen.queryByTestId("live-stale")).not.toBeInTheDocument();
    expect(screen.queryByTestId("external-stale")).not.toBeInTheDocument();

    // o Docker cai e um projeto novo aparece no cadastro
    dockerUp = false;
    projects = [basicOf("p1", "loja"), basicOf("p2", "nova")];
    fireEvent.click(screen.getByRole("button", { name: /Atualizar/ }));

    expect(await screen.findByTestId("live-stale")).toHaveTextContent("desatualizado");
    expect(await screen.findByTestId("external-stale")).toHaveTextContent("desatualizada");
    // o dado antigo continua visível...
    const cards = await screen.findAllByTestId("project-card");
    await waitFor(() => expect(screen.getAllByTestId("project-card")).toHaveLength(2));
    expect(within(screen.getAllByTestId("project-card")[0] as HTMLElement).getByText("rodando")).toBeInTheDocument();
    // ...e o projeto que o dado antigo não conhece não fica em espera eterna
    expect(cards.length).toBeGreaterThan(0);
    expect(within(screen.getAllByTestId("project-card")[1] as HTMLElement).getByTestId("live-error")).toBeInTheDocument();
    expect(screen.queryAllByTestId("status-skeleton").length).toBe(0);
  });
});

function renderProject(at: string) {
  return render(
    <MemoryRouter initialEntries={[at]}>
      <Routes>
        <Route path="/projects/:id" element={<ProjectDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("Página do projeto", () => {
  it("?deploy=1: se o clique manual já fez o deploy, o estado voltar não dispara outro", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let liveCalls = 0;
    const deployPosts: string[] = [];
    apiFetchMock.mockImplementation((path: unknown, init?: { method?: string }) => {
      const key = String(path);
      if (key === "/api/projects/p1/basic") return Promise.resolve(basicOf("p1", "loja"));
      if (key === "/api/projects/p1") {
        liveCalls += 1;
        return liveCalls === 1 ? fail() : Promise.resolve(liveOf("p1", "loja"));
      }
      if (key === "/api/projects/p1/jobs") return Promise.resolve({ jobs: [] });
      if (key === "/api/projects/p1/guardrails") return Promise.resolve({ report: { blockers: 0, findings: [] } });
      if (key === "/api/projects/p1/deploy" && init?.method === "POST") {
        deployPosts.push(key);
        return Promise.resolve({ job: { id: "j1", projectId: "p1", status: "queued", steps: [], log: "" } });
      }
      return Promise.resolve({});
    });
    renderProject("/projects/p1?deploy=1");

    // o estado vivo falhou: o botão Deploy continua disponível e a pessoa clica
    const deploy = await screen.findByRole("button", { name: /^Deploy/ });
    await waitFor(() => expect(deploy).not.toBeDisabled());
    await act(async () => fireEvent.click(deploy));
    await waitFor(() => expect(deployPosts).toHaveLength(1));

    // o estado vivo volta na leitura seguinte
    await act(async () => vi.advanceTimersByTimeAsync(6_000));
    await waitFor(() => expect(screen.queryByTestId("status-skeleton")).not.toBeInTheDocument());
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(deployPosts).toHaveLength(1);
  });

  it("o cadastro rápido é pedido uma vez, não a cada ciclo de atualização", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    apiFetchMock.mockImplementation((path: unknown) => {
      const key = String(path);
      if (key === "/api/projects/p1/basic") return Promise.resolve(basicOf("p1", "loja"));
      if (key === "/api/projects/p1") return Promise.resolve(liveOf("p1", "loja"));
      if (key === "/api/projects/p1/jobs") return Promise.resolve({ jobs: [] });
      return Promise.resolve({});
    });
    renderProject("/projects/p1");
    await screen.findByRole("heading", { name: /loja/ });
    await act(async () => vi.advanceTimersByTimeAsync(16_000));
    const basicCalls = apiFetchMock.mock.calls.filter(([p]) => p === "/api/projects/p1/basic").length;
    const liveCalls = apiFetchMock.mock.calls.filter(([p]) => p === "/api/projects/p1").length;
    expect(liveCalls).toBeGreaterThan(2);
    expect(basicCalls).toBe(1);
  });
});
