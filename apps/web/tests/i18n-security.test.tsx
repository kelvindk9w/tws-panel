/**
 * Segurança do i18n: valores interpolados (títulos de chat do Telegram, nomes de
 * projeto, domínios: controlados por terceiros) nunca viram marcação; chaves
 * hostis ou ausentes nunca derrubam a tela; confirmação do "recomeçar" em en.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { catalog, setLocale, t, translate, Trans } from "../src/i18n";

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));
vi.mock("@/lib/api", () => ({
  apiFetch: apiFetchMock,
  ApiRequestError: class extends Error {
    constructor(
      public readonly status: number,
      public readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));

import { SetupDone } from "../src/pages/setup/SetupDone";

beforeEach(() => {
  catalog["pt-BR"]!["t_"] = { bold: "Conectado a <b>{chat}</b> agora", plain: "Valor {v}" };
  catalog["en"]!["t_"] = { bold: "Connected to <b>{chat}</b> now", plain: "Value {v}" };
});
afterEach(() => {
  cleanup();
  delete catalog["pt-BR"]!["t_"];
  delete catalog["en"]!["t_"];
  vi.restoreAllMocks();
  apiFetchMock.mockReset();
});

function renderTrans(params: Record<string, string | number>) {
  return render(
    <p data-testid="p">
      <Trans k={"t_.bold" as never} params={params} components={{ b: <strong /> }} />
    </p>,
  );
}

describe("Trans não interpreta marcação vinda de valores", () => {
  it("fecha-e-reabre tag no valor vira texto literal, com um único <strong>", () => {
    renderTrans({ chat: "x</b><b>y" });
    const p = screen.getByTestId("p");
    expect(p.querySelectorAll("strong")).toHaveLength(1);
    expect(p.querySelector("strong")!.textContent).toBe("x</b><b>y");
    expect(p.textContent).toBe("Conectado a x</b><b>y agora");
  });

  it("grupo</b> e <b>OUTRO não gera segundo <strong>", () => {
    renderTrans({ chat: "grupo</b> e <b>OUTRO" });
    const p = screen.getByTestId("p");
    expect(p.querySelectorAll("strong")).toHaveLength(1);
    expect(p.textContent).toBe("Conectado a grupo</b> e <b>OUTRO agora");
  });

  it("<img onerror> e chaves no valor ficam como texto", () => {
    renderTrans({ chat: '<img src=x onerror="alert(1)">{b}{{x}}' });
    const p = screen.getByTestId("p");
    expect(p.querySelector("img")).toBeNull();
    expect(p.querySelector("strong")!.textContent).toBe('<img src=x onerror="alert(1)">{b}{{x}}');
  });

  it("valor com {outra} não é interpolado de novo", () => {
    renderTrans({ chat: "{chat}" });
    expect(screen.getByTestId("p").querySelector("strong")!.textContent).toBe("{chat}");
  });
});

describe("chaves hostis ou ausentes não lançam", () => {
  it.each(["common.constructor", "common.__proto__", "common.toString", "common.hasOwnProperty", "constructor.x", "__proto__.x", "toString.valueOf"])(
    "translate(%s) devolve texto vazio, não lança",
    (key) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(() => translate(key)).not.toThrow();
      expect(translate(key)).toBe("");
    },
  );

  it("t(undefined), t(null) e t(número) devolvem vazio", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(t(undefined as never)).toBe("");
    expect(t(null as never)).toBe("");
    expect(t(42 as never)).toBe("");
  });

  it("chave inexistente (string) devolve vazio e avisa em dev", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(translate("t_.naoExiste")).toBe("");
    expect(warn).toHaveBeenCalled();
  });

  it("plural com chave hostil também não lança", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => translate("common.constructor", { count: 2 })).not.toThrow();
  });
});

describe("tradução do 'recomeçar' (en)", () => {
  const user = { username: "kelvin", createdAt: "2026-09-29T21:00:00Z", displayName: "Kelvin", email: null };

  async function abrir() {
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === "/api/auth/2fa") return { enabled: true, recoveryCodesLeft: 10 };
      if (path === "/api/settings/restart-setup") return { setupUrl: "/setup?token=NOVO" };
      return {};
    });
    vi.stubGlobal("location", { ...window.location, assign: vi.fn() });
    render(
      <MemoryRouter>
        <SetupDone user={user} />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole("button", { name: /start over from scratch/i }));
    return screen.findByRole("button", { name: /delete and start over/i });
  }

  it("em inglês aceita 'restart', destaca a palavra e envia 'recomeçar' ao servidor", async () => {
    setLocale("en", { persist: false });
    const botao = await abrir();
    const label = screen.getByText(/to confirm/i);
    expect(label.querySelector("code")?.textContent).toBe("restart");
    fireEvent.change(screen.getByLabelText(/your current password/i), { target: { value: "MinhaSenha123" } });
    fireEvent.change(screen.getByLabelText(/two-factor authentication code/i), { target: { value: "123456" } });
    fireEvent.change(screen.getByLabelText(/to confirm/i), { target: { value: "Restart" } });
    expect(botao).toBeEnabled();
    fireEvent.click(botao);
    await waitFor(() => expect(apiFetchMock.mock.calls.some((c) => c[0] === "/api/settings/restart-setup")).toBe(true));
    const body = JSON.parse(String(apiFetchMock.mock.calls.find((c) => c[0] === "/api/settings/restart-setup")![1].body));
    expect(body.confirm).toBe("recomeçar");
    vi.unstubAllGlobals();
  });

  it("em inglês a palavra em português continua valendo", async () => {
    setLocale("en", { persist: false });
    const botao = await abrir();
    fireEvent.change(screen.getByLabelText(/your current password/i), { target: { value: "x" } });
    fireEvent.change(screen.getByLabelText(/two-factor authentication code/i), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText(/to confirm/i), { target: { value: "recomeçar" } });
    expect(botao).toBeEnabled();
    vi.unstubAllGlobals();
  });

  it("em pt-BR segue exigindo 'recomeçar' e mostra a palavra em destaque", async () => {
    apiFetchMock.mockImplementation(async (path: string) => (path === "/api/auth/2fa" ? { enabled: true } : {}));
    render(
      <MemoryRouter>
        <SetupDone user={user} />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Recomeçar do zero/ }));
    const botao = await screen.findByRole("button", { name: /Apagar e recomeçar/ });
    fireEvent.change(screen.getByLabelText(/Sua senha atual/), { target: { value: "x" } });
    fireEvent.change(screen.getByLabelText(/Código da verificação em duas etapas/), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText(/Digite a palavra recomeçar/), { target: { value: "restart" } });
    expect(botao).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Digite a palavra recomeçar/), { target: { value: "recomeçar" } });
    expect(botao).toBeEnabled();
  });
});

describe("texto do en: 'continua na mesma hora'", () => {
  it("não diz 'same page'", () => {
    expect(translate("setup.done.restart.what", undefined, "en")).not.toMatch(/same page/);
    expect(translate("setup.done.restart.what", undefined, "en")).toMatch(/continue right away/);
  });
});
