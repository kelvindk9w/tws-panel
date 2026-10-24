/**
 * project-logs-section.test.tsx — aba "Logs" do projeto: consulta, seletores,
 * atualização automática (relógio falso), filtro local, copiar, rolagem que
 * acompanha o fim, mensagens de estado e acessibilidade básica.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectLogLine, ProjectLogService, ProjectLogsResponse } from "@paas/core";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return { ...real, apiFetch: apiFetchMock };
});
const copyMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/clipboard", () => ({ copyText: copyMock }));

import { ApiRequestError } from "@/lib/api";
import { setLocale } from "@/i18n/core";
import { ProjectLogsSection } from "@/components/project/ProjectLogsSection";

const svc = (over: Partial<ProjectLogService> = {}): ProjectLogService => ({
  service: "api",
  container: "paas-fazenda-api-1",
  state: "running",
  status: "Up 3 hours",
  health: "healthy",
  restartCount: 0,
  startedAt: "2026-10-24T09:00:00Z",
  finishedAt: null,
  exitCode: null,
  logsError: null,
  ...over,
});

const line = (over: Partial<ProjectLogLine> = {}): ProjectLogLine => ({
  time: "2026-10-24T11:00:00Z",
  service: "api",
  container: "paas-fazenda-api-1",
  stream: "stdout",
  text: "servidor no ar",
  ...over,
});

function reply(over: Partial<ProjectLogsResponse> = {}): ProjectLogsResponse {
  return {
    service: null,
    tail: 200,
    since: null,
    services: [svc(), svc({ service: "web", container: "paas-fazenda-web-1", health: null })],
    lines: [line(), line({ stream: "stderr", text: "conexão recusada", time: "2026-10-24T11:00:05Z" }), line({ service: "web", text: "pronto" })],
    truncated: false,
    generatedAt: "2026-10-24T11:01:00Z",
    ...over,
  };
}

const urls = () => apiFetchMock.mock.calls.map((c) => c[0] as string);

beforeEach(() => {
  apiFetchMock.mockReset();
  copyMock.mockReset();
  apiFetchMock.mockResolvedValue(reply());
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function open() {
  return render(<ProjectLogsSection projectId="p1" />);
}

describe("ProjectLogsSection: consulta e exibição", () => {
  it("carrega ao abrir com 200 linhas e mostra o estado de cada serviço no topo", async () => {
    open();
    expect(await screen.findByText("servidor no ar")).toBeInTheDocument();
    expect(urls()[0]).toBe("/api/projects/p1/logs?tail=200");
    const list = screen.getByRole("list", { name: "Estado dos serviços" });
    const api = within(list).getAllByRole("listitem")[0]!;
    expect(api).toHaveTextContent("api");
    expect(api).toHaveTextContent("rodando");
    expect(api).toHaveTextContent("saudável");
    expect(api).toHaveTextContent("Reinícios: 0");
    expect(api).toHaveTextContent(/No ar desde/);
  });

  it("marca a saída de erro com texto (não só cor) e mostra a hora e o serviço", async () => {
    open();
    const box = await screen.findByRole("region", { name: "Linhas de log" });
    const err = within(box).getByText("conexão recusada").closest("[data-stream]")!;
    expect(err).toHaveAttribute("data-stream", "stderr");
    expect(err).toHaveTextContent("erro");
    expect(within(box).getByText("servidor no ar").closest("[data-stream]")).toHaveAttribute("data-stream", "stdout");
    expect(within(box).getAllByText("web").length).toBeGreaterThan(0);
  });

  it("serviço parado mostra código de saída e hora da parada; reinício sem parar fica explícito", async () => {
    apiFetchMock.mockResolvedValue(
      reply({
        services: [
          svc({ state: "exited", health: null, finishedAt: "2026-10-24T10:00:00Z", exitCode: 137 }),
          svc({ service: "worker", container: "w", state: "restarting", restartCount: 12, health: "unhealthy" }),
        ],
      }),
    );
    open();
    await screen.findByText("servidor no ar");
    const items = within(screen.getByRole("list", { name: "Estado dos serviços" })).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("parado");
    expect(items[0]).toHaveTextContent("Código de saída: 137");
    expect(items[0]).toHaveTextContent(/Parou em/);
    expect(items[1]).toHaveTextContent("reiniciando sem parar");
    expect(items[1]).toHaveTextContent("com problema");
    expect(items[1]).toHaveTextContent("Reinícios: 12");
  });

  it("estado que o painel não conhece cai em 'estado desconhecido'", async () => {
    apiFetchMock.mockResolvedValue(reply({ services: [svc({ state: "removing" })] }));
    open();
    await screen.findByText("servidor no ar");
    expect(screen.getByRole("list", { name: "Estado dos serviços" })).toHaveTextContent("estado desconhecido");
  });

  it("falha de leitura de um serviço aparece no estado dele", async () => {
    apiFetchMock.mockResolvedValue(reply({ services: [svc({ logsError: "too_large" }), svc({ service: "web", container: "w", logsError: "unavailable" })] }));
    open();
    await screen.findByText("servidor no ar");
    expect(screen.getByText(/grande demais/)).toBeInTheDocument();
    expect(screen.getByText(/Não foi possível ler o log deste serviço/)).toBeInTheDocument();
  });

  it("aviso quando linhas ficaram de fora pelo limite", async () => {
    apiFetchMock.mockResolvedValue(reply({ truncated: true }));
    open();
    expect(await screen.findByText(/ficaram de fora pelo limite/)).toBeInTheDocument();
  });

  it("mostra a contagem e a hora da última atualização numa região educada para leitor de tela", async () => {
    open();
    await screen.findByText("servidor no ar");
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(/Mostrando 3 de 3 linhas\. Atualizado às \d{2}:\d{2}:\d{2}\./);
    expect(status).toHaveAttribute("aria-live", "polite");
  });
});

describe("ProjectLogsSection: seletores e atualizar", () => {
  it("seletor de serviço lista 'Todos' e os serviços; escolher consulta só aquele", async () => {
    open();
    await screen.findByText("servidor no ar");
    const sel = screen.getByLabelText("Serviço") as HTMLSelectElement;
    expect([...sel.options].map((o) => o.textContent)).toEqual(["Todos os serviços", "api", "web"]);
    fireEvent.change(sel, { target: { value: "web" } });
    await waitFor(() => expect(urls().at(-1)).toBe("/api/projects/p1/logs?tail=200&service=web"));
  });

  it("serviço escolhido que sumiu do projeto volta para 'Todos'", async () => {
    open();
    await screen.findByText("servidor no ar");
    fireEvent.change(screen.getByLabelText("Serviço"), { target: { value: "web" } });
    await waitFor(() => expect(urls()).toHaveLength(2));
    apiFetchMock.mockResolvedValue(reply({ service: "web", services: [svc()] }));
    fireEvent.click(screen.getByRole("button", { name: "Atualizar" }));
    await waitFor(() => expect((screen.getByLabelText("Serviço") as HTMLSelectElement).value).toBe(""));
  });

  it("linhas e período entram na consulta", async () => {
    open();
    await screen.findByText("servidor no ar");
    const tail = screen.getByLabelText("Linhas") as HTMLSelectElement;
    expect([...tail.options].map((o) => o.value)).toEqual(["100", "200", "500", "1000", "2000"]);
    fireEvent.change(tail, { target: { value: "500" } });
    await waitFor(() => expect(urls().at(-1)).toBe("/api/projects/p1/logs?tail=500"));
    const since = screen.getByLabelText("Período") as HTMLSelectElement;
    expect([...since.options].map((o) => o.value)).toEqual(["", "15m", "1h", "24h"]);
    fireEvent.change(since, { target: { value: "15m" } });
    await waitFor(() => expect(urls().at(-1)).toBe("/api/projects/p1/logs?tail=500&since=15m"));
  });

  it("o botão Atualizar consulta de novo", async () => {
    open();
    await screen.findByText("servidor no ar");
    fireEvent.click(screen.getByRole("button", { name: "Atualizar" }));
    await waitFor(() => expect(urls()).toHaveLength(2));
  });

  it("resposta atrasada de uma consulta antiga não sobrescreve a mais nova", async () => {
    let releaseOld: (v: ProjectLogsResponse) => void = () => undefined;
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementationOnce(() => new Promise<ProjectLogsResponse>((r) => (releaseOld = r)));
    apiFetchMock.mockResolvedValueOnce(reply({ lines: [line({ text: "linha nova" })] }));
    open();
    fireEvent.change(screen.getByLabelText("Linhas"), { target: { value: "500" } });
    expect(await screen.findByText("linha nova")).toBeInTheDocument();
    await act(async () => releaseOld(reply({ lines: [line({ text: "linha velha" })] })));
    expect(screen.queryByText("linha velha")).not.toBeInTheDocument();
    expect(screen.getByText("linha nova")).toBeInTheDocument();
  });
});

describe("ProjectLogsSection: atualização automática (relógio falso)", () => {
  async function tick(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  it("vem ligada a cada 10 s; desligar para; ligar de novo volta", async () => {
    vi.useFakeTimers();
    open();
    await tick(0);
    expect(urls()).toHaveLength(1);
    await tick(9_999);
    expect(urls()).toHaveLength(1);
    await tick(1);
    expect(urls()).toHaveLength(2);
    const auto = screen.getByLabelText("Atualizar automaticamente") as HTMLInputElement;
    expect(auto.checked).toBe(true);
    fireEvent.click(auto);
    await tick(60_000);
    expect(urls()).toHaveLength(2);
    fireEvent.click(auto);
    await tick(10_000);
    expect(urls()).toHaveLength(3);
  });

  it("o intervalo escolhido vale: 5, 10, 30 e 60 s", async () => {
    vi.useFakeTimers();
    open();
    await tick(0);
    const interval = screen.getByLabelText("Intervalo") as HTMLSelectElement;
    expect([...interval.options].map((o) => o.value)).toEqual(["5", "10", "30", "60"]);
    fireEvent.change(interval, { target: { value: "5" } });
    // a consulta já marcada (10 s) corre; as seguintes seguem o intervalo novo
    await tick(10_000);
    const n = urls().length;
    await tick(5_000);
    expect(urls().length).toBe(n + 1);
  });

  it("sem rede nas consultas automáticas, a tela segue tentando e mostra o erro sem apagar as linhas", async () => {
    vi.useFakeTimers();
    open();
    await tick(0);
    apiFetchMock.mockRejectedValue(new ApiRequestError(500, "internal_error", "boom"));
    await tick(10_000);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("servidor no ar")).toBeInTheDocument();
    apiFetchMock.mockResolvedValue(reply());
    await tick(10_000);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("ProjectLogsSection: filtro local e copiar", () => {
  it("filtra sem consultar o servidor e conta as linhas", async () => {
    open();
    await screen.findByText("servidor no ar");
    const before = urls().length;
    fireEvent.change(screen.getByLabelText("Filtrar (nas linhas mostradas)"), { target: { value: "RECUSADA" } });
    expect(screen.getByText("conexão recusada")).toBeInTheDocument();
    expect(screen.queryByText("servidor no ar")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Mostrando 1 de 3 linhas (filtro ativo)");
    expect(urls()).toHaveLength(before);
  });

  it("filtro sem resultado diz que nada combina", async () => {
    open();
    await screen.findByText("servidor no ar");
    fireEvent.change(screen.getByLabelText("Filtrar (nas linhas mostradas)"), { target: { value: "zzz" } });
    expect(screen.getByText("Nenhuma linha combina com o filtro.")).toBeInTheDocument();
  });

  it("copiar leva só as linhas que estão na tela (com o filtro) e confirma", async () => {
    copyMock.mockResolvedValue(true);
    open();
    await screen.findByText("servidor no ar");
    fireEvent.change(screen.getByLabelText("Filtrar (nas linhas mostradas)"), { target: { value: "recusada" } });
    fireEvent.click(screen.getByRole("button", { name: "Copiar linhas" }));
    await waitFor(() => expect(copyMock).toHaveBeenCalledWith("2026-10-24T11:00:05Z api [stderr] conexão recusada"));
    expect(await screen.findByRole("button", { name: "Copiado" })).toBeInTheDocument();
  });

  it("copiar que falha avisa", async () => {
    copyMock.mockResolvedValue(false);
    open();
    await screen.findByText("servidor no ar");
    fireEvent.click(screen.getByRole("button", { name: "Copiar linhas" }));
    expect(await screen.findByText("Não foi possível copiar")).toBeInTheDocument();
  });

  it("sem linhas, copiar fica desligado", async () => {
    apiFetchMock.mockResolvedValue(reply({ lines: [] }));
    open();
    await screen.findByText("Nenhuma linha de log ainda.");
    expect(screen.getByRole("button", { name: "Copiar linhas" })).toBeDisabled();
  });
});

describe("ProjectLogsSection: rolagem que acompanha o fim", () => {
  function metrics(scrollHeight: number) {
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => scrollHeight });
  }
  afterEach(() => {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollHeight;
  });

  it("vem ligada: depois de carregar, a caixa vai para o fim", async () => {
    metrics(5000);
    open();
    const box = await screen.findByRole("region", { name: "Linhas de log" });
    await waitFor(() => expect(box.scrollTop).toBe(5000));
    expect((screen.getByLabelText("Acompanhar o fim") as HTMLInputElement).checked).toBe(true);
  });

  it("desligada, a rolagem fica onde está", async () => {
    metrics(5000);
    open();
    const box = await screen.findByRole("region", { name: "Linhas de log" });
    fireEvent.click(screen.getByLabelText("Acompanhar o fim"));
    box.scrollTop = 10;
    fireEvent.click(screen.getByRole("button", { name: "Atualizar" }));
    await waitFor(() => expect(urls()).toHaveLength(2));
    await screen.findByText("servidor no ar");
    expect(box.scrollTop).toBe(10);
  });

  it("subir a rolagem desliga o acompanhar; voltar ao fim liga de novo", async () => {
    metrics(5000);
    open();
    const box = await screen.findByRole("region", { name: "Linhas de log" });
    await waitFor(() => expect(box.scrollTop).toBe(5000));
    Object.defineProperty(box, "clientHeight", { configurable: true, get: () => 300 });
    box.scrollTop = 100;
    fireEvent.scroll(box);
    expect((screen.getByLabelText("Acompanhar o fim") as HTMLInputElement).checked).toBe(false);
    box.scrollTop = 4700;
    fireEvent.scroll(box);
    expect((screen.getByLabelText("Acompanhar o fim") as HTMLInputElement).checked).toBe(true);
  });

  it("a caixa é alcançável pelo teclado (rolagem com setas)", async () => {
    open();
    const box = await screen.findByRole("region", { name: "Linhas de log" });
    expect(box).toHaveAttribute("tabindex", "0");
  });
});

describe("ProjectLogsSection: mensagens", () => {
  it("projeto sem container: diz para fazer o deploy", async () => {
    apiFetchMock.mockResolvedValue(reply({ services: [], lines: [] }));
    open();
    expect(await screen.findByText("Este projeto ainda não tem containers. Faça um deploy para ver os logs.")).toBeInTheDocument();
  });

  it("projeto parado: avisa e ainda mostra o que escreveu antes", async () => {
    apiFetchMock.mockResolvedValue(reply({ services: [svc({ state: "exited", health: null })] }));
    open();
    expect(await screen.findByText(/O projeto está parado/)).toBeInTheDocument();
    expect(screen.getByText("servidor no ar")).toBeInTheDocument();
  });

  it("sem logs: mensagem simples, e com período escolhido sugere um período maior", async () => {
    apiFetchMock.mockResolvedValue(reply({ lines: [] }));
    open();
    expect(await screen.findByText("Nenhuma linha de log ainda.")).toBeInTheDocument();
    apiFetchMock.mockResolvedValue(reply({ lines: [], since: "15m" }));
    fireEvent.change(screen.getByLabelText("Período"), { target: { value: "15m" } });
    expect(await screen.findByText("Nenhuma linha neste período. Tente um período maior.")).toBeInTheDocument();
  });

  it("Docker indisponível: mensagem clara, sem lista velha", async () => {
    apiFetchMock.mockRejectedValue(new ApiRequestError(503, "docker_unavailable", "não foi possível listar containers via Docker (socket /x)"));
    open();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("O Docker não está respondendo");
    expect(alert).not.toHaveTextContent("/x");
    expect(screen.queryByRole("region", { name: "Linhas de log" })).not.toBeInTheDocument();
  });

  it("proteção de segredos indisponível e erro genérico têm texto próprio", async () => {
    apiFetchMock.mockRejectedValue(new ApiRequestError(503, "log_masking_unavailable", "x"));
    open();
    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível proteger os segredos");
    cleanup();
    apiFetchMock.mockRejectedValue(new Error("rede caiu"));
    open();
    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível carregar os logs.");
  });

  it("o texto do log é exibido como texto (nada de HTML interpretado)", async () => {
    apiFetchMock.mockResolvedValue(reply({ lines: [line({ text: "<img src=x onerror=alert(1)>" })] }));
    open();
    const el = await screen.findByText("<img src=x onerror=alert(1)>");
    expect(el.querySelector("img")).toBeNull();
  });

  it("em inglês: mesmos controles e mensagens traduzidas", async () => {
    setLocale("en", { persist: false });
    apiFetchMock.mockResolvedValue(reply({ services: [], lines: [] }));
    open();
    expect(await screen.findByText("This project has no containers yet. Deploy it to see the logs.")).toBeInTheDocument();
    expect(screen.getByLabelText("Service")).toBeInTheDocument();
    expect(screen.getByLabelText("Follow the end")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
  });

  it("muda de projeto: consulta o novo e esquece o antigo", async () => {
    const { rerender } = open();
    await screen.findByText("servidor no ar");
    apiFetchMock.mockResolvedValue(reply({ lines: [line({ text: "do outro projeto" })] }));
    rerender(<ProjectLogsSection projectId="p2" />);
    expect(await screen.findByText("do outro projeto")).toBeInTheDocument();
    expect(urls().at(-1)).toBe("/api/projects/p2/logs?tail=200");
  });
});
