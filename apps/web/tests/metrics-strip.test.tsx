/**
 * metrics-strip.test.tsx — a faixa de semáforos do Dashboard: valores de agora,
 * "sem dados" (nunca zero), avisos de coleta, links dos projetos com problema,
 * erros de leitura e atualização automática.
 */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MetricsSummaryResponse } from "@paas/core";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return { ...real, apiFetch: apiFetchMock };
});

import { ApiRequestError } from "@/lib/api";
import { setLocale } from "@/i18n/core";
import { MetricsStrip } from "@/components/metrics/MetricsStrip";

const T = Date.parse("2026-10-24T12:00:00Z");
const spark = (vals: number[]) => vals.map((v, i) => ({ t: T / 1000 - 86400 + i * 900, v, max: v }));

function summary(over: Partial<MetricsSummaryResponse> = {}): MetricsSummaryResponse {
  return {
    generatedAt: new Date(T).toISOString(),
    collector: { mode: "full", hostSource: "mounted", containerSource: "cgroup", lastTickAt: new Date(T - 20_000).toISOString(), lastError: null, retention: { minuteHours: 48, hourDays: 90, dayDays: 730 } },
    cpu: { level: "ok", spark: spark([10, 20, 30]), busyPct: 23.4, stealPct: 0.2, psi: 1, cores: 4 },
    memory: { level: "ok", spark: spark([40, 41]), usedPct: 40, availBytes: 5 * 1024 ** 3, totalBytes: 8 * 1024 ** 3, swapUsedBytes: 0, psi: 0, oomKills24h: 0 },
    disk: { level: "ok", spark: spark([50, 51]), usedPct: 51, freeBytes: 40 * 1024 ** 3, inodePct: 8, daysToFull: null },
    network: { level: "ok", spark: spark([100, 200]), rxBytesPerSecond: 2048, txBytesPerSecond: 512 },
    projects: { level: "ok", spark: [], running: 2, total: 3, problems: [], problemCount: 0 },
    protections: { level: "ok", certificates: { total: 4, problems: 0 }, backups: { destinationConnected: true, lastFailure: false } },
    ...over,
  };
}

const projects = [
  { slug: "loja", id: "p-loja", name: "Loja Virtual" },
  { slug: "blog", id: "p-blog", name: "Blog" },
];

function show() {
  return render(
    <MemoryRouter>
      <MetricsStrip projects={projects} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  setLocale("pt-BR");
  apiFetchMock.mockReset();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const card = (id: string) => screen.getByTestId(`metric-${id}`);

describe("faixa de semáforos", () => {
  it("mostra os seis cartões com valor de agora, selo e miniatura de 24 h", async () => {
    apiFetchMock.mockResolvedValue(summary());
    show();
    expect(await screen.findByTestId("metric-cpu")).toBeInTheDocument();
    expect(apiFetchMock).toHaveBeenCalledWith("/api/metrics/summary", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(card("cpu")).toHaveTextContent("23% em uso");
    expect(card("cpu")).toHaveTextContent("4 núcleos");
    expect(card("memory")).toHaveTextContent("Disponível: 5 GB de 8 GB");
    expect(card("disk")).toHaveTextContent("51% usado");
    expect(card("disk")).toHaveTextContent("Livre: 40 GB");
    expect(card("network")).toHaveTextContent("Entrada 2 KB/s · Saída 512 B/s");
    expect(card("projects")).toHaveTextContent("2 de 3 rodando");
    expect(card("projects")).toHaveTextContent("Nenhum com problema");
    expect(card("protections")).toHaveTextContent("Certificados: todos em ordem (4)");
    expect(card("protections")).toHaveTextContent("Backup externo conectado");
    for (const id of ["cpu", "memory", "disk", "network", "protections", "projects"]) expect(within(card(id)).getByText("Normal")).toBeInTheDocument();
    expect(card("protections")).toHaveTextContent("Certificados e backups em ordem");
    // miniaturas com descrição em texto
    expect(within(card("cpu")).getByRole("img")).toHaveAttribute("aria-label", expect.stringContaining("Processador, últimas 24 horas"));
    // sem steal/pressão relevantes não polui o cartão
    expect(card("cpu")).not.toHaveTextContent("Tomado pelo provedor");
    expect(card("memory")).not.toHaveTextContent("Swap");
  });

  it("detalhes só quando importam: steal ≥ 1%, pressão ≥ 5%, swap, inodes ≥ 50%, mortes por memória, previsão do disco", async () => {
    apiFetchMock.mockResolvedValue(
      summary({
        cpu: { level: "warning", spark: [], busyPct: 90, stealPct: 6.5, psi: 30, cores: 2 },
        memory: { level: "critical", spark: [], usedPct: 95, availBytes: 100 * 1024 ** 2, totalBytes: 8 * 1024 ** 3, swapUsedBytes: 512 * 1024 ** 2, psi: 25, oomKills24h: 2 },
        disk: { level: "warning", spark: [], usedPct: 85, freeBytes: 5 * 1024 ** 3, inodePct: 60, daysToFull: { low: 12, high: 20 } },
      }),
    );
    show();
    await screen.findByTestId("metric-cpu");
    expect(card("cpu")).toHaveTextContent("Tomado pelo provedor: 6,5%");
    expect(card("cpu")).toHaveTextContent("Espera por CPU: 30%");
    expect(card("cpu")).toHaveTextContent("Atenção");
    expect(card("memory")).toHaveTextContent("Espera por memória: 25%");
    expect(card("memory")).toHaveTextContent("Swap em uso: 512 MB");
    expect(card("memory")).toHaveTextContent("2 processos mortos por falta de memória nas últimas 24 horas");
    expect(card("memory")).toHaveTextContent("Crítico");
    expect(card("disk")).toHaveTextContent("Inodes em uso: 60%");
    expect(card("disk")).toHaveTextContent("enche em cerca de 12 a 20 dias");
  });

  it("um único processo morto usa o singular; disco no limite avisa", async () => {
    apiFetchMock.mockResolvedValue(
      summary({
        memory: { level: "critical", spark: [], usedPct: 50, availBytes: 1, totalBytes: 2, swapUsedBytes: null, psi: null, oomKills24h: 1 },
        disk: { level: "critical", spark: [], usedPct: 99, freeBytes: 1, inodePct: null, daysToFull: { low: 0, high: 0 } },
      }),
    );
    show();
    await screen.findByTestId("metric-cpu");
    expect(card("memory")).toHaveTextContent("1 processo morto por falta de memória nas últimas 24 horas");
    expect(card("disk")).toHaveTextContent("o disco já está no limite");
  });

  it("o que não foi medido aparece como 'sem dados', nunca como zero", async () => {
    apiFetchMock.mockResolvedValue(
      summary({
        collector: { mode: "unavailable", hostSource: "none", containerSource: "none", lastTickAt: null, lastError: null, retention: { minuteHours: 48, hourDays: 90, dayDays: 730 } },
        cpu: { level: "unknown", spark: [], busyPct: null, stealPct: null, psi: null, cores: null },
        memory: { level: "unknown", spark: [], usedPct: null, availBytes: null, totalBytes: null, swapUsedBytes: null, psi: null, oomKills24h: 0 },
        disk: { level: "unknown", spark: [], usedPct: null, freeBytes: null, inodePct: null, daysToFull: null },
        network: { level: "unknown", spark: [], rxBytesPerSecond: null, txBytesPerSecond: null },
        projects: { level: "unknown", spark: [], running: 0, total: 0, problems: [], problemCount: 0 },
        protections: { level: "unknown", certificates: null, backups: null },
      }),
    );
    show();
    await screen.findByTestId("metric-cpu");
    for (const id of ["cpu", "memory", "disk", "projects", "protections"]) {
      expect(card(id)).toHaveTextContent("Sem dados");
      expect(card(id)).not.toHaveTextContent(/\b0%/);
    }
    expect(card("network")).toHaveTextContent("Sem medida de rede do servidor");
    expect(card("network")).not.toHaveTextContent("0 B");
    expect(screen.getAllByTestId("spark-empty")).toHaveLength(4);
    expect(card("protections")).toHaveTextContent("Sem informação");
    expect(screen.getByTestId("metrics-collecting")).toHaveTextContent("primeiras medidas");
  });

  it("projetos com problema: nome com link para a aba Recursos, motivos em texto; slug desconhecido aparece como está", async () => {
    apiFetchMock.mockResolvedValue(
      summary({
        projects: {
          level: "critical",
          spark: [],
          running: 1,
          total: 3,
          problemCount: 3,
          problems: [
            { slug: "loja", services: ["web"], reasons: ["restarting", "oom"] },
            { slug: "blog", services: ["app"], reasons: ["unhealthy"] },
            { slug: "outro", services: ["x"], reasons: ["exited_with_error"] },
          ],
        },
      }),
    );
    show();
    await screen.findByTestId("metric-projects");
    const c = card("projects");
    expect(c).toHaveTextContent("3 projetos com problema");
    const link = within(c).getByRole("link", { name: "Ver recursos de Loja Virtual" });
    expect(link).toHaveAttribute("href", "/projects/p-loja/resources");
    expect(c).toHaveTextContent("reiniciando sem parar, morto por falta de memória");
    expect(c).toHaveTextContent("não passa na verificação de saúde");
    expect(within(c).queryByRole("link", { name: /outro/ })).toBeNull();
    expect(c).toHaveTextContent("outro");
    expect(c).toHaveTextContent("Crítico");
  });

  it("um projeto com problema usa o singular", async () => {
    apiFetchMock.mockResolvedValue(summary({ projects: { level: "warning", spark: [], running: 1, total: 1, problemCount: 1, problems: [{ slug: "blog", services: ["a"], reasons: ["unhealthy"] }] } }));
    show();
    await screen.findByTestId("metric-projects");
    expect(card("projects")).toHaveTextContent("1 projeto com problema");
  });

  it("proteções: certificado com problema, backup só na VPS e cópia externa que falhou, com links", async () => {
    apiFetchMock.mockResolvedValue(summary({ protections: { level: "critical", certificates: { total: 4, problems: 1 }, backups: { destinationConnected: false, lastFailure: false } } }));
    show();
    await screen.findByTestId("metric-protections");
    const c = card("protections");
    expect(c).toHaveTextContent("Certificados: 1 com problema de 4");
    expect(c).toHaveTextContent("Backups só na VPS");
    expect(within(c).getByRole("link", { name: "Ver certificados" })).toHaveAttribute("href", "/certificates");
    expect(within(c).getByRole("link", { name: "Ver backups" })).toHaveAttribute("href", "/settings/backups");
    cleanup();
    apiFetchMock.mockResolvedValue(summary({ protections: { level: "critical", certificates: null, backups: { destinationConnected: true, lastFailure: true } } }));
    show();
    await waitFor(() => expect(card("protections")).toHaveTextContent("A última cópia externa falhou"));
  });
});

describe("avisos da coleta", () => {
  const collector = (over: Partial<MetricsSummaryResponse["collector"]>) => ({ ...summary().collector, ...over });

  it("modo reduzido explica o que fazer (recriar o container)", async () => {
    apiFetchMock.mockResolvedValue(summary({ collector: collector({ mode: "reduced", hostSource: "container" }) }));
    show();
    const box = await screen.findByTestId("metrics-reduced");
    expect(box).toHaveTextContent("modo reduzido");
    expect(box).toHaveTextContent("docker compose up -d --build");
  });

  it("último erro de coleta em português claro, para cada motivo conhecido e para um desconhecido", async () => {
    for (const [code, text] of [
      ["host_unreadable", "Não foi possível ler as medidas do servidor"],
      ["docker_unavailable", "O Docker não respondeu"],
      ["disk_write", "gravação das medidas falhou"],
      ["unexpected", "erro inesperado"],
      ["algo_novo", "erro inesperado"],
    ] as const) {
      apiFetchMock.mockResolvedValue(summary({ collector: collector({ lastError: code }) }));
      const { unmount } = show();
      expect(await screen.findByTestId("metrics-error")).toHaveTextContent(text);
      unmount();
    }
  });

  it("mostra a hora da última coleta", async () => {
    apiFetchMock.mockResolvedValue(summary());
    show();
    await screen.findByTestId("metric-cpu");
    expect(screen.getByTestId("metrics-strip")).toHaveTextContent("Última coleta:");
  });
});

describe("erros de leitura e atualização", () => {
  it("falha na primeira leitura: mensagem; 403: mensagem própria; resposta que não é o semáforo: mesma mensagem de falha", async () => {
    apiFetchMock.mockRejectedValue(new ApiRequestError(500, "x", "x"));
    show();
    expect(await screen.findByText("Não foi possível ler o monitoramento agora.")).toBeInTheDocument();
    cleanup();
    apiFetchMock.mockRejectedValue(new ApiRequestError(403, "token_forbidden", "x"));
    show();
    expect(await screen.findByText("Este usuário não pode ver o monitoramento da VPS.")).toBeInTheDocument();
    cleanup();
    apiFetchMock.mockResolvedValue({ containers: [] });
    show();
    expect(await screen.findByText("Não foi possível ler o monitoramento agora.")).toBeInTheDocument();
    cleanup();
    apiFetchMock.mockResolvedValue(null);
    show();
    expect(await screen.findByText("Não foi possível ler o monitoramento agora.")).toBeInTheDocument();
  });

  it("enquanto carrega mostra 'Carregando'", async () => {
    apiFetchMock.mockReturnValue(new Promise(() => undefined));
    show();
    expect(screen.getByText("Carregando as medidas…")).toBeInTheDocument();
  });

  it("falha numa atualização mantém os números da última leitura e avisa", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    apiFetchMock.mockResolvedValueOnce(summary());
    show();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(card("cpu")).toHaveTextContent("23% em uso");
    apiFetchMock.mockRejectedValue(new ApiRequestError(502, "x", "x"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(card("cpu")).toHaveTextContent("23% em uso");
    expect(screen.getByText("Não foi possível ler o monitoramento agora.")).toBeInTheDocument();
  });

  it("atualiza sozinha a cada 30 s e pausa com a aba oculta", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    apiFetchMock.mockResolvedValue(summary());
    show();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
  });

  it("ao sair da tela, a consulta em andamento é cancelada", async () => {
    let signal: AbortSignal | undefined;
    apiFetchMock.mockImplementation((_u: string, init: { signal: AbortSignal }) => {
      signal = init.signal;
      return new Promise(() => undefined);
    });
    const { unmount } = show();
    unmount();
    expect(signal?.aborted).toBe(true);
  });

  it("resposta velha que chega depois da nova é descartada", async () => {
    let first!: (v: MetricsSummaryResponse) => void;
    apiFetchMock.mockImplementationOnce(() => new Promise((r) => (first = r)));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    show();
    apiFetchMock.mockResolvedValueOnce(summary({ cpu: { level: "ok", spark: [], busyPct: 77, stealPct: 0, psi: 0, cores: 1 } }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(card("cpu")).toHaveTextContent("77% em uso");
    await act(async () => first(summary({ cpu: { level: "ok", spark: [], busyPct: 5, stealPct: 0, psi: 0, cores: 1 } })));
    expect(card("cpu")).toHaveTextContent("77% em uso");
  });
});

describe("inglês", () => {
  it("textos e formatação de número no idioma escolhido", async () => {
    setLocale("en");
    apiFetchMock.mockResolvedValue(summary({ cpu: { level: "warning", spark: [], busyPct: 23.4, stealPct: 6.5, psi: 1, cores: 1 } }));
    show();
    await screen.findByTestId("metric-cpu");
    expect(card("cpu")).toHaveTextContent("23% in use");
    expect(card("cpu")).toHaveTextContent("1 cores");
    expect(card("cpu")).toHaveTextContent("Taken by the provider: 6.5%");
    expect(card("cpu")).toHaveTextContent("Attention");
    expect(screen.getByRole("heading", { name: "VPS health" })).toBeInTheDocument();
  });
});
