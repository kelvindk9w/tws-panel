/**
 * Página "Logs do servidor": fontes, consulta com os parâmetros escolhidos, mensagens por código de erro,
 * filtro local, copiar, sem atualização automática por padrão e aviso de fonte do host indisponível.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectLogLine, ProjectLogService, ServerLogsResponse } from "@paas/core";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return { ...real, apiFetch: apiFetchMock };
});
const copyMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/clipboard", () => ({ copyText: copyMock }));

import { ApiRequestError } from "@/lib/api";
import { setLocale } from "@/i18n/core";
import { ServerLogsPage } from "@/pages/ServerLogsPage";

const svc = (over: Partial<ProjectLogService> = {}): ProjectLogService => ({
  service: "panel",
  container: "tws-panel",
  state: "running",
  status: "Up",
  health: null,
  restartCount: 1,
  startedAt: "2026-10-24T09:00:00Z",
  finishedAt: null,
  exitCode: null,
  logsError: null,
  ...over,
});
const line = (over: Partial<ProjectLogLine> = {}): ProjectLogLine => ({
  time: "2026-10-24T11:00:00Z",
  service: "panel",
  container: "tws-panel",
  stream: "stdout",
  text: "painel no ar",
  ...over,
});
function reply(over: Partial<ServerLogsResponse> = {}): ServerLogsResponse {
  return {
    service: null,
    tail: 200,
    since: null,
    services: [svc(), svc({ service: "proxy", container: "paas-caddy", restartCount: null })],
    lines: [line(), line({ service: "proxy", stream: "stderr", text: "erro no proxy" })],
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

describe("ServerLogsPage", () => {
  it("carrega todos os containers por padrão e lista as fontes com nomes amigáveis", async () => {
    render(<ServerLogsPage />);
    expect(await screen.findByText("painel no ar")).toBeInTheDocument();
    expect(urls()[0]).toBe("/api/server-logs?tail=200");
    const source = screen.getByLabelText("Fonte") as HTMLSelectElement;
    expect([...source.options].map((o) => o.textContent)).toEqual([
      "Painel, proxy e e-mail (containers)",
      "Painel",
      "Proxy (Caddy)",
      "Servidor de e-mail",
      "Docker da VPS",
      "SSH da VPS",
    ]);
    expect(screen.getByTestId("server-log-source-panel")).toHaveTextContent("rodando");
    expect(screen.getByTestId("server-log-source-proxy")).toHaveTextContent("Proxy (Caddy)");
    expect(screen.getByText(/melhor esforço/)).toBeInTheDocument();
    expect(screen.getByText(/endereços IP/)).toBeInTheDocument();
  });

  it("em inglês usa os nomes em inglês", async () => {
    setLocale("en", { persist: false });
    render(<ServerLogsPage />);
    await screen.findByText("painel no ar");
    const source = screen.getByLabelText("Source") as HTMLSelectElement;
    expect([...source.options].map((o) => o.textContent)).toContain("VPS SSH");
    expect(screen.getByText("Server logs")).toBeInTheDocument();
  });

  it("consulta com a fonte, as linhas e o período escolhidos", async () => {
    render(<ServerLogsPage />);
    await screen.findByText("painel no ar");
    fireEvent.change(screen.getByLabelText("Fonte"), { target: { value: "ssh" } });
    await waitFor(() => expect(urls().at(-1)).toBe("/api/server-logs?tail=200&source=ssh"));
    fireEvent.change(screen.getByLabelText("Linhas"), { target: { value: "2000" } });
    await waitFor(() => expect(urls().at(-1)).toBe("/api/server-logs?tail=2000&source=ssh"));
    fireEvent.change(screen.getByLabelText("Período"), { target: { value: "1h" } });
    await waitFor(() => expect(urls().at(-1)).toBe("/api/server-logs?tail=2000&source=ssh&since=1h"));
    const tails = [...(screen.getByLabelText("Linhas") as HTMLSelectElement).options].map((o) => o.value);
    expect(tails).toEqual(["100", "200", "500", "1000", "2000"]);
  });

  it("botão Atualizar consulta de novo", async () => {
    render(<ServerLogsPage />);
    await screen.findByText("painel no ar");
    fireEvent.click(screen.getByRole("button", { name: /Atualizar/ }));
    await waitFor(() => expect(urls()).toHaveLength(2));
  });

  it.each([
    ["docker_unavailable", 503, /Docker não está respondendo/],
    ["log_masking_unavailable", 503, /proteger os segredos/],
    ["logs_busy", 429, /leituras de logs demais/],
    ["source_not_found", 404, /fonte de logs não foi encontrada/],
    ["invalid_source", 400, /pedido de logs é inválido/],
    ["invalid_log_query", 400, /pedido de logs é inválido/],
    ["invalid_request", 400, /pedido de logs é inválido/],
    ["rate_limited", 429, /Muitas leituras em pouco tempo/],
    ["boom", 500, /Não foi possível carregar os logs/],
  ])("erro %s mostra a mensagem traduzida", async (code, status, text) => {
    apiFetchMock.mockRejectedValue(new ApiRequestError(status, code, "x"));
    render(<ServerLogsPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent(text);
  });

  it("erro que não é da API também cai na mensagem genérica", async () => {
    apiFetchMock.mockRejectedValue(new Error("rede"));
    render(<ServerLogsPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/Não foi possível carregar/);
  });

  it("filtra localmente sem consultar e avisa quando nada combina", async () => {
    render(<ServerLogsPage />);
    await screen.findByText("painel no ar");
    const n = urls().length;
    fireEvent.change(screen.getByLabelText(/Filtrar/), { target: { value: "proxy" } });
    expect(screen.queryByText("painel no ar")).not.toBeInTheDocument();
    expect(screen.getByText("erro no proxy")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Filtrar/), { target: { value: "zzz" } });
    expect(screen.getByText("Nenhuma linha combina com o filtro.")).toBeInTheDocument();
    expect(urls()).toHaveLength(n);
  });

  it("copia as linhas mostradas e informa a falha de cópia", async () => {
    copyMock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    render(<ServerLogsPage />);
    await screen.findByText("painel no ar");
    fireEvent.click(screen.getByRole("button", { name: /Copiar linhas/ }));
    expect(await screen.findByRole("button", { name: /Copiado/ })).toBeInTheDocument();
    expect(copyMock.mock.calls[0]![0]).toContain("painel no ar");
    fireEvent.click(screen.getByRole("button", { name: /Copiado/ }));
    expect(await screen.findByText("Não foi possível copiar")).toBeInTheDocument();
  });

  it("fonte do host indisponível explica que só existe na VPS instalada", async () => {
    apiFetchMock.mockResolvedValue(
      reply({ services: [svc({ service: "ssh", container: "", state: "journal", status: "", restartCount: null, startedAt: null, logsError: "unavailable" })], lines: [] }),
    );
    render(<ServerLogsPage />);
    const box = await screen.findByTestId("server-log-source-ssh");
    expect(box).toHaveTextContent("SSH da VPS");
    expect(box).toHaveTextContent("registro da VPS");
    expect(box).toHaveTextContent(/só estão disponíveis no painel instalado na VPS/);
    expect(screen.getByRole("note")).toHaveTextContent(/painel instalado na VPS/);
    expect(screen.getByText("Nenhuma linha de log ainda.")).toBeInTheDocument();
  });

  it("erro de tamanho, fonte de container indisponível, parada e fonte desconhecida", async () => {
    apiFetchMock.mockResolvedValue(
      reply({
        since: "1h",
        truncated: true,
        services: [
          svc({ logsError: "too_large" }),
          svc({ service: "mail", container: "m", state: "exited", restartCount: 0, logsError: "unavailable" }),
          svc({ service: "novo", container: "n", state: "removing", restartCount: null }),
        ],
        lines: [],
      }),
    );
    render(<ServerLogsPage />);
    await screen.findByTestId("server-log-source-novo");
    expect(screen.getByTestId("server-log-source-panel")).toHaveTextContent(/grande demais/);
    expect(screen.getByTestId("server-log-source-mail")).toHaveTextContent(/Não foi possível ler o log deste serviço/);
    expect(screen.getByTestId("server-log-source-novo")).toHaveTextContent("estado desconhecido");
    expect(screen.getByText(/ficaram de fora pelo limite/)).toBeInTheDocument();
    expect(screen.getByText(/Nenhuma linha neste período/)).toBeInTheDocument();
  });

  it("com uma só fonte não repete o nome dela em cada linha", async () => {
    apiFetchMock.mockResolvedValue(reply({ services: [svc()], lines: [line()] }));
    render(<ServerLogsPage />);
    const box = await screen.findByRole("region", { name: "Linhas de log" });
    expect(within(box).queryByText("panel")).not.toBeInTheDocument();
    fireEvent.scroll(box);
  });

  describe("atualização automática", () => {
    async function tick(ms: number) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    }

    it("vem DESLIGADA; ligar atualiza no intervalo escolhido; desligar para", async () => {
      vi.useFakeTimers();
      render(<ServerLogsPage />);
      await tick(0);
      expect(urls()).toHaveLength(1);
      await tick(120_000);
      expect(urls()).toHaveLength(1);
      const auto = screen.getByLabelText(/Atualizar automaticamente/) as HTMLInputElement;
      expect(auto.checked).toBe(false);
      expect((screen.getByLabelText("Intervalo") as HTMLSelectElement).disabled).toBe(true);
      fireEvent.click(auto);
      await tick(30_000);
      expect(urls().length).toBeGreaterThanOrEqual(2);
      const n = urls().length;
      fireEvent.click(auto);
      await tick(60_000);
      expect(urls()).toHaveLength(n);
    });
  });
});
