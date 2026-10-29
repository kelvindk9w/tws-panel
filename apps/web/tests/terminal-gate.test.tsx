/**
 * terminal-gate.test.tsx — o terminal depois do setup só aparece habilitado: convite com o aviso,
 * diálogo de reautenticação, contagem do tempo restante, "Desligar agora" e volta ao convite quando o
 * servidor desliga. Durante o assistente (não exigido) o terminal aparece como sempre.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiFetchMock = vi.fn();

vi.mock("@/lib/api", () => ({
  apiFetch: (path: string, init?: RequestInit) => apiFetchMock(path, init),
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

import { ApiRequestError } from "@/lib/api";
import { TerminalGate } from "@/components/TerminalGate";
import { formatCountdown, isTerminalAccess } from "@/lib/terminal-access";

const BASE = {
  required: true,
  enabled: false,
  expiresAt: null,
  idleExpiresAt: null,
  remainingMs: 0,
  idleRemainingMs: 0,
  windowMs: 30 * 60_000,
  idleMs: 15 * 60_000,
  twoFactorEnabled: true,
  emailCodeEnabled: false,
  lastEnd: null,
};
const ON = { ...BASE, enabled: true, remainingMs: 29 * 60_000 + 30_000, idleRemainingMs: 14 * 60_000 };

let state: Record<string, unknown>;
let calls: Array<{ path: string; body: Record<string, unknown> }>;
let enableResult: () => Promise<Record<string, unknown>>;
let disabledCallback: (() => void) | null;

beforeEach(() => {
  state = BASE;
  calls = [];
  disabledCallback = null;
  enableResult = async () => ({ ...ON });
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (init?.method === "POST") calls.push({ path, body });
    if (path === "/api/auth/email-code") return { enabled: false, canEnable: false, address: null, mailReady: true, twoFactorEnabled: true };
    if (path === "/api/terminal/access") return state;
    if (path === "/api/terminal/access/enable") {
      const res = await enableResult();
      state = res;
      return res;
    }
    if (path === "/api/terminal/access/disable") {
      state = { ...BASE, lastEnd: "manual" };
      return state;
    }
    throw new Error(`rota inesperada: ${path}`);
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderGate() {
  return render(
    <MemoryRouter>
      <TerminalGate>
        {({ onDisabled }) => {
          disabledCallback = onDisabled;
          return <div data-testid="terminal">terminal ao vivo</div>;
        }}
      </TerminalGate>
    </MemoryRouter>,
  );
}

async function fillAndSubmit(password = "MinhaSenha123", code = "123456") {
  fireEvent.click(await screen.findByRole("button", { name: "Habilitar terminal" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.change(dialog.querySelector("#term-password")!, { target: { value: password } });
  fireEvent.change(dialog.querySelector("#term-code")!, { target: { value: code } });
  fireEvent.click(screen.getByRole("button", { name: "Habilitar" }));
}

describe("durante o assistente (habilitação não exigida)", () => {
  it("mostra o terminal direto, sem convite nem barra", async () => {
    state = { ...BASE, required: false, enabled: true };
    renderGate();
    expect(await screen.findByTestId("terminal")).toBeInTheDocument();
    expect(screen.queryByText("Terminal desligado")).toBeNull();
    expect(screen.queryByRole("button", { name: "Desligar agora" })).toBeNull();
  });
});

describe("terminal desligado", () => {
  it("mostra o convite com o aviso de acesso total e NÃO monta o terminal", async () => {
    renderGate();
    expect(await screen.findByText("Terminal desligado")).toBeInTheDocument();
    expect(screen.getByText(/acesso total ao usuário da VPS/)).toBeInTheDocument();
    expect(screen.getByText(/por até 30 min, e desliga sozinho após 15 min sem digitar/)).toBeInTheDocument();
    expect(screen.queryByTestId("terminal")).toBeNull();
  });

  it("sem 2FA o botão fica desligado e a tela explica onde ligar", async () => {
    state = { ...BASE, twoFactorEnabled: false };
    renderGate();
    expect(await screen.findByRole("button", { name: "Habilitar terminal" })).toBeDisabled();
    expect(screen.getByRole("link", { name: /Configurações → Segurança/ })).toHaveAttribute("href", "/settings/security#two-factor");
  });

  it("diz por que desligou da última vez", async () => {
    state = { ...BASE, lastEnd: "idle" };
    renderGate();
    expect(await screen.findByText(/desligado por ficar um tempo sem uso/)).toBeInTheDocument();
  });

  it("habilitar: senha e código vão ao servidor, o terminal aparece com a contagem e o aviso", async () => {
    renderGate();
    await fillAndSubmit();
    expect(await screen.findByTestId("terminal")).toBeInTheDocument();
    expect(calls).toEqual([{ path: "/api/terminal/access/enable", body: { currentPassword: "MinhaSenha123", code: "123456" } }]);
    expect(screen.getByText(/Terminal habilitado — desliga em 29:\d\d/)).toBeInTheDocument();
    expect(screen.getByText(/15 min sem digitar/)).toBeInTheDocument();
    expect(screen.getByText(/acesso total ao usuário da VPS/)).toBeInTheDocument();
  });

  it("alerta por e-mail que não saiu: a habilitação vale e o aviso fica na barra", async () => {
    enableResult = async () => ({ ...ON, alertWarning: "Alerta por e-mail não enviado: sem e-mail no perfil." });
    renderGate();
    await fillAndSubmit();
    expect(await screen.findByTestId("terminal")).toBeInTheDocument();
    expect(screen.getByText("Alerta por e-mail não enviado: sem e-mail no perfil.")).toBeInTheDocument();
  });

  it("erro do servidor aparece no diálogo, o código digitado é limpo e o terminal continua desligado", async () => {
    enableResult = async () => {
      throw new ApiRequestError(400, "invalid_two_factor_code", "Código incorreto ou já usado.");
    };
    renderGate();
    await fillAndSubmit();
    expect(await screen.findByRole("alert")).toHaveTextContent("Código incorreto ou já usado.");
    expect(screen.queryByTestId("terminal")).toBeNull();
    expect((screen.getByRole("dialog").querySelector("#term-code") as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("button", { name: "Habilitar" })).toBeDisabled();
  });

  it("o botão Habilitar só liga com senha e código; Cancelar fecha o diálogo", async () => {
    renderGate();
    fireEvent.click(await screen.findByRole("button", { name: "Habilitar terminal" }));
    expect(screen.getByRole("button", { name: "Habilitar" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Habilitar terminal" }));
    fireEvent.click(screen.getByRole("dialog"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("terminal habilitado", () => {
  beforeEach(() => {
    state = ON;
  });

  it("'Desligar agora' desliga, tira o terminal e volta ao convite dizendo o motivo", async () => {
    renderGate();
    expect(await screen.findByTestId("terminal")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Desligar agora" }));
    expect(await screen.findByText("Terminal desligado")).toBeInTheDocument();
    expect(screen.queryByTestId("terminal")).toBeNull();
    expect(screen.getByText("O terminal foi desligado.")).toBeInTheDocument();
  });

  it("falha ao desligar é dita, e o terminal segue como estava", async () => {
    renderGate();
    await screen.findByTestId("terminal");
    const original = apiFetchMock.getMockImplementation()!;
    apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/terminal/access/disable") throw new Error("rede");
      return original(path, init);
    });
    fireEvent.click(screen.getByRole("button", { name: "Desligar agora" }));
    expect(await screen.findByText("Não foi possível desligar o terminal agora.")).toBeInTheDocument();
    expect(screen.getByTestId("terminal")).toBeInTheDocument();
  });

  it("o servidor desligou (4403 no terminal): onDisabled reconsulta o estado e volta ao convite", async () => {
    renderGate();
    await screen.findByTestId("terminal");
    state = { ...BASE, lastEnd: "window" };
    act(() => disabledCallback!());
    expect(await screen.findByText("Terminal desligado")).toBeInTheDocument();
    expect(screen.getByText(/O tempo do terminal acabou/)).toBeInTheDocument();
  });

  it("a contagem anda sozinha e, ao chegar a zero, pergunta ao servidor", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    state = { ...ON, remainingMs: 3_000 };
    renderGate();
    await screen.findByTestId("terminal");
    expect(screen.getByText(/desliga em 00:0[23]/)).toBeInTheDocument();
    const before = apiFetchMock.mock.calls.filter(([p]) => p === "/api/terminal/access").length;
    state = { ...BASE, lastEnd: "window" };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    await waitFor(() => expect(screen.getByText("Terminal desligado")).toBeInTheDocument());
    expect(apiFetchMock.mock.calls.filter(([p]) => p === "/api/terminal/access").length).toBeGreaterThan(before);
  });

  it("reconfere o estado de tempos em tempos (a ociosidade só o servidor sabe)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderGate();
    await screen.findByTestId("terminal");
    state = { ...BASE, lastEnd: "idle" };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(21_000);
    });
    await waitFor(() => expect(screen.getByText(/desligado por ficar um tempo sem uso/)).toBeInTheDocument());
  });
});

describe("falhas de consulta", () => {
  it("resposta inválida ou erro de rede: mensagem com 'Tentar de novo' (nunca mostra o terminal)", async () => {
    state = { qualquer: "coisa" };
    renderGate();
    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível consultar o estado do terminal.");
    expect(screen.queryByTestId("terminal")).toBeNull();
    state = ON;
    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(await screen.findByTestId("terminal")).toBeInTheDocument();
  });

  it("falha de rede também vira o aviso", async () => {
    apiFetchMock.mockRejectedValue(new Error("rede"));
    renderGate();
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });

  it("enquanto consulta mostra 'Verificando…'", () => {
    apiFetchMock.mockImplementation(() => new Promise(() => undefined));
    renderGate();
    expect(screen.getByText("Verificando se o terminal está habilitado…")).toBeInTheDocument();
  });
});

describe("auxiliares", () => {
  it("formatCountdown", () => {
    expect(formatCountdown(0)).toBe("00:00");
    expect(formatCountdown(-5)).toBe("00:00");
    expect(formatCountdown(61_000)).toBe("01:01");
    expect(formatCountdown(1_800_000)).toBe("30:00");
    expect(formatCountdown(999)).toBe("00:01");
  });

  it("isTerminalAccess", () => {
    expect(isTerminalAccess(BASE)).toBe(true);
    expect(isTerminalAccess(null)).toBe(false);
    expect(isTerminalAccess("x")).toBe(false);
    expect(isTerminalAccess({ required: true })).toBe(false);
  });
});
