/**
 * metrics-settings.test.tsx — Configurações → Recursos da VPS: estado da
 * coleta, espaço usado e retenção (limites, ordem, confirmação ao reduzir).
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { METRICS_RETENTION_DEFAULT, METRICS_RETENTION_LIMITS, type MetricsSettingsResponse } from "@paas/core";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return { ...real, apiFetch: apiFetchMock };
});

import { ApiRequestError } from "@/lib/api";
import { setLocale } from "@/i18n/core";
import { MetricsSettings } from "@/pages/settings/MetricsSettings";

function settings(over: Partial<MetricsSettingsResponse> = {}): MetricsSettingsResponse {
  return {
    retention: { ...METRICS_RETENTION_DEFAULT },
    defaults: { ...METRICS_RETENTION_DEFAULT },
    limits: METRICS_RETENTION_LIMITS,
    usage: { minuteBytes: 10 * 1024 ** 2, hourBytes: 2 * 1024 ** 2, dayBytes: 512 * 1024 },
    collector: { mode: "full", hostSource: "mounted", containerSource: "cgroup", lastTickAt: "2026-10-24T12:00:00Z", lastError: null, retention: { ...METRICS_RETENTION_DEFAULT } },
    ...over,
  };
}

const field = (name: RegExp) => screen.getByLabelText(name) as HTMLInputElement;
const type = (name: RegExp, value: string) => fireEvent.change(field(name), { target: { value } });
const save = () => screen.getByRole("button", { name: /^(Salvar|Confirmar)/ });

beforeEach(() => {
  setLocale("pt-BR");
  apiFetchMock.mockReset();
});
afterEach(cleanup);

describe("menu", () => {
  it("'Recursos da VPS' aparece no menu de Configurações, em português e em inglês", async () => {
    const { SETTINGS_SECTIONS } = await import("@/pages/settings/SettingsLayout");
    expect(SETTINGS_SECTIONS.find((s) => s.to === "/settings/metrics")?.label).toBe("Recursos da VPS");
    setLocale("en");
    expect(SETTINGS_SECTIONS.find((s) => s.to === "/settings/metrics")?.label).toBe("VPS resources");
  });
});

describe("carregar", () => {
  it("mostra estado da coleta, espaço usado e a retenção atual com os limites", async () => {
    apiFetchMock.mockResolvedValue(settings());
    render(<MetricsSettings />);
    expect(await screen.findByTestId("metrics-collector-state")).toHaveTextContent("Coleta completa");
    expect(screen.getByTestId("metrics-usage")).toHaveTextContent("12,5 MB no total: 10 MB por minuto, 2 MB por hora, 512 KB por dia.");
    expect(field(/Medidas de cada minuto/).value).toBe("48");
    expect(field(/Médias de cada hora/).value).toBe("90");
    expect(field(/Médias de cada dia/).value).toBe("730");
    expect(field(/Medidas de cada minuto/)).toHaveAttribute("min", "24");
    expect(field(/Medidas de cada minuto/)).toHaveAttribute("max", "168");
    expect(screen.getByText(/De 24 a 168 horas; padrão 48/)).toBeInTheDocument();
    expect(save()).toBeDisabled(); // nada mudou
  });

  it("modo reduzido e coleta que ainda não aconteceu", async () => {
    apiFetchMock.mockResolvedValue(settings({ collector: { ...settings().collector, mode: "reduced" } }));
    render(<MetricsSettings />);
    expect(await screen.findByTestId("metrics-collector-state")).toHaveTextContent("docker compose up -d --build");
    cleanup();
    apiFetchMock.mockResolvedValue(settings({ collector: { ...settings().collector, mode: "unavailable", lastTickAt: null } }));
    render(<MetricsSettings />);
    expect(await screen.findByTestId("metrics-collector-state")).toHaveTextContent("primeira coleta ainda não aconteceu");
  });

  it("carregando e erro de leitura", async () => {
    apiFetchMock.mockReturnValue(new Promise(() => undefined));
    render(<MetricsSettings />);
    expect(screen.getByText("Carregando…")).toBeInTheDocument();
    cleanup();
    apiFetchMock.mockRejectedValue(new ApiRequestError(500, "x", "x"));
    render(<MetricsSettings />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível carregar a configuração.");
  });
});

describe("salvar", () => {
  it("aumentar um prazo salva direto (sem confirmação) e mostra o resultado do servidor", async () => {
    apiFetchMock.mockResolvedValueOnce(settings());
    render(<MetricsSettings />);
    await screen.findByTestId("metrics-usage");
    type(/Medidas de cada minuto/, "72");
    expect(screen.queryByTestId("metrics-shrink-warning")).toBeNull();
    apiFetchMock.mockResolvedValueOnce(settings({ retention: { minuteHours: 72, hourDays: 90, dayDays: 730 } }));
    fireEvent.click(save());
    expect(await screen.findByText("Retenção salva.")).toBeInTheDocument();
    expect(apiFetchMock).toHaveBeenLastCalledWith("/api/metrics/settings", { method: "PUT", body: JSON.stringify({ retention: { minuteHours: 72, hourDays: 90, dayDays: 730 } }) });
    expect(field(/Medidas de cada minuto/).value).toBe("72");
    expect(save()).toBeDisabled();
  });

  it("reduzir pede confirmação: o primeiro clique só avisa; Cancelar volta; Confirmar salva", async () => {
    apiFetchMock.mockResolvedValueOnce(settings());
    render(<MetricsSettings />);
    await screen.findByTestId("metrics-usage");
    type(/Médias de cada hora/, "30");
    expect(screen.getByTestId("metrics-shrink-warning")).toHaveTextContent("apaga agora o que passar do novo limite");
    fireEvent.click(save());
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Confirmar e apagar o excedente" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("button", { name: "Confirmar e apagar o excedente" })).toBeNull();
    fireEvent.click(save());
    apiFetchMock.mockResolvedValueOnce(settings({ retention: { minuteHours: 48, hourDays: 30, dayDays: 730 } }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar e apagar o excedente" }));
    expect(await screen.findByText("Retenção salva.")).toBeInTheDocument();
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
  });

  it("mexer num campo depois do primeiro clique desfaz a confirmação", async () => {
    apiFetchMock.mockResolvedValueOnce(settings());
    render(<MetricsSettings />);
    await screen.findByTestId("metrics-usage");
    type(/Médias de cada hora/, "30");
    fireEvent.click(save());
    type(/Médias de cada hora/, "31");
    expect(screen.queryByRole("button", { name: "Confirmar e apagar o excedente" })).toBeNull();
  });

  it("valor fora dos limites, decimal ou vazio: não deixa salvar e diz o motivo", async () => {
    apiFetchMock.mockResolvedValueOnce(settings());
    render(<MetricsSettings />);
    await screen.findByTestId("metrics-usage");
    for (const bad of ["23", "169", "48.5", ""]) {
      type(/Medidas de cada minuto/, bad);
      expect(save()).toBeDisabled();
      if (bad !== "") expect(screen.getByRole("alert")).toHaveTextContent("fora dos limites");
    }
    expect(field(/Medidas de cada minuto/)).toHaveAttribute("aria-invalid", "false"); // vazio ainda não é marcado como inválido
    type(/Medidas de cada minuto/, "23");
    expect(field(/Medidas de cada minuto/)).toHaveAttribute("aria-invalid", "true");
  });

  it("dia menor que hora: aviso próprio, sem salvar", async () => {
    apiFetchMock.mockResolvedValueOnce(settings());
    render(<MetricsSettings />);
    await screen.findByTestId("metrics-usage");
    type(/Médias de cada hora/, "365");
    type(/Médias de cada dia/, "100");
    expect(screen.getByRole("alert")).toHaveTextContent("O prazo por dia não pode ser menor que o prazo por hora");
    expect(save()).toBeDisabled();
  });

  it("erros do servidor: ordem, valor inválido e falha genérica", async () => {
    apiFetchMock.mockResolvedValueOnce(settings());
    render(<MetricsSettings />);
    await screen.findByTestId("metrics-usage");
    type(/Medidas de cada minuto/, "72");
    for (const [code, text] of [
      ["retention_order", "prazo por dia não pode ser menor"],
      ["invalid_retention", "fora dos limites"],
      ["invalid_request", "fora dos limites"],
      ["storage_write_failed", "Nada foi alterado"],
    ] as const) {
      apiFetchMock.mockRejectedValueOnce(new ApiRequestError(400, code, "x"));
      fireEvent.click(save());
      await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(text));
    }
    apiFetchMock.mockRejectedValueOnce(new Error("rede"));
    fireEvent.click(save());
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Nada foi alterado"));
    expect(field(/Medidas de cada minuto/).value).toBe("72"); // o que a pessoa digitou fica
  });

  it("Voltar ao padrão preenche os campos (só salva se a pessoa clicar em Salvar)", async () => {
    apiFetchMock.mockResolvedValueOnce(settings({ retention: { minuteHours: 72, hourDays: 30, dayDays: 365 } }));
    render(<MetricsSettings />);
    await screen.findByTestId("metrics-usage");
    fireEvent.click(screen.getByRole("button", { name: "Voltar ao padrão" }));
    expect(field(/Medidas de cada minuto/).value).toBe("48");
    expect(field(/Médias de cada dia/).value).toBe("730");
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(save()).not.toBeDisabled();
  });

  it("inglês", async () => {
    setLocale("en");
    apiFetchMock.mockResolvedValue(settings());
    render(<MetricsSettings />);
    expect(await screen.findByTestId("metrics-collector-state")).toHaveTextContent("Full collection");
    expect(screen.getByText("Per-minute measurements (in hours)")).toBeInTheDocument();
  });
});
