/**
 * project-lifecycle-feedback.test.tsx — Parar/Iniciar/Remover dão retorno.
 * Antes: clicar em "Parar" não mudava o botão, não dizia "deu certo" e o
 * único sinal era o selo de status mudar, sem aviso nenhum.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return { ...real, apiFetch: apiFetchMock };
});

import { ApiRequestError } from "@/lib/api";
import { setLocale } from "@/i18n/core";
import { ProjectDetailPage } from "@/pages/ProjectDetailPage";
import { DashboardPage } from "@/pages/DashboardPage";

function project(id: string, name: string) {
  return {
    id,
    name,
    slug: id,
    ingestMode: "git",
    source: "https://example.com/r.git",
    branch: "main",
    domain: `${id}.203-0-113-10.sslip.io`,
    websocket: false,
    detection: { type: "static", composeFile: null, outputDir: null, packageManager: null, buildCommand: null, proxyService: null, proxyPort: null, warnings: [], details: [] },
    proxyService: null,
    proxyPort: null,
    createdAt: "2026-09-30T10:00:00Z",
    updatedAt: "2026-09-30T10:00:00Z",
    lastDeployAt: "2026-09-30T10:05:00Z",
    lastDeployStatus: "success",
    deployedBranch: "main",
    deployedSource: "https://example.com/r.git",
  };
}

type Status = "running" | "stopped" | "deploying" | "created" | "error";
const world = { p1: "running" as Status, p2: "running" as Status };

function view(id: "p1" | "p2") {
  return {
    project: project(id, id === "p1" ? "Alfa" : "Beta"),
    status: world[id],
    containers: [],
    url: `https://${id}.203-0-113-10.sslip.io`,
    credential: { configured: false, hint: null, username: null, updatedAt: null },
  };
}

/** `post` decide o que o POST faz; por padrão muda o estado e responde ok. */
let post: (path: string) => Promise<unknown>;

beforeEach(() => {
  world.p1 = "running";
  world.p2 = "running";
  post = async (path) => {
    const [, , , id, kind] = path.split("/");
    world[id as "p1"] = kind === "stop" ? "stopped" : "running";
    return { ok: true, log: "" };
  };
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method === "POST" && /\/(stop|start)$/.test(path)) return post(path);
    const m = /^\/api\/projects\/(p[12])$/.exec(path);
    if (m && !init?.method) return view(m[1] as "p1");
    if (path === "/api/projects") return { projects: [] };
    if (path === "/api/docker/containers") return { containers: [] };
    if (/\/jobs$/.test(path)) return { jobs: [] };
    if (/\/https$/.test(path)) return { domains: [] };
    if (/\/email$/.test(path)) return { email: { enabled: false, domain: null, mailbox: null, mailFrom: null, env: {} } };
    return {};
  });
  setLocale("pt-BR", { persist: false });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  setLocale("pt-BR", { persist: false });
});

function abrir(at = "/projects/p1") {
  render(
    <MemoryRouter initialEntries={[at]}>
      <Link to="/projects/p2">ir-para-beta</Link>
      <Routes>
        <Route path="/projects/:id" element={<ProjectDetailPage />} />
        <Route path="/projects/:id/:section" element={<ProjectDetailPage />} />
        <Route path="/" element={<DashboardPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

const posts = () => apiFetchMock.mock.calls.filter(([, i]) => (i as RequestInit | undefined)?.method === "POST");

describe("Parar projeto — feedback", () => {
  it("andamento imediato: botão desabilitado com \"Parando…\"; depois aviso de sucesso e selo atualizado", async () => {
    let soltar!: () => void;
    post = (path) =>
      new Promise((res) => {
        soltar = () => {
          world.p1 = "stopped";
          res({ ok: true, log: path });
        };
      });
    abrir();
    fireEvent.click(await screen.findByRole("button", { name: "Parar" }));
    const andamento = await screen.findByRole("button", { name: /Parando…/ });
    expect(andamento).toBeDisabled();
    expect(screen.getByRole("button", { name: "Iniciar" })).toBeDisabled();
    expect(screen.queryByTestId("action-notice")).not.toBeInTheDocument();
    await act(async () => soltar());
    const aviso = await screen.findByTestId("action-notice");
    expect(aviso).toHaveTextContent("Projeto parado.");
    expect(aviso).toHaveTextContent(/fora do ar/);
    expect(aviso).toHaveTextContent(/dados foram mantidos/);
    // a região de leitura de tela existe e contém o aviso
    expect(aviso.closest("[role='status']")).not.toBeNull();
    expect(screen.getAllByText("parado").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Parar" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Iniciar" })).toBeEnabled();
  });

  it("clique duplo envia um único pedido", async () => {
    post = async () => {
      await new Promise((r) => setTimeout(r, 30));
      world.p1 = "stopped";
      return { ok: true };
    };
    abrir();
    const botao = await screen.findByRole("button", { name: "Parar" });
    fireEvent.click(botao);
    fireEvent.click(botao);
    await screen.findByText("Projeto parado.");
    expect(posts()).toHaveLength(1);
  });

  it("erro: mensagem específica, projeto na tela e \"Tentar de novo\" repete a ação", async () => {
    let falhar = true;
    post = async () => {
      if (falhar) throw new ApiRequestError(502, "docker_stop_failed", "Falha ao parar containers: tempo esgotado");
      world.p1 = "stopped";
      return { ok: true };
    };
    abrir();
    fireEvent.click(await screen.findByRole("button", { name: "Parar" }));
    const alerta = await screen.findByTestId("action-error");
    expect(alerta).toHaveTextContent(/tempo esgotado/);
    expect(screen.queryByText("Projeto parado.")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Alfa/ })).toBeInTheDocument();
    falhar = false;
    fireEvent.click(within(alerta).getByRole("button", { name: "Tentar de novo" }));
    expect(await screen.findByText("Projeto parado.")).toBeInTheDocument();
    expect(screen.queryByTestId("action-error")).not.toBeInTheDocument();
    expect(posts()).toHaveLength(2);
  });

  it("estado final divergente: NÃO diz que parou; avisa e deixa verificar de novo", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    post = async () => ({ ok: true }); // o servidor respondeu ok, mas o container segue rodando
    abrir();
    fireEvent.click(await screen.findByRole("button", { name: "Parar" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40_000);
    });
    const aviso = await screen.findByTestId("action-notice");
    expect(aviso).toHaveTextContent(/não confirmei/i);
    expect(screen.queryByText("Projeto parado.")).not.toBeInTheDocument();
    // o botão volta a funcionar
    expect(screen.getByRole("button", { name: "Parar" })).toBeEnabled();
    world.p1 = "stopped";
    fireEvent.click(within(aviso).getByRole("button", { name: "Verificar de novo" }));
    expect(await screen.findByText("Projeto parado.")).toBeInTheDocument();
  });

  it("parada demorada: continua em \"Parando…\" até o estado real mudar", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    post = async () => ({ ok: true });
    abrir();
    fireEvent.click(await screen.findByRole("button", { name: "Parar" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(screen.getByRole("button", { name: /Parando…/ })).toBeDisabled();
    expect(screen.queryByText("Projeto parado.")).not.toBeInTheDocument();
    world.p1 = "stopped";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(await screen.findByText("Projeto parado.")).toBeInTheDocument();
  });

  it("resposta tardia depois de trocar de projeto não confirma o projeto errado", async () => {
    let soltar!: () => void;
    post = () =>
      new Promise((res) => {
        soltar = () => {
          world.p1 = "stopped";
          res({ ok: true });
        };
      });
    abrir();
    fireEvent.click(await screen.findByRole("button", { name: "Parar" }));
    await screen.findByRole("button", { name: /Parando…/ });
    fireEvent.click(screen.getByText("ir-para-beta"));
    await screen.findByRole("heading", { name: /Beta/ });
    // Beta não está ocupado: o botão dele funciona
    await waitFor(() => expect(screen.getByRole("button", { name: "Parar" })).toBeEnabled());
    await act(async () => soltar());
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText("Projeto parado.")).not.toBeInTheDocument();
    expect(screen.queryByTestId("action-notice")).not.toBeInTheDocument();
  });

  it("projeto nunca implantado: Parar fica desabilitado", async () => {
    world.p1 = "created";
    abrir();
    expect(await screen.findByRole("button", { name: "Parar" })).toBeDisabled();
    expect(posts()).toHaveLength(0);
  });

  it("falha de rede ao parar: mensagem de conexão, sem sucesso", async () => {
    post = async () => {
      throw new ApiRequestError(0, "network_error", "Não foi possível conectar ao servidor.");
    };
    abrir();
    fireEvent.click(await screen.findByRole("button", { name: "Parar" }));
    expect(await screen.findByTestId("action-error")).toHaveTextContent(/conectar/);
    expect(screen.queryByText("Projeto parado.")).not.toBeInTheDocument();
  });

  it("em inglês: Stopping… e Project stopped.", async () => {
    setLocale("en", { persist: false });
    post = async () => {
      await new Promise((r) => setTimeout(r, 20));
      world.p1 = "stopped";
      return { ok: true };
    };
    abrir();
    fireEvent.click(await screen.findByRole("button", { name: "Stop" }));
    expect(await screen.findByRole("button", { name: /Stopping…/ })).toBeDisabled();
    const aviso = await screen.findByTestId("action-notice");
    expect(aviso).toHaveTextContent("Project stopped.");
    expect(aviso).toHaveTextContent(/data was kept/);
  });
});

describe("Iniciar projeto — feedback", () => {
  it("Iniciando… e depois \"Projeto iniciado.\" só com o estado em execução", async () => {
    world.p1 = "stopped";
    post = async () => {
      await new Promise((r) => setTimeout(r, 20));
      world.p1 = "running";
      return { ok: true };
    };
    abrir();
    fireEvent.click(await screen.findByRole("button", { name: "Iniciar" }));
    expect(await screen.findByRole("button", { name: /Iniciando…/ })).toBeDisabled();
    expect(await screen.findByText("Projeto iniciado.")).toBeInTheDocument();
  });

  it("em inglês", async () => {
    setLocale("en", { persist: false });
    world.p1 = "stopped";
    abrir();
    fireEvent.click(await screen.findByRole("button", { name: "Start" }));
    expect(await screen.findByText("Project started.")).toBeInTheDocument();
  });

  it("servidor ok mas o projeto segue parado: não confirma", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    world.p1 = "stopped";
    post = async () => ({ ok: true });
    abrir();
    fireEvent.click(await screen.findByRole("button", { name: "Iniciar" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40_000);
    });
    expect(screen.queryByText("Projeto iniciado.")).not.toBeInTheDocument();
    expect(await screen.findByTestId("action-notice")).toHaveTextContent(/não confirmei/i);
  });
});

describe("Remover projeto — explicação e retorno", () => {
  it("a zona de perigo explica que não precisa parar antes", async () => {
    abrir("/projects/p1/settings");
    expect(await screen.findByText(/Não precisa parar antes/)).toBeInTheDocument();
  });

  it("ao remover, volta à lista (o aviso de sucesso é exibido lá)", async () => {
    const base = apiFetchMock.getMockImplementation()!;
    apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return { ok: true, log: "" };
      return base(path, init);
    });
    abrir("/projects/p1/settings");
    fireEvent.click(await screen.findByRole("button", { name: /Remover projeto/ }));
    fireEvent.click(screen.getByRole("button", { name: /Confirmar remoção/ }));
    const aviso = await screen.findByTestId("removed-notice");
    expect(aviso).toHaveTextContent("Projeto “Alfa” removido.");
    expect(aviso.closest("[role='status']")).not.toBeNull();
    // fechar o aviso
    fireEvent.click(within(aviso).getByRole("button", { name: "Fechar aviso" }));
    expect(screen.queryByTestId("removed-notice")).not.toBeInTheDocument();
  });
});
