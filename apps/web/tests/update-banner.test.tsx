/**
 * update-banner.test.tsx — aviso de "nova versão do painel".
 *
 * Validação real: depois de `git pull` + `docker compose up --build`, a aba
 * aberta continuava com o JavaScript antigo (o assistente parecia não ter
 * mudado) até o operador descobrir o Ctrl+Shift+R. A página passa a comparar o
 * arquivo principal que carregou com o que o servidor entrega agora — o nome
 * dele muda a cada build.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpdateBanner } from "@/components/UpdateBanner";

function servedIndex(bundle: string): string {
  return `<!doctype html><html><head><script type="module" crossorigin src="/assets/${bundle}"></script></head><body><div id="root"></div></body></html>`;
}

function loadedBundle(bundle: string | null) {
  document.head.querySelectorAll("script[data-test-bundle]").forEach((s) => s.remove());
  if (!bundle) return;
  const s = document.createElement("script");
  s.type = "module";
  s.src = `/assets/${bundle}`;
  s.dataset.testBundle = "1";
  document.head.appendChild(s);
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn(async () => new Response(servedIndex("index-aaa111.js"), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  loadedBundle(null);
});

async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("UpdateBanner", () => {
  it("mesma versão no servidor: nenhum aviso", async () => {
    loadedBundle("index-aaa111.js");
    render(<UpdateBanner />);
    await tick(61_000);
    expect(fetchMock).toHaveBeenCalled();
    expect(screen.queryByTestId("update-banner")).not.toBeInTheDocument();
  });

  it("o servidor passou a entregar outra versão: avisa e oferece recarregar", async () => {
    loadedBundle("index-aaa111.js");
    const reload = vi.fn();
    render(<UpdateBanner onReload={reload} />);
    fetchMock.mockImplementation(async () => new Response(servedIndex("index-bbb222.js"), { status: 200 }));
    await tick(61_000);
    const aviso = screen.getByTestId("update-banner");
    expect(aviso).toHaveTextContent(/nova versão do painel/i);
    fireEvent.click(screen.getByRole("button", { name: /Recarregar/ }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("confere também quando a aba volta a ficar visível", async () => {
    loadedBundle("index-aaa111.js");
    render(<UpdateBanner />);
    await tick(0);
    fetchMock.mockClear();
    fetchMock.mockImplementation(async () => new Response(servedIndex("index-bbb222.js"), { status: 200 }));
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("update-banner")).toBeInTheDocument();
  });

  it("servidor fora do ar ou resposta sem o arquivo principal: não avisa nada", async () => {
    loadedBundle("index-aaa111.js");
    fetchMock.mockImplementation(async () => {
      throw new Error("rede");
    });
    render(<UpdateBanner />);
    await tick(61_000);
    fetchMock.mockImplementation(async () => new Response("<html>manutenção</html>", { status: 502 }));
    await tick(61_000);
    expect(screen.queryByTestId("update-banner")).not.toBeInTheDocument();
  });

  it("em desenvolvimento (sem arquivo com hash) não consulta nada", async () => {
    loadedBundle(null);
    render(<UpdateBanner />);
    await tick(61_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
