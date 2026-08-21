/**
 * terminal-panel.test.tsx — TerminalPanel (visão dupla do wizard):
 *  - BLOQUEADO antes da validação do token: placeholder, SEM WebSocket e SEM xterm;
 *  - ao ser habilitado (token validado), conecta o WS IMEDIATAMENTE com o token;
 *  - começa recolhido por padrão, com a orientação fixa visível no cabeçalho;
 *  - expande/colapsa com estado persistido em sessionStorage;
 *  - alerta pulsante ("olhe o terminal") aparece quando uma fase pede ação;
 *  - input do xterm vai direto ao WS (relay puro) e saída do WS vai ao xterm;
 *  - resize do xterm é sincronizado como frame de controle JSON.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks: xterm (sem canvas no jsdom) e WebSocket
// ---------------------------------------------------------------------------

interface MockTerm {
  write: ReturnType<typeof vi.fn>;
  onData: (cb: (data: string) => void) => { dispose: () => void };
  fireData: (data: string) => void;
  cols: number;
  rows: number;
  open: ReturnType<typeof vi.fn>;
  loadAddon: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}

const terms: MockTerm[] = [];

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    write = vi.fn();
    open = vi.fn();
    loadAddon = vi.fn();
    dispose = vi.fn();
    private cbs: Array<(data: string) => void> = [];
    onData(cb: (data: string) => void) {
      this.cbs.push(cb);
      return { dispose: () => this.cbs.splice(this.cbs.indexOf(cb), 1) };
    }
    fireData(data: string) {
      for (const cb of this.cbs) cb(data);
    }
    constructor() {
      terms.push(this as unknown as MockTerm);
    }
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit = vi.fn();
  },
}));

class MockWebSocket {
  static OPEN = 1;
  static instances: MockWebSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  sent: string[] = [];
  constructor(public url: string) {
    MockWebSocket.instances.push(this);
    setTimeout(() => {
      this.readyState = MockWebSocket.OPEN;
      this.onopen?.();
    }, 0);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  serverSend(data: string) {
    this.onmessage?.({ data });
  }
}

vi.stubGlobal("WebSocket", MockWebSocket);
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

// ---------------------------------------------------------------------------

import { TerminalPanel, TERMINAL_ATTENTION_EVENT } from "@/components/TerminalPanel";
import { setSetupToken } from "@/lib/api";

function lastWs(): MockWebSocket {
  const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
  if (!ws) throw new Error("nenhum WebSocket criado");
  return ws;
}

function lastTerm(): MockTerm {
  const t = terms[terms.length - 1];
  if (!t) throw new Error("nenhum Terminal criado");
  return t;
}

beforeEach(() => {
  sessionStorage.clear();
  MockWebSocket.instances = [];
  terms.length = 0;
  setSetupToken("token-de-teste");
});

afterEach(() => {
  cleanup();
});

describe("TerminalPanel — bloqueio antes do token", () => {
  it("desabilitado: mostra placeholder e NÃO abre WebSocket nem cria xterm", () => {
    render(<TerminalPanel enabled={false} />);
    expect(screen.getByTestId("terminal-locked")).toBeInTheDocument();
    expect(screen.getByText(/bloqueado por segurança/)).toBeInTheDocument();
    expect(screen.getByText(/setup token/)).toBeInTheDocument();
    expect(MockWebSocket.instances).toHaveLength(0); // NUNCA conecta sem token
    expect(terms).toHaveLength(0);
    expect(screen.queryByTestId("terminal-container")).not.toBeInTheDocument();
  });

  it("conecta IMEDIATAMENTE quando habilitado (token validado)", async () => {
    const { rerender } = render(<TerminalPanel enabled={false} />);
    expect(MockWebSocket.instances).toHaveLength(0);

    rerender(<TerminalPanel enabled={true} />);
    await waitFor(() => expect(lastWs().url).toContain("/api/terminal/ws?token=token-de-teste"));
    await waitFor(() => expect(screen.getByText("conectado")).toBeInTheDocument());
  });
});

describe("TerminalPanel — habilitado", () => {
  it("renderiza a janela contida e conecta o WS autenticado com o setup token", async () => {
    render(<TerminalPanel enabled={true} />);
    expect(screen.getByLabelText("Terminal do servidor")).toBeInTheDocument();
    expect(screen.getByText(/Terminal do servidor/)).toBeInTheDocument();
    await waitFor(() => expect(lastWs().url).toContain("/api/terminal/ws?token=token-de-teste"));
    await waitFor(() => expect(screen.getByText("conectado")).toBeInTheDocument());
  });

  it("começa RECOLHIDO por padrão, com a orientação fixa visível", () => {
    render(<TerminalPanel enabled={true} />);
    expect(screen.getByTestId("terminal-container")).not.toBeVisible();
    expect(screen.getByText(/apenas observe; aja SOMENTE quando for solicitado/i)).toBeInTheDocument();
    expect(screen.getByText(/Interferir por conta própria pode interromper/)).toBeInTheDocument();
  });

  it("colapsa/expande e persiste o estado em sessionStorage", async () => {
    render(<TerminalPanel enabled={true} />);
    const toggle = screen.getByRole("button", { name: /Terminal do servidor/ });
    const container = screen.getByTestId("terminal-container");
    expect(container).not.toBeVisible(); // recolhido por padrão

    fireEvent.click(toggle);
    expect(container).toBeVisible();
    expect(sessionStorage.getItem("paas.terminal.open")).toBe("1");

    fireEvent.click(toggle);
    expect(container).not.toBeVisible();
    expect(sessionStorage.getItem("paas.terminal.open")).toBe("0");
  });

  it("estado expandido persiste entre montagens", () => {
    sessionStorage.setItem("paas.terminal.open", "1");
    render(<TerminalPanel enabled={true} />);
    expect(screen.getByTestId("terminal-container")).toBeVisible();
  });

  it("alerta pulsante aparece quando uma fase precisa de ação e abre o painel", async () => {
    render(<TerminalPanel enabled={true} />);
    const toggle = screen.getByRole("button", { name: /Terminal do servidor/ });
    expect(toggle.className).not.toContain("animate-pulse");

    fireEvent(window, new CustomEvent(TERMINAL_ATTENTION_EVENT, { detail: { phase: "01" } }));
    await waitFor(() => expect(toggle.className).toContain("animate-pulse"));
    expect(screen.getByText(/OLHE O TERMINAL/)).toBeInTheDocument();
    expect(screen.getByTestId("terminal-container")).toBeVisible(); // abriu sozinho

    // o alerta some quando o usuário digita no terminal
    lastTerm().fireData("x");
    await waitFor(() => expect(toggle.className).not.toContain("animate-pulse"));
  });

  it("input do xterm vai direto ao WS (relay puro); saída do WS vai ao xterm", async () => {
    render(<TerminalPanel enabled={true} />);
    await waitFor(() => expect(lastWs().readyState).toBe(MockWebSocket.OPEN));

    lastTerm().fireData("senha-secreta\n");
    expect(lastWs().sent).toContain("senha-secreta\n");

    lastWs().serverSend("root@vps:~$ ");
    expect(lastTerm().write).toHaveBeenCalledWith("root@vps:~$ ");
  });

  it("sincroniza o resize do PTY ao conectar (frame de controle JSON)", async () => {
    render(<TerminalPanel enabled={true} />);
    await waitFor(() =>
      expect(lastWs().sent.some((m) => m.includes('"type":"resize"'))).toBe(true),
    );
    const frame = JSON.parse(lastWs().sent.find((m) => m.includes('"type":"resize"')) ?? "{}");
    expect(frame).toMatchObject({ type: "resize", cols: 80, rows: 24 });
  });
});
