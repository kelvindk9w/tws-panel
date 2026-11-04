/**
 * project-logs-section-abort.test.tsx — a aba cancela a consulta antiga quando
 * começa outra (seletores trocados rápido, Atualizar durante a automática):
 * nenhuma consulta velha segura as vagas do ator no servidor.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectLogsResponse } from "@paas/core";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return { ...real, apiFetch: apiFetchMock };
});

import { ApiRequestError } from "@/lib/api";
import { ProjectLogsSection } from "@/components/project/ProjectLogsSection";

function reply(text: string): ProjectLogsResponse {
  return {
    service: null,
    tail: 200,
    since: null,
    services: [{ service: "api", container: "c", state: "running", status: "Up", health: null, restartCount: 0, startedAt: null, finishedAt: null, exitCode: null, logsError: null }],
    lines: [{ time: "2026-10-24T11:00:00Z", service: "api", container: "c", stream: "stdout", text }],
    truncated: false,
    generatedAt: "2026-10-24T11:01:00Z",
  };
}

/** Servidor de mentira: cada consulta fica aberta até ser resolvida à mão ou abortada; passando de 2 abertas, 429. */
function fakeServer() {
  const open = new Set<number>();
  const resolvers = new Map<number, (v: ProjectLogsResponse) => void>();
  const signals: Array<AbortSignal | undefined> = [];
  let n = 0;
  let max429 = 0;
  apiFetchMock.mockImplementation((_path: string, init?: { signal?: AbortSignal }) => {
    const id = n++;
    signals.push(init?.signal);
    if (open.size >= 2) {
      max429++;
      return Promise.reject(new ApiRequestError(429, "logs_busy", "x"));
    }
    open.add(id);
    return new Promise<ProjectLogsResponse>((resolve, reject) => {
      resolvers.set(id, (v) => {
        open.delete(id);
        resolve(v);
      });
      init?.signal?.addEventListener("abort", () => {
        open.delete(id);
        reject(new DOMException("aborted", "AbortError"));
      });
    });
  });
  return { open, resolvers, signals, count429: () => max429, calls: () => n };
}

beforeEach(() => {
  apiFetchMock.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ProjectLogsSection: consultas antigas são canceladas", () => {
  it("3 trocas rápidas do seletor: nenhum 429, só a última é aplicada e as anteriores foram abortadas", async () => {
    const srv = fakeServer();
    render(<ProjectLogsSection projectId="p1" />);
    const tail = screen.getByLabelText("Linhas");
    fireEvent.change(tail, { target: { value: "500" } });
    fireEvent.change(tail, { target: { value: "1000" } });
    fireEvent.change(tail, { target: { value: "2000" } });
    await act(async () => undefined);
    expect(srv.calls()).toBe(4);
    expect(srv.count429()).toBe(0);
    expect(srv.signals.slice(0, 3).every((s) => s?.aborted)).toBe(true);
    expect(srv.signals[3]?.aborted).toBe(false);
    // as anteriores nunca mostram erro, e só a última resposta aparece
    await act(async () => srv.resolvers.get(3)!(reply("da última")));
    expect(screen.getByText("da última")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("Atualizar durante a consulta automática cancela a automática", async () => {
    vi.useFakeTimers();
    const srv = fakeServer();
    render(<ProjectLogsSection projectId="p1" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => srv.resolvers.get(0)!(reply("primeira")));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000); // a automática dispara e fica aberta
    });
    expect(srv.calls()).toBe(2);
    fireEvent.click(screen.getByRole("button", { name: "Atualizar" }));
    await act(async () => undefined);
    expect(srv.signals[1]?.aborted).toBe(true);
    expect(srv.signals[2]?.aborted).toBe(false);
    expect(srv.count429()).toBe(0);
  });

  it("sair da aba cancela a consulta aberta", async () => {
    const srv = fakeServer();
    const { unmount } = render(<ProjectLogsSection projectId="p1" />);
    await act(async () => undefined);
    unmount();
    expect(srv.signals[0]?.aborted).toBe(true);
  });

  it("429 numa consulta automática não apaga a lista que já estava na tela", async () => {
    vi.useFakeTimers();
    apiFetchMock.mockResolvedValueOnce(reply("fica na tela"));
    apiFetchMock.mockRejectedValue(new ApiRequestError(429, "logs_busy", "x"));
    render(<ProjectLogsSection projectId="p1" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(screen.getByText("fica na tela")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("leituras de logs demais");
  });

  it("erro de uma consulta cancelada (AbortError) nunca aparece", async () => {
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation((_p: string, init?: { signal?: AbortSignal }) => new Promise((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new DOMException("a", "AbortError")))));
    render(<ProjectLogsSection projectId="p1" />);
    fireEvent.change(screen.getByLabelText("Linhas"), { target: { value: "500" } });
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
