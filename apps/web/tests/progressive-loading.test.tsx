/**
 * Carregamento progressivo: o Dashboard e a página do projeto mostram na hora o que já está
 * disponível (a lista e os dados básicos, do cadastro) e deixam o que depende do Docker, das
 * medidas e dos alertas chegar depois, cada um no seu cartão, com placeholder próprio. O erro de
 * um cartão fica no cartão e não apaga a página.
 */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
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
import { MetricsStrip } from "@/components/metrics/MetricsStrip";

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
const LIVE = {
  ...BASIC,
  status: "running",
  containers: [
    { id: "c1", name: "loja-web-1", image: "nginx", state: "running", status: "Up 1 hour", managed: true, projectSlug: "loja", composeProject: null },
  ],
};

/** Promessa que o teste resolve quando quiser. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const never = () => new Promise<never>(() => undefined);

beforeEach(() => apiFetchMock.mockReset());
afterEach(cleanup);

type Handlers = Record<string, () => Promise<unknown>>;
/** Responde por caminho; o que não está na tabela devolve `{}` (cartões vizinhos que não importam aqui). */
function route(handlers: Handlers) {
  apiFetchMock.mockImplementation((path: unknown) => {
    const key = String(path ?? "").split("?")[0] as string;
    return handlers[key] ? handlers[key]() : Promise.resolve({});
  });
}

const fail = (status: number, code: string) => async () => {
  throw new ApiRequestError(status, code, "falhou");
};

function renderDashboard() {
  return render(
    <MemoryRouter>
      <DashboardPage />
    </MemoryRouter>,
  );
}

describe("Dashboard — a lista aparece antes do que é lento", () => {
  it("mostra o projeto assim que o cadastro chega, com placeholders no estado e nos containers", async () => {
    route({
      "/api/projects/basic": async () => ({ projects: [BASIC] }),
      "/api/projects": never,
      "/api/docker/containers": never,
      "/api/metrics/summary": never,
    });
    renderDashboard();

    const card = await screen.findByTestId("project-card");
    expect(within(card).getByText("loja")).toBeInTheDocument();
    expect(within(card).getByText("loja.example.com")).toBeInTheDocument();
    // nada do Docker chegou: o cartão mostra placeholders, não zero containers
    expect(within(card).getByTestId("status-skeleton")).toBeInTheDocument();
    expect(within(card).getByTestId("containers-skeleton")).toBeInTheDocument();
    expect(within(card).queryByText(/container\(es\)/)).not.toBeInTheDocument();
    // cada cartão lento tem o seu placeholder
    expect(screen.getByTestId("external-skeleton")).toBeInTheDocument();
    expect(screen.getByTestId("metrics-skeleton")).toBeInTheDocument();
    // e a página não está bloqueada
    expect(screen.getByRole("heading", { name: "Projetos" })).toBeInTheDocument();
  });

  it("antes de qualquer resposta mostra cartões de espera do tamanho dos finais", () => {
    route({ "/api/projects/basic": never, "/api/projects": never, "/api/docker/containers": never, "/api/metrics/summary": never });
    renderDashboard();
    expect(screen.getAllByTestId("project-card-skeleton")).toHaveLength(2);
    expect(screen.queryByText("Nenhum projeto ainda")).not.toBeInTheDocument();
  });

  it("o estado e os containers preenchem o cartão quando chegam, cada um no seu tempo", async () => {
    const live = deferred<unknown>();
    const docker = deferred<unknown>();
    route({
      "/api/projects/basic": async () => ({ projects: [BASIC] }),
      "/api/projects": () => live.promise,
      "/api/docker/containers": () => docker.promise,
      "/api/metrics/summary": never,
    });
    renderDashboard();
    const card = await screen.findByTestId("project-card");
    expect(within(card).getByTestId("status-skeleton")).toBeInTheDocument();

    await act(async () => live.resolve({ projects: [LIVE] }));
    await waitFor(() => expect(within(screen.getByTestId("project-card")).getByText("rodando")).toBeInTheDocument());
    expect(within(screen.getByTestId("project-card")).getByText(/1 container\(es\)/)).toBeInTheDocument();
    // os containers externos ainda esperam pela própria resposta
    expect(screen.getByTestId("external-skeleton")).toBeInTheDocument();

    await act(async () =>
      docker.resolve({ containers: [{ id: "x1", name: "redis", image: "redis:7", state: "running", status: "Up", managed: false, projectSlug: null, composeProject: null }] }),
    );
    expect(await screen.findByText("redis")).toBeInTheDocument();
    expect(screen.queryByTestId("external-skeleton")).not.toBeInTheDocument();
  });
});

describe("Dashboard — erro de um cartão não apaga a página", () => {
  it("Docker fora: os projetos continuam na tela e cada parte lenta explica a falha no seu lugar", async () => {
    route({
      "/api/projects/basic": async () => ({ projects: [BASIC] }),
      "/api/projects": fail(503, "docker_unavailable"),
      "/api/docker/containers": fail(503, "docker_unavailable"),
      "/api/metrics/summary": fail(500, "boom"),
    });
    renderDashboard();

    const card = await screen.findByTestId("project-card");
    await waitFor(() => expect(within(card).getByTestId("live-error")).toHaveTextContent("Estado dos containers indisponível agora."));
    expect(within(card).getByText("loja")).toBeInTheDocument();
    expect(within(card).getByText("indisponível")).toBeInTheDocument();
    expect(await screen.findByTestId("external-error")).toHaveTextContent("Não foi possível listar os containers agora.");
    expect(await screen.findByText("Não foi possível ler o monitoramento agora.")).toBeInTheDocument();
    expect(screen.queryByTestId("metrics-skeleton")).not.toBeInTheDocument();
  });

  it("cadastro falha mas o estado chega: a lista sai dele", async () => {
    route({
      "/api/projects/basic": fail(500, "internal_error"),
      "/api/projects": async () => ({ projects: [LIVE] }),
      "/api/docker/containers": async () => ({ containers: [] }),
      "/api/metrics/summary": never,
    });
    renderDashboard();
    const card = await screen.findByTestId("project-card");
    await waitFor(() => expect(within(card).getByText("rodando")).toBeInTheDocument());
  });

  it("nada da lista chega: o erro aparece no lugar da lista, o resto da página fica", async () => {
    route({
      "/api/projects/basic": fail(500, "internal_error"),
      "/api/projects": never,
      "/api/docker/containers": async () => ({ containers: [] }),
      "/api/metrics/summary": never,
    });
    renderDashboard();
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByTestId("project-card-skeleton")).not.toBeInTheDocument();
    expect(await screen.findByText("Nenhum container externo encontrado.")).toBeInTheDocument();
  });
});

describe("Faixa de saúde — placeholder próprio", () => {
  it("mostra cartões de espera, sem erro, enquanto a medida não chega", () => {
    route({ "/api/metrics/summary": never });
    render(
      <MemoryRouter>
        <MetricsStrip projects={[]} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("metrics-skeleton").children).toHaveLength(6);
  });
});

function renderProject() {
  return render(
    <MemoryRouter initialEntries={["/projects/p1"]}>
      <Routes>
        <Route path="/projects/:id" element={<ProjectDetailPage />} />
        <Route path="/projects/:id/:section" element={<ProjectDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("Página do projeto — o cadastro aparece antes do Docker", () => {
  it("mostra nome, endereço e menu com a Visão geral em placeholders até o estado chegar", async () => {
    const live = deferred<unknown>();
    route({
      "/api/projects/p1/basic": async () => BASIC,
      "/api/projects/p1": () => live.promise,
      "/api/projects/p1/jobs": async () => ({ jobs: [] }),
    });
    renderProject();

    expect(await screen.findByRole("heading", { name: /loja/ })).toBeInTheDocument();
    expect(screen.getByTestId("project-nav")).toBeInTheDocument();
    expect(screen.getByTestId("status-skeleton")).toBeInTheDocument();
    expect(screen.getByTestId("overview-status-skeleton")).toBeInTheDocument();
    expect(screen.getByTestId("overview-containers-skeleton")).toBeInTheDocument();
    // sem saber o estado, parar e iniciar não ficam disponíveis
    expect(screen.getByRole("button", { name: /Parar/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Iniciar/ })).toBeDisabled();

    await act(async () => live.resolve(LIVE));
    await waitFor(() => expect(screen.queryByTestId("status-skeleton")).not.toBeInTheDocument());
    expect(screen.getByTestId("overview-status")).toHaveTextContent("rodando");
    expect(screen.getByTestId("overview-containers")).toHaveTextContent("loja-web-1");
  });

  it("estado vivo falha: o cadastro continua e o cartão de containers explica", async () => {
    route({
      "/api/projects/p1/basic": async () => BASIC,
      "/api/projects/p1": fail(503, "docker_unavailable"),
      "/api/projects/p1/jobs": async () => ({ jobs: [] }),
    });
    renderProject();
    expect(await screen.findByRole("heading", { name: /loja/ })).toBeInTheDocument();
    expect(await screen.findByTestId("overview-containers-error")).toHaveTextContent("Não foi possível ler o estado dos containers agora.");
    expect(screen.getByTestId("overview-status-error")).toBeInTheDocument();
    expect(screen.queryByTestId("overview-containers-skeleton")).not.toBeInTheDocument();
  });

  it("sem nada ainda: contorno da página em placeholders, não uma tela em branco", () => {
    route({ "/api/projects/p1/basic": never, "/api/projects/p1": never, "/api/projects/p1/jobs": never });
    renderProject();
    expect(screen.getByTestId("project-skeleton")).toBeInTheDocument();
  });

  it("os deploys são pedidos junto, sem esperar o Docker", async () => {
    route({
      "/api/projects/p1/basic": async () => BASIC,
      "/api/projects/p1": never,
      "/api/projects/p1/jobs": async () => ({ jobs: [] }),
    });
    renderProject();
    expect(await screen.findByRole("heading", { name: /loja/ })).toBeInTheDocument();
    expect(apiFetchMock).toHaveBeenCalledWith("/api/projects/p1/jobs");
  });
});
