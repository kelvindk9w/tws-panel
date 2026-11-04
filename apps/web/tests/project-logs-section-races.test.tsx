/**
 * project-logs-section-races.test.tsx — aba Logs: corridas entre consultas
 * (manual lenta + tique automático), troca de projeto e erro de consulta manual.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectLogLine, ProjectLogsResponse } from "@paas/core";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return { ...real, apiFetch: apiFetchMock };
});

import { ApiRequestError } from "@/lib/api";
import { ProjectLogsSection } from "@/components/project/ProjectLogsSection";

const line = (text: string): ProjectLogLine => ({ time: "2026-10-24T11:00:00Z", service: "api", container: "c", stream: "stdout", text });

function reply(...texts: string[]): ProjectLogsResponse {
  return {
    service: null,
    tail: 200,
    since: null,
    services: [
      { service: "api", container: "c", state: "running", status: "Up", health: null, restartCount: 0, startedAt: null, finishedAt: null, exitCode: null, logsError: null },
      { service: "web", container: "w", state: "running", status: "Up", health: null, restartCount: 0, startedAt: null, finishedAt: null, exitCode: null, logsError: null },
    ],
    lines: texts.map(line),
    truncated: false,
    generatedAt: "2026-10-24T11:01:00Z",
  };
}

const urls = () => apiFetchMock.mock.calls.map((c) => c[0] as string);
const refreshButton = () => screen.getByRole("button", { name: "Atualizar" });

beforeEach(() => {
  apiFetchMock.mockReset();
  apiFetchMock.mockResolvedValue(reply("servidor no ar"));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("ProjectLogsSection: corridas", () => {
  it("consulta manual lenta + tique automático: o botão Atualizar volta a ficar ativo", async () => {
    vi.useFakeTimers();
    let release: (v: ProjectLogsResponse) => void = () => undefined;
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementationOnce(() => new Promise<ProjectLogsResponse>((r) => (release = r)));
    apiFetchMock.mockResolvedValue(reply("automática"));
    render(<ProjectLogsSection projectId="p1" />);
    await tick(10_000);
    expect(refreshButton()).toBeDisabled();
    await act(async () => release(reply("manual")));
    await tick(0);
    expect(screen.getByText("automática")).toBeInTheDocument();
    expect(refreshButton()).not.toBeDisabled();
  });

  it("duas consultas manuais seguidas: o botão só destrava quando as duas terminam, e vale a mais nova", async () => {
    const releases: Array<(v: ProjectLogsResponse) => void> = [];
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation(() => new Promise<ProjectLogsResponse>((r) => releases.push(r)));
    render(<ProjectLogsSection projectId="p1" />);
    fireEvent.change(screen.getByLabelText("Linhas"), { target: { value: "500" } });
    await waitFor(() => expect(releases).toHaveLength(2));
    await act(async () => releases[1]!(reply("segunda")));
    expect(refreshButton()).toBeDisabled();
    await act(async () => releases[0]!(reply("primeira")));
    expect(refreshButton()).not.toBeDisabled();
    expect(screen.getByText("segunda")).toBeInTheDocument();
    expect(screen.queryByText("primeira")).not.toBeInTheDocument();
  });

  it("consulta manual que falha também destrava o botão", async () => {
    apiFetchMock.mockReset();
    apiFetchMock.mockRejectedValue(new ApiRequestError(500, "internal_error", "boom"));
    render(<ProjectLogsSection projectId="p1" />);
    await screen.findByRole("alert");
    expect(refreshButton()).not.toBeDisabled();
  });
});

describe("ProjectLogsSection: troca de projeto e erros", () => {
  it("trocar de projeto limpa na hora as linhas e o serviço escolhido do anterior, antes de o novo responder", async () => {
    const { rerender } = render(<ProjectLogsSection projectId="p1" />);
    await screen.findByText("servidor no ar");
    fireEvent.change(screen.getByLabelText("Serviço"), { target: { value: "web" } });
    await waitFor(() => expect(urls()).toHaveLength(2));
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation(() => new Promise<ProjectLogsResponse>(() => undefined));
    rerender(<ProjectLogsSection projectId="p2" />);
    expect(screen.queryByText("servidor no ar")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Linhas de log" })).not.toBeInTheDocument();
    expect((screen.getByLabelText("Serviço") as HTMLSelectElement).value).toBe("");
    await waitFor(() => expect(urls().at(-1)).toBe("/api/projects/p2/logs?tail=200"));
  });

  it("erro numa consulta pedida pela pessoa tira a lista velha da tela (nada de dado antigo ao lado do erro)", async () => {
    render(<ProjectLogsSection projectId="p1" />);
    await screen.findByText("servidor no ar");
    apiFetchMock.mockRejectedValue(new ApiRequestError(500, "internal_error", "boom"));
    fireEvent.click(refreshButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível carregar os logs.");
    expect(screen.queryByText("servidor no ar")).not.toBeInTheDocument();
  });

  it("429 de leituras demais tem mensagem própria", async () => {
    apiFetchMock.mockRejectedValue(new ApiRequestError(429, "logs_busy", "x"));
    render(<ProjectLogsSection projectId="p1" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("leituras de logs demais");
  });
});
