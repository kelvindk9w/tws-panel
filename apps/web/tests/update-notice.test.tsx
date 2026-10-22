/**
 * Alerta de "nova atualização do projeto" (só aviso): componente, aba Git, topo da página do
 * projeto e Dashboard, em pt-BR e en, com os estados de carregando/erro/vazio. O clique leva ao
 * Deploy que já existe; nada publica sozinho.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectUpdateStatus, UpdateErrorReason, UpdateState } from "@paas/core";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return { ...real, apiFetch: apiFetchMock };
});

import { setLocale } from "../src/i18n";
import { UpdateBadge, UpdateNotice, UpdateSummary } from "../src/components/project/UpdateNotice";
import { DashboardPage } from "../src/pages/DashboardPage";
import { ProjectDetailPage } from "../src/pages/ProjectDetailPage";
import { UPDATE_STATUS_MAX_RETRIES, UPDATE_STATUS_REFRESH_MS, UPDATE_STATUS_RETRY_MS } from "../src/lib/update-status";

function status(state: UpdateState, extra: Partial<ProjectUpdateStatus> = {}): ProjectUpdateStatus {
  return {
    projectId: "p1",
    state,
    branch: "main",
    remoteCommit: state === "update_available" || state === "up_to_date" ? "bbbbbbb" : null,
    deployedCommit: "aaaaaaa",
    reason: null,
    checkedAt: "2026-10-22T10:00:00.000Z",
    ...extra,
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("UpdateNotice — banner (topo do projeto)", () => {
  it("só aparece com atualização disponível, com a branch, o commit e o botão", () => {
    const onDeploy = vi.fn();
    render(<UpdateNotice variant="banner" status={status("update_available")} onDeploy={onDeploy} />);
    const aviso = screen.getByRole("status");
    expect(aviso).toHaveTextContent("Nova atualização disponível na branch main (commit bbbbbbb)");
    fireEvent.click(within(aviso).getByRole("button", { name: /Fazer o deploy/ }));
    expect(onDeploy).toHaveBeenCalledTimes(1);
  });

  it.each(["up_to_date", "checking", "unknown", "never_deployed", "config_changed", "error", "not_applicable"] as const)(
    "estado %s não mostra nada no topo",
    (state) => {
      const { container } = render(<UpdateNotice variant="banner" status={status(state)} onDeploy={() => undefined} />);
      expect(container).toBeEmptyDOMElement();
    },
  );

  it("sem resposta ainda: nada", () => {
    const { container } = render(<UpdateNotice variant="banner" status={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("o botão respeita deployDisabled", () => {
    render(<UpdateNotice variant="banner" status={status("update_available")} onDeploy={() => undefined} deployDisabled />);
    expect(screen.getByRole("button", { name: /Fazer o deploy/ })).toBeDisabled();
  });

  it("layout estreito: o texto quebra linha e não estoura a largura (flex-wrap, min-w-0, break-words)", () => {
    render(<UpdateNotice variant="banner" status={status("update_available", { branch: "feature/uma-branch-com-nome-muito-longo-mesmo" })} onDeploy={() => undefined} />);
    const aviso = screen.getByTestId("update-banner-project");
    expect(aviso.className).toContain("flex-wrap");
    expect(aviso.querySelector("span")?.className).toMatch(/min-w-0.*break-words/);
  });
});

describe("UpdateNotice — aba Git (todos os estados)", () => {
  it("atualização disponível: aviso, botão de deploy, Verificar agora, hora e a dica", () => {
    const onDeploy = vi.fn();
    const onCheck = vi.fn();
    render(<UpdateNotice variant="full" status={status("update_available")} onDeploy={onDeploy} onCheck={onCheck} />);
    expect(screen.getByRole("status")).toHaveTextContent("Nova atualização disponível na branch main");
    fireEvent.click(screen.getByRole("button", { name: /Fazer o deploy/ }));
    fireEvent.click(screen.getByRole("button", { name: "Verificar agora" }));
    expect(onDeploy).toHaveBeenCalledTimes(1);
    expect(onCheck).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Última verificação:/)).toBeInTheDocument();
    expect(screen.getByText(/Para atualizar o código, clique em Deploy/)).toBeInTheDocument();
  });

  it("atualizado: confirma a branch e o commit, sem botão de deploy", () => {
    render(<UpdateNotice variant="full" status={status("up_to_date")} onDeploy={() => undefined} onCheck={() => undefined} />);
    expect(screen.getByRole("status")).toHaveTextContent("Atualizado: o que está no ar é o commit mais recente da branch main (aaaaaaa)");
    expect(screen.queryByRole("button", { name: /Fazer o deploy/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Verificar agora" })).toBeEnabled();
  });

  it("verificando e primeira leitura: mensagem de carregando", () => {
    const { rerender } = render(<UpdateNotice variant="full" status={null} />);
    expect(screen.getByRole("status")).toHaveTextContent("Verificando se há atualização…");
    rerender(<UpdateNotice variant="full" status={status("checking")} />);
    expect(screen.getByRole("status")).toHaveTextContent("Verificando se há atualização…");
  });

  it("o painel não respondeu: 'não deu para verificar', e diz que isso não é 'atualizado'", () => {
    render(<UpdateNotice variant="full" status={null} failed />);
    expect(screen.getByRole("status")).toHaveTextContent(/Não deu para verificar se há atualização agora/);
    expect(screen.getByRole("status")).toHaveTextContent(/não quer dizer que o código está atualizado/);
  });

  it("desconhecido (projeto antigo): explica, sem oferecer deploy", () => {
    render(<UpdateNotice variant="full" status={status("unknown", { deployedCommit: null })} onDeploy={() => undefined} />);
    expect(screen.getByRole("status")).toHaveTextContent(/ainda não foi registrado/);
    expect(screen.queryByRole("button", { name: /Fazer o deploy/ })).not.toBeInTheDocument();
  });

  it("nunca implantado: orienta o primeiro deploy e não oferece 'Verificar agora'", () => {
    render(<UpdateNotice variant="full" status={status("never_deployed", { deployedCommit: null })} onCheck={() => undefined} />);
    expect(screen.getByRole("status")).toHaveTextContent("Faça o primeiro deploy para publicar o código da branch main");
    expect(screen.queryByRole("button", { name: "Verificar agora" })).not.toBeInTheDocument();
  });

  it("configuração diferente da que está no ar", () => {
    render(<UpdateNotice variant="full" status={status("config_changed")} />);
    expect(screen.getByRole("status")).toHaveTextContent(/diferentes dos que estão no ar/);
  });

  it("sem repositório", () => {
    render(<UpdateNotice variant="full" status={status("not_applicable", { branch: null })} onCheck={() => undefined} />);
    expect(screen.getByRole("status")).toHaveTextContent(/não usa repositório/);
    expect(screen.queryByRole("button", { name: "Verificar agora" })).not.toBeInTheDocument();
  });

  it.each([
    ["unreachable", /Não foi possível falar com o servidor do repositório/],
    ["timeout", /demorou demais/],
    ["auth", /token está errado ou expirou/],
    ["no_permission", /não tem permissão de leitura/],
    ["not_found", /Repositório não encontrado/],
    ["branch_not_found", /A branch feature\/x não existe no repositório/],
    ["redirected", /redireciona para outro lugar/],
    ["blocked_host", /própria máquina/],
    ["unsupported", /protocolo que o painel não suporta/],
    ["unknown", /não reconheceu/],
  ] as Array<[UpdateErrorReason, RegExp]>)("erro %s: motivo em texto fixo, sem parecer 'atualizado'", (reason, texto) => {
    render(<UpdateNotice variant="full" status={status("error", { reason, branch: "feature/x", remoteCommit: null })} onCheck={() => undefined} />);
    const aviso = screen.getByRole("status");
    expect(aviso).toHaveTextContent("Não deu para verificar se há atualização.");
    expect(aviso).toHaveTextContent(texto);
    expect(screen.queryByText(/^Atualizado/)).not.toBeInTheDocument();
  });

  it("erro sem motivo conhecido usa o genérico", () => {
    render(<UpdateNotice variant="full" status={status("error", { reason: null })} />);
    expect(screen.getByRole("status")).toHaveTextContent(/não reconheceu/);
  });

  it("Verificar agora desabilita enquanto verifica", () => {
    render(<UpdateNotice variant="full" status={status("up_to_date")} onCheck={() => undefined} checking />);
    expect(screen.getByRole("button", { name: "Verificar agora" })).toBeDisabled();
  });
});

describe("UpdateNotice em inglês", () => {
  beforeEach(() => setLocale("en", { persist: false }));

  it("aviso, estados e erro sem chave crua", () => {
    const { rerender } = render(<UpdateNotice variant="banner" status={status("update_available")} onDeploy={() => undefined} />);
    expect(screen.getByRole("status")).toHaveTextContent("A new update is available on branch main (commit bbbbbbb)");
    expect(screen.getByRole("button", { name: /Deploy now/ })).toBeInTheDocument();
    rerender(<UpdateNotice variant="full" status={status("error", { reason: "branch_not_found", branch: "dev" })} onCheck={() => undefined} />);
    expect(screen.getByRole("status")).toHaveTextContent("Branch dev does not exist in the repository.");
    expect(screen.getByRole("button", { name: "Check now" })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\b(projects|dashboard)\.update\./);
  });
});

describe("Dashboard — peças", () => {
  it("resumo: singular e plural, com links para os projetos", () => {
    const { rerender } = render(
      <MemoryRouter>
        <UpdateSummary items={[{ id: "a", name: "Loja", branch: "main" }]} />
      </MemoryRouter>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("1 projeto com atualização disponível");
    expect(screen.getByRole("link", { name: "Loja" })).toHaveAttribute("href", "/projects/a");
    rerender(
      <MemoryRouter>
        <UpdateSummary
          items={[
            { id: "a", name: "Loja", branch: "main" },
            { id: "b", name: "Loja sandbox", branch: "sandbox" },
          ]}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("2 projetos com atualização disponível");
    expect(screen.getByText("(sandbox)")).toBeInTheDocument();
  });

  it("resumo vazio não renderiza nada", () => {
    const { container } = render(
      <MemoryRouter>
        <UpdateSummary items={[]} />
      </MemoryRouter>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("indicador por projeto leva ao projeto", () => {
    render(
      <MemoryRouter>
        <UpdateBadge projectId="p9" branch={null} />
      </MemoryRouter>,
    );
    const link = screen.getByRole("link", { name: /Atualização disponível/ });
    expect(link).toHaveAttribute("href", "/projects/p9");
    expect(link).toHaveAttribute("title", expect.stringContaining("main"));
  });
});

// ---------------------------------------------------------------------------
// Páginas inteiras
// ---------------------------------------------------------------------------

const PROJECT = {
  id: "p1",
  name: "devLink",
  slug: "devlink",
  ingestMode: "git",
  source: "https://github.com/example/devLink",
  branch: "main",
  domain: "devlink.example.com",
  websocket: false,
  detection: { type: "static", composeFile: null, outputDir: null, packageManager: null, buildCommand: null, proxyService: null, proxyPort: null, warnings: [], details: [] },
  proxyService: null,
  proxyPort: null,
  createdAt: "2026-09-30T10:00:00Z",
  updatedAt: "2026-09-30T10:00:00Z",
  lastDeployAt: "2026-09-30T10:05:00Z",
  lastDeployStatus: "success",
  deployedBranch: "main",
  deployedSource: "https://github.com/example/devLink",
  deployedCommit: "a".repeat(40),
};

let projectStatus: string;
let updateResponse: () => unknown;
let calls: Array<{ path: string; method: string }>;

function mockApi() {
  apiFetchMock.mockImplementation(async (path: string, init?: { method?: string }) => {
    calls.push({ path, method: init?.method ?? "GET" });
    if (path === "/api/projects/p1") {
      return { project: PROJECT, status: projectStatus, containers: [], url: "https://devlink.example.com", credential: { configured: false, hint: null, username: null, updatedAt: null } };
    }
    if (path === "/api/projects/p1/jobs") return { jobs: [] };
    if (path === "/api/projects/p1/repo-visibility") return { visibility: "public" };
    if (path === "/api/projects/p1/guardrails") return { report: null };
    if (path === "/api/projects/p1/deploy") return { job: { id: "j1", projectId: "p1", status: "running", createdAt: "x", startedAt: "x", finishedAt: null, steps: [], log: "", error: null } };
    if (path === "/api/projects/p1/update-status") return updateResponse();
    if (path === "/api/projects/p1/update-status/check") return { status: status("up_to_date") };
    if (path === "/api/projects/update-status") return updateResponse();
    return {};
  });
}

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

beforeEach(() => {
  apiFetchMock.mockReset();
  calls = [];
  projectStatus = "running";
  updateResponse = () => ({ status: status("update_available") });
  mockApi();
});

describe("página do projeto — topo", () => {
  it("mostra o aviso junto dos botões e o clique usa o fluxo de Deploy existente (guardrails e depois deploy)", async () => {
    abrir();
    const aviso = await screen.findByTestId("update-banner-project");
    expect(aviso).toHaveTextContent("Nova atualização disponível na branch main");
    fireEvent.click(within(aviso).getByRole("button", { name: /Fazer o deploy/ }));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/projects/p1/deploy" && c.method === "POST")).toBe(true));
    // passou pela verificação de guardrails antes, como o botão Deploy do topo
    const paths = calls.map((c) => c.path);
    expect(paths.indexOf("/api/projects/p1/guardrails")).toBeLessThan(paths.indexOf("/api/projects/p1/deploy"));
  });

  it("nada é publicado só por abrir a página ou por o aviso aparecer", async () => {
    abrir();
    await screen.findByTestId("update-banner-project");
    expect(calls.some((c) => c.path === "/api/projects/p1/deploy")).toBe(false);
  });

  it("projeto parado: sem aviso", async () => {
    projectStatus = "stopped";
    abrir();
    await screen.findByRole("link", { name: /Abrir site/ });
    await waitFor(() => expect(calls.some((c) => c.path === "/api/projects/p1/update-status")).toBe(true));
    expect(screen.queryByTestId("update-banner-project")).not.toBeInTheDocument();
  });

  it("atualizado ou falha da consulta: o topo fica em silêncio", async () => {
    updateResponse = () => ({ status: status("up_to_date") });
    abrir();
    await screen.findByRole("link", { name: /Abrir site/ });
    await waitFor(() => expect(calls.some((c) => c.path === "/api/projects/p1/update-status")).toBe(true));
    expect(screen.queryByTestId("update-banner-project")).not.toBeInTheDocument();
  });

  it("o botão Deploy do topo explica o que faz (tooltip e descrição para leitor de tela)", async () => {
    abrir();
    const botao = await screen.findByRole("button", { name: /^Deploy$/ });
    expect(botao).toHaveAttribute("title", expect.stringContaining("Busca o código novo da branch configurada"));
    expect(botao).toHaveAccessibleDescription(/Busca o código novo da branch configurada/);
  });

  it("projeto sem repositório (upload) não consulta nem avisa", async () => {
    const original = { ...PROJECT };
    (PROJECT as { ingestMode: string }).ingestMode = "upload";
    try {
      abrir();
      await screen.findByRole("link", { name: /Abrir site/ });
      expect(calls.some((c) => c.path.includes("update-status"))).toBe(false);
      expect(screen.queryByTestId("update-banner-project")).not.toBeInTheDocument();
    } finally {
      Object.assign(PROJECT, original);
    }
  });
});

describe("página do projeto — aba Git", () => {
  it("mostra o aviso completo (sem duplicar o do topo), a dica de Deploy e o botão", async () => {
    abrir("/projects/p1/git");
    const cartao = await screen.findByTestId("update-notice-git");
    expect(cartao).toHaveTextContent("Nova atualização disponível na branch main");
    expect(cartao).toHaveTextContent("Para atualizar o código, clique em Deploy");
    expect(screen.queryByTestId("update-banner-project")).not.toBeInTheDocument();
    fireEvent.click(within(cartao).getByRole("button", { name: /Fazer o deploy/ }));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/projects/p1/deploy" && c.method === "POST")).toBe(true));
  });

  it("Verificar agora faz o POST e atualiza o estado", async () => {
    abrir("/projects/p1/git");
    const cartao = await screen.findByTestId("update-notice-git");
    fireEvent.click(within(cartao).getByRole("button", { name: "Verificar agora" }));
    await waitFor(() => expect(screen.getByTestId("update-notice-git")).toHaveTextContent("Atualizado: o que está no ar"));
    expect(calls).toContainEqual({ path: "/api/projects/p1/update-status/check", method: "POST" });
  });

  it("Verificar agora que falha mostra 'não deu para verificar', não 'atualizado'", async () => {
    abrir("/projects/p1/git");
    const cartao = await screen.findByTestId("update-notice-git");
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === "/api/projects/p1/update-status/check") throw new Error("429");
      return {};
    });
    fireEvent.click(within(cartao).getByRole("button", { name: "Verificar agora" }));
    await waitFor(() => expect(screen.getByTestId("update-notice-git")).toHaveTextContent(/Não deu para verificar/));
  });

  it("falha na leitura inicial: 'não deu para verificar'", async () => {
    updateResponse = () => {
      throw new Error("rede");
    };
    abrir("/projects/p1/git");
    expect(await screen.findByText(/o painel não respondeu/)).toBeInTheDocument();
  });

  it("resposta fora do formato também é tratada como falha", async () => {
    updateResponse = () => ({});
    abrir("/projects/p1/git");
    expect(await screen.findByText(/o painel não respondeu/)).toBeInTheDocument();
  });

  it("em inglês, o aviso e o tooltip do Deploy saem em inglês", async () => {
    setLocale("en", { persist: false });
    abrir("/projects/p1/git");
    expect(await screen.findByTestId("update-notice-git")).toHaveTextContent("A new update is available on branch main");
    expect(screen.getByRole("button", { name: /^Deploy$/ })).toHaveAttribute("title", expect.stringContaining("Fetches the new code"));
  });
});

describe("recargas do estado", () => {
  it("'verificando' relê em poucos segundos e para depois do limite; depois relê de tempos em tempos", async () => {
    vi.useFakeTimers();
    let n = 0;
    updateResponse = () => {
      n += 1;
      return { status: status(n >= 3 ? "update_available" : "checking") };
    };
    abrir("/projects/p1/git");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(screen.getByTestId("update-notice-git")).toHaveTextContent("Verificando");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UPDATE_STATUS_RETRY_MS * 2 + 10);
    });
    expect(screen.getByTestId("update-notice-git")).toHaveTextContent("Nova atualização disponível");
    const reads = () => calls.filter((c) => c.path === "/api/projects/p1/update-status").length;
    const antes = reads();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UPDATE_STATUS_REFRESH_MS + 10);
    });
    expect(reads()).toBe(antes + 1);
  });

  it("servidor que nunca termina de verificar não vira laço infinito", async () => {
    vi.useFakeTimers();
    updateResponse = () => ({ status: status("checking") });
    abrir("/projects/p1/git");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    for (let i = 0; i < UPDATE_STATUS_MAX_RETRIES + 3; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(UPDATE_STATUS_RETRY_MS);
      });
    }
    const reads = calls.filter((c) => c.path === "/api/projects/p1/update-status").length;
    expect(reads).toBeGreaterThan(UPDATE_STATUS_MAX_RETRIES);
    expect(reads).toBeLessThanOrEqual(UPDATE_STATUS_MAX_RETRIES + 2);
  });

  it("falha da leitura tenta de novo só no intervalo longo", async () => {
    vi.useFakeTimers();
    updateResponse = () => {
      throw new Error("rede");
    };
    abrir("/projects/p1/git");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UPDATE_STATUS_RETRY_MS * 3);
    });
    expect(calls.filter((c) => c.path === "/api/projects/p1/update-status")).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UPDATE_STATUS_REFRESH_MS);
    });
    expect(calls.filter((c) => c.path === "/api/projects/p1/update-status")).toHaveLength(2);
  });
});

describe("Dashboard — com a lista de projetos", () => {
  const item = (id: string, name: string, st: string) => ({
    project: { ...PROJECT, id, name, domain: `${id}.example.com` },
    status: st,
    containers: [],
    url: `https://${id}.example.com`,
    credential: { configured: false, hint: null, username: null, updatedAt: null },
  });

  function mockDashboard(statuses: unknown, projects = [item("p1", "Loja", "running"), item("p2", "Loja sandbox", "running"), item("p3", "Parado", "stopped")]) {
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === "/api/projects") return { projects };
      if (path === "/api/projects/update-status") {
        if (statuses instanceof Error) throw statuses;
        return statuses;
      }
      if (path === "/api/docker/containers") return { containers: [] };
      return {};
    });
  }
  const renderDashboard = () =>
    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );

  it("cartão com a contagem, links e indicador só nos projetos no ar com atualização (parado fica de fora)", async () => {
    mockDashboard({
      statuses: [
        status("update_available", { projectId: "p1", branch: "main" }),
        status("up_to_date", { projectId: "p2", branch: "sandbox" }),
        status("update_available", { projectId: "p3", branch: "main" }),
      ],
    });
    renderDashboard();
    const resumo = await screen.findByTestId("update-summary");
    expect(resumo).toHaveTextContent("1 projeto com atualização disponível");
    expect(within(resumo).getByRole("link", { name: "Loja" })).toHaveAttribute("href", "/projects/p1");
    expect(within(resumo).queryByText("Parado")).not.toBeInTheDocument();
    expect(screen.getByTestId("update-badge-p1")).toBeInTheDocument();
    expect(screen.queryByTestId("update-badge-p2")).not.toBeInTheDocument();
    expect(screen.queryByTestId("update-badge-p3")).not.toBeInTheDocument();
  });

  it("branches diferentes do mesmo repositório: cada projeto mostra o seu", async () => {
    mockDashboard({
      statuses: [
        status("update_available", { projectId: "p1", branch: "main" }),
        status("update_available", { projectId: "p2", branch: "sandbox" }),
      ],
    });
    renderDashboard();
    const resumo = await screen.findByTestId("update-summary");
    expect(resumo).toHaveTextContent("2 projetos com atualização disponível");
    expect(resumo).toHaveTextContent("(main)");
    expect(resumo).toHaveTextContent("(sandbox)");
  });

  it("nenhuma atualização: sem cartão e sem indicador", async () => {
    mockDashboard({ statuses: [status("up_to_date", { projectId: "p1" })] });
    renderDashboard();
    await screen.findByText("Loja");
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith("/api/projects/update-status"));
    expect(screen.queryByTestId("update-summary")).not.toBeInTheDocument();
  });

  it("falha na consulta de atualizações: avisa que não deu para verificar (e que isso não é 'atualizado')", async () => {
    mockDashboard(new Error("rede"));
    renderDashboard();
    expect(await screen.findByText(/Não deu para verificar atualizações agora/)).toBeInTheDocument();
    expect(screen.queryByTestId("update-summary")).not.toBeInTheDocument();
  });

  it("resposta fora do formato também vale como falha", async () => {
    mockDashboard({});
    renderDashboard();
    expect(await screen.findByText(/Não deu para verificar atualizações agora/)).toBeInTheDocument();
  });

  it("sem projetos: não mostra aviso de falha", async () => {
    mockDashboard(new Error("rede"), []);
    renderDashboard();
    await screen.findByText("Nenhum projeto ainda");
    expect(screen.queryByText(/Não deu para verificar atualizações agora/)).not.toBeInTheDocument();
  });

  it("'verificando' no Dashboard relê em poucos segundos", async () => {
    vi.useFakeTimers();
    let n = 0;
    mockDashboard({});
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === "/api/projects") return { projects: [item("p1", "Loja", "running")] };
      if (path === "/api/projects/update-status") {
        n += 1;
        return { statuses: [status(n >= 2 ? "update_available" : "checking", { projectId: "p1" })] };
      }
      return { containers: [] };
    });
    renderDashboard();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UPDATE_STATUS_RETRY_MS + 100);
    });
    expect(screen.getByTestId("update-summary")).toBeInTheDocument();
  });

  it("em inglês", async () => {
    setLocale("en", { persist: false });
    mockDashboard({ statuses: [status("update_available", { projectId: "p1" })] });
    renderDashboard();
    expect(await screen.findByTestId("update-summary")).toHaveTextContent("1 project has an update available");
    expect(screen.getByText("Update available")).toBeInTheDocument();
  });
});
