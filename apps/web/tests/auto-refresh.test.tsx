/**
 * auto-refresh.test.tsx — consulta automática enquanto algo está "a caminho"
 * (ex.: certificado emitindo), com recuo e pausa com a aba oculta.
 *
 * Validação real (07/10/2026): o certificado do domínio do painel ficou
 * válido e a tela continuou mostrando "Emitindo" até recarregar a página.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CERTIFICATE_WATCH_SCHEDULE,
  certificatePending,
  intervalAt,
  useAutoRefresh,
} from "../src/lib/auto-refresh";
import type { CertificateItem } from "@paas/core";

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
  document.dispatchEvent(new Event("visibilitychange"));
}

const SCHEDULE = [
  { untilMs: 20_000, everyMs: 5_000 },
  { untilMs: 60_000, everyMs: 20_000 },
  { untilMs: Infinity, everyMs: 60_000 },
];

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("intervalAt", () => {
  it("escolhe o intervalo da fase em que o tempo está, e o último vale para sempre", () => {
    expect(intervalAt(SCHEDULE, 0)).toBe(5_000);
    expect(intervalAt(SCHEDULE, 19_999)).toBe(5_000);
    expect(intervalAt(SCHEDULE, 20_000)).toBe(20_000);
    expect(intervalAt(SCHEDULE, 10 * 60_000)).toBe(60_000);
  });

  it("o padrão do certificado: rápido no começo (5 a 10 s) e mais espaçado depois", () => {
    expect(intervalAt(CERTIFICATE_WATCH_SCHEDULE, 0)).toBeGreaterThanOrEqual(5_000);
    expect(intervalAt(CERTIFICATE_WATCH_SCHEDULE, 0)).toBeLessThanOrEqual(10_000);
    expect(intervalAt(CERTIFICATE_WATCH_SCHEDULE, 30 * 60_000)).toBeGreaterThan(intervalAt(CERTIFICATE_WATCH_SCHEDULE, 0));
  });

  it("agenda sem fases: não consulta", () => {
    expect(intervalAt([], 0)).toBeNull();
  });
});

describe("certificatePending", () => {
  const item = (over: Partial<CertificateItem>): CertificateItem => ({
    host: "painel.exemplo.com.br",
    owner: { kind: "panel", projectId: null, projectName: null },
    mode: "automatic",
    coveredBy: null,
    state: "issuing",
    issuer: null,
    validTo: null,
    renewsAround: null,
    lastError: null,
    manual: null,
    canRetry: true,
    ...over,
  });

  it("automático ainda sem certificado válido (emitindo, falhou, não conferido, vencido) está a caminho", () => {
    for (const state of ["issuing", "failed", "unknown", "expired"] as const) {
      expect(certificatePending(item({ state }))).toBe(true);
    }
  });

  it("válido, vencendo, manual ou coberto por um manual não estão: consultar não muda nada", () => {
    expect(certificatePending(item({ state: "valid" }))).toBe(false);
    expect(certificatePending(item({ state: "expiring" }))).toBe(false);
    expect(certificatePending(item({ mode: "manual", state: "expired" }))).toBe(false);
    expect(certificatePending(item({ mode: "manual", coveredBy: "*.exemplo.com.br", state: "unknown" }))).toBe(false);
  });
});

describe("useAutoRefresh", () => {
  it("ativo: consulta no ritmo da agenda, mais devagar com o tempo", async () => {
    const refresh = vi.fn(async () => {});
    renderHook(() => useAutoRefresh(true, refresh, SCHEDULE));
    expect(refresh).not.toHaveBeenCalled(); // a tela já carregou: a primeira consulta vem no intervalo
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(refresh).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(15_000)); // até 20 s: a cada 5 s
    expect(refresh).toHaveBeenCalledTimes(4);
    await act(async () => vi.advanceTimersByTimeAsync(20_000)); // depois: a cada 20 s
    expect(refresh).toHaveBeenCalledTimes(5);
    await act(async () => vi.advanceTimersByTimeAsync(40_000)); // 80 s (a 6ª foi em 60 s); a próxima só em 120 s
    expect(refresh).toHaveBeenCalledTimes(6);
    await act(async () => vi.advanceTimersByTimeAsync(39_000));
    expect(refresh).toHaveBeenCalledTimes(6);
    await act(async () => vi.advanceTimersByTimeAsync(1_000)); // passou de 1 min: a cada 60 s
    expect(refresh).toHaveBeenCalledTimes(7);
  });

  it("inativo: não consulta; ao ficar ativo começa, e para quando deixa de estar", async () => {
    const refresh = vi.fn(async () => {});
    const { rerender } = renderHook(({ on }) => useAutoRefresh(on, refresh, SCHEDULE), { initialProps: { on: false } });
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(refresh).not.toHaveBeenCalled();
    rerender({ on: true });
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(refresh).toHaveBeenCalledTimes(1);
    rerender({ on: false });
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("não sobrepõe consultas: a próxima só é marcada depois que a anterior termina", async () => {
    let finish: () => void = () => {};
    const refresh = vi.fn(() => new Promise<void>((r) => (finish = r)));
    renderHook(() => useAutoRefresh(true, refresh, SCHEDULE));
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(refresh).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(30_000)); // a consulta ainda não voltou
    expect(refresh).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("uma consulta que falha não interrompe as próximas", async () => {
    const refresh = vi.fn(async () => {
      throw new Error("rede");
    });
    renderHook(() => useAutoRefresh(true, refresh, SCHEDULE));
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("aba oculta: para de consultar; ao voltar, consulta na hora e recomeça o ritmo rápido", async () => {
    const refresh = vi.fn(async () => {});
    renderHook(() => useAutoRefresh(true, refresh, SCHEDULE));
    await act(async () => vi.advanceTimersByTimeAsync(60_000)); // já no ritmo lento
    const before = refresh.mock.calls.length;
    act(() => setVisibility("hidden"));
    await act(async () => vi.advanceTimersByTimeAsync(10 * 60_000));
    expect(refresh).toHaveBeenCalledTimes(before);
    await act(async () => setVisibility("visible"));
    expect(refresh).toHaveBeenCalledTimes(before + 1);
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(refresh).toHaveBeenCalledTimes(before + 2);
  });

  it("montado com a aba oculta: espera ela voltar", async () => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    const refresh = vi.fn(async () => {});
    renderHook(() => useAutoRefresh(true, refresh, SCHEDULE));
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(refresh).not.toHaveBeenCalled();
    await act(async () => setVisibility("visible"));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("aba que volta com a consulta inativa não dispara nada; desmontar para tudo", async () => {
    const refresh = vi.fn(async () => {});
    const { unmount, rerender } = renderHook(({ on }) => useAutoRefresh(on, refresh, SCHEDULE), { initialProps: { on: false } });
    await act(async () => setVisibility("visible"));
    expect(refresh).not.toHaveBeenCalled();
    rerender({ on: true });
    unmount();
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    await act(async () => setVisibility("visible"));
    expect(refresh).not.toHaveBeenCalled();
  });

  it("usa sempre a função mais recente (sem reiniciar o ritmo quando ela muda)", async () => {
    const first = vi.fn(async () => {});
    const second = vi.fn(async () => {});
    const { rerender } = renderHook(({ fn }) => useAutoRefresh(true, fn, SCHEDULE), { initialProps: { fn: first } });
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    rerender({ fn: second });
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
