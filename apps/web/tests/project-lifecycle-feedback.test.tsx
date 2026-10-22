/**
 * project-lifecycle-feedback.test.tsx — Parar/Iniciar/Remover dão retorno.
 * Antes: clicar em "Parar" não mudava o botão, não dizia "deu certo" e o
 * único sinal era o selo de status mudar, sem aviso nenhum.
 */
import { act, cleanup, configure, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return { ...real, apiFetch: apiFetchMock };
});

configure({ asyncUtilTimeout: 4000 });

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
const flags = { unpublished: false };
/** gancho chamado a cada GET do projeto (depois de montar a resposta) */
let onProjectGet: ((id: string) => void) | null = null;

function view(id: "p1" | "p2") {
  return {
    project: flags.unpublished
      ? { ...project(id, id === "p1" ? "Alfa" : "Beta"), lastDeployStatus: null, deployedSource: null }
      : project(id, id === "p1" ? "Alfa" : "Beta"),
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
  flags.unpublished = false;
  onProjectGet = null;
  post = async (path) => {
    const [, , , id, kind] = path.split("/");
    world[id as "p1"] = kind === "stop" ? "stopped" : "running";
    return { ok: true, log: "" };
  };
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method === "POST" && /\/(stop|start)$/.test(path)) return post(path);
    const m = /^\/api\/projects\/(p[12])$/.exec(path);
    if (m && !init?.method) {
      const v = view(m[1] as "p1");
      onProjectGet?.(m[1]);
      return v;
    }
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

describe("Revisão — remoção atrasada, região de anúncio, estabilização e textos", () => {
  it("remoção que termina depois de ir para outro projeto NÃO tira o usuário de lá; anuncia sem navegar", async () => {
    let soltar!: () => void;
    const base = apiFetchMock.getMockImplementation()!;
    apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return new Promise((res) => (soltar = () => res({ ok: true, log: "" })));
      return base(path, init);
    });
    abrir("/projects/p1/settings");
    fireEvent.click(await screen.findByRole("button", { name: /Remover projeto/ }));
    fireEvent.click(screen.getByRole("button", { name: /Confirmar remoção/ }));
    await screen.findByRole("button", { name: /Removendo…/ });
    fireEvent.click(screen.getByText("ir-para-beta"));
    await screen.findByRole("heading", { name: /Beta/ });
    await act(async () => soltar());
    const aviso = await screen.findByTestId("action-notice");
    expect(aviso).toHaveTextContent("Projeto “Alfa” removido.");
    expect(screen.getByRole("heading", { name: /Beta/ })).toBeInTheDocument();
    expect(screen.queryByTestId("removed-notice")).not.toBeInTheDocument();
  });

  it("remoção que falha: erro com \"Tentar de novo\"; na segunda vez volta à lista", async () => {
    let falhar = true;
    const base = apiFetchMock.getMockImplementation()!;
    apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        if (falhar) throw new ApiRequestError(500, "internal_error", "Falha ao remover.");
        return { ok: true, log: "" };
      }
      return base(path, init);
    });
    abrir("/projects/p1/settings");
    fireEvent.click(await screen.findByRole("button", { name: /Remover projeto/ }));
    fireEvent.click(screen.getByRole("button", { name: /Confirmar remoção/ }));
    const alerta = await screen.findByTestId("action-error");
    falhar = false;
    fireEvent.click(within(alerta).getByRole("button", { name: "Tentar de novo" }));
    expect(await screen.findByTestId("removed-notice")).toBeInTheDocument();
  });

  it("remoção parcial: não afirma que tudo foi apagado e mostra o que ficou", async () => {
    const base = apiFetchMock.getMockImplementation()!;
    apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return { ok: true, log: "1 container(es) removido(s).\nNÃO removido: pasta /data/x (permissão).\n" };
      return base(path, init);
    });
    abrir("/projects/p1/settings");
    fireEvent.click(await screen.findByRole("button", { name: /Remover projeto/ }));
    fireEvent.click(screen.getByRole("button", { name: /Confirmar remoção/ }));
    const aviso = await screen.findByTestId("removed-notice");
    expect(aviso).toHaveTextContent(/ficou para trás/);
    expect(aviso).toHaveTextContent("NÃO removido: pasta /data/x (permissão).");
    expect(aviso).not.toHaveTextContent(/foram apagados/);
  });

  it("a região role=status existe (vazia e não escondida) antes de qualquer aviso e é a mesma que recebe o aviso", async () => {
    post = async () => {
      world.p1 = "stopped";
      return { ok: true };
    };
    abrir();
    await screen.findByRole("heading", { name: /Alfa/ });
    const vazia = screen.getAllByRole("status").find((n) => n.textContent === "")!;
    expect(vazia).toBeTruthy();
    expect(vazia.className).not.toMatch(/empty:hidden/);
    expect(vazia.className).toMatch(/sr-only/);
    fireEvent.click(screen.getByRole("button", { name: "Parar" }));
    const aviso = await screen.findByTestId("action-notice");
    expect(vazia.contains(aviso)).toBe(true);
  });

  it("Dashboard também nasce com a região de anúncio", async () => {
    abrir("/");
    await screen.findByRole("heading", { name: /Projetos/ });
    expect(screen.getAllByRole("status").some((n) => n.textContent === "")).toBe(true);
  });

  it("\"iniciado\" só depois de estabilizar: se o projeto cai logo em seguida, não confirma", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    world.p1 = "stopped";
    let leituras = 0;
    post = async () => {
      world.p1 = "running";
      return { ok: true };
    };
    abrir();
    fireEvent.click(await screen.findByRole("button", { name: "Iniciar" }));
    onProjectGet = () => {
      leituras += 1;
      if (leituras === 1) world.p1 = "stopped"; // a leitura seguinte já vê o projeto parado
    };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40_000);
    });
    expect(screen.queryByText("Projeto iniciado.")).not.toBeInTheDocument();
    expect(screen.getByTestId("action-notice")).toHaveTextContent(/não confirmei/i);
  });

  it("aviso de sucesso é retirado (e trocado por um verdadeiro) quando o estado real muda depois", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    world.p1 = "stopped";
    abrir();
    fireEvent.click(await screen.findByRole("button", { name: "Iniciar" }));
    expect(await screen.findByText("Projeto iniciado.")).toBeInTheDocument();
    world.p1 = "stopped"; // outra aba parou o projeto
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000);
    });
    expect(screen.queryByText("Projeto iniciado.")).not.toBeInTheDocument();
    expect(screen.getByTestId("action-notice")).toHaveTextContent(/estado do projeto mudou/);
  });

  it("o mesmo para \"parado\" quando o projeto volta a rodar", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    abrir();
    fireEvent.click(await screen.findByRole("button", { name: "Parar" }));
    expect(await screen.findByText("Projeto parado.")).toBeInTheDocument();
    world.p1 = "running";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000);
    });
    expect(screen.queryByText("Projeto parado.")).not.toBeInTheDocument();
  });

  it("erro tem role=alert", async () => {
    post = async () => {
      throw new ApiRequestError(409, "no_containers", "Nenhum container.");
    };
    abrir();
    fireEvent.click(await screen.findByRole("button", { name: "Parar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Nenhum container/);
  });

  it("depois do sucesso o foco vai para o botão seguinte", async () => {
    abrir();
    fireEvent.click(await screen.findByRole("button", { name: "Parar" }));
    await screen.findByText("Projeto parado.");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Iniciar" })));
  });

  it("dois cliques síncronos (sem re-render entre eles) enviam um pedido só", async () => {
    post = async () => {
      await new Promise((r) => setTimeout(r, 20));
      world.p1 = "stopped";
      return { ok: true };
    };
    abrir();
    const botao = await screen.findByRole("button", { name: "Parar" });
    act(() => {
      botao.click();
      botao.click();
    });
    await screen.findByText("Projeto parado.");
    expect(posts()).toHaveLength(1);
  });

  it("estado \"parado\" na visão geral explica o que acontece com o site e que nada foi apagado", async () => {
    world.p1 = "stopped";
    abrir();
    expect(await screen.findByText(/nada foi apagado/)).toBeInTheDocument();
  });

  it("a explicação de Parar é texto visível, ligada aos botões (não só title)", async () => {
    abrir();
    const dica = await screen.findByTestId("lifecycle-hint");
    expect(dica).toHaveTextContent(/não exige parar antes/);
    const parar = screen.getByRole("button", { name: "Parar" });
    expect(parar).toHaveAttribute("aria-describedby", dica.id);
    expect(parar).not.toHaveAttribute("title");
  });

  it("rótulo de andamento legível (sem opacidade reduzida)", async () => {
    post = () => new Promise(() => undefined);
    abrir();
    fireEvent.click(await screen.findByRole("button", { name: "Parar" }));
    expect((await screen.findByRole("button", { name: /Parando…/ })).className).toMatch(/disabled:opacity-100/);
  });

  it("status erro e sem containers: Parar e Iniciar desabilitados, com explicação", async () => {
    world.p1 = "error";
    abrir();
    expect(await screen.findByRole("button", { name: "Parar" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Iniciar" })).toBeDisabled();
    expect(screen.getByTestId("lifecycle-hint")).toHaveTextContent(/não tem containers/);
  });

  it("timeout no pedido mas o projeto de fato parou: não fica \"Falha ao parar\"", async () => {
    post = async () => {
      world.p1 = "stopped";
      throw new ApiRequestError(502, "docker_stop_failed", "Falha ao parar containers: tempo esgotado");
    };
    abrir();
    fireEvent.click(await screen.findByRole("button", { name: "Parar" }));
    expect(await screen.findByText("Projeto parado.")).toBeInTheDocument();
    expect(screen.queryByTestId("action-error")).not.toBeInTheDocument();
  });

  it("projeto nunca publicado: o aviso fala em \"manutenção\", não em \"indisponível\"", async () => {
    flags.unpublished = true;
    abrir();
    fireEvent.click(await screen.findByRole("button", { name: "Parar" }));
    const aviso = await screen.findByTestId("action-notice");
    expect(aviso).toHaveTextContent(/em manutenção/);
    expect(aviso).not.toHaveTextContent(/indisponível/);
  });
});
