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
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  /** false = o teste controla quando cada conexão abre (serverOpen). */
  static autoOpen = true;
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  sent: string[] = [];
  constructor(public url: string) {
    MockWebSocket.instances.push(this);
    if (MockWebSocket.autoOpen) {
      setTimeout(() => this.serverOpen(), 0);
    }
  }
  serverOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }
  send(data: string) {
    this.sent.push(data);
  }
  close(code = 1000) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  serverSend(data: string) {
    this.onmessage?.({ data });
  }
  /** O SERVIDOR fecha a conexão com um código (queda, 4009, etc.). */
  serverClose(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
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

import { TerminalPanel, TERMINAL_ATTENTION_CLEAR_EVENT, TERMINAL_ATTENTION_EVENT } from "@/components/TerminalPanel";
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
  MockWebSocket.autoOpen = true;
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
    await waitFor(() => expect(lastWs().url).toContain("/api/terminal/ws?"));
    expect(new URL(lastWs().url).searchParams.get("token")).toBe("token-de-teste");
    await waitFor(() => expect(screen.getByText("conectado")).toBeInTheDocument());
  });
});

describe("TerminalPanel — habilitado", () => {
  it("renderiza a janela contida e conecta o WS autenticado com o setup token", async () => {
    render(<TerminalPanel enabled={true} />);
    expect(screen.getByLabelText("Terminal do servidor")).toBeInTheDocument();
    expect(screen.getByText(/Terminal do servidor/)).toBeInTheDocument();
    await waitFor(() => expect(lastWs().url).toContain("/api/terminal/ws?"));
    expect(new URL(lastWs().url).searchParams.get("token")).toBe("token-de-teste");
    await waitFor(() => expect(screen.getByText("conectado")).toBeInTheDocument());
  });

  it("começa RECOLHIDO por padrão, com a orientação fixa visível", () => {
    render(<TerminalPanel enabled={true} />);
    expect(screen.getByTestId("terminal-container")).not.toBeVisible();
    expect(screen.getByText(/apenas observe; aja SOMENTE quando for solicitado/i)).toBeInTheDocument();
    expect(screen.getByText(/Interferir por conta própria pode interromper/)).toBeInTheDocument();
  });

  it("explica por que a sessão aparece como root, sem jargão técnico", () => {
    render(<TerminalPanel enabled={true} />);
    expect(screen.getByText(/hardening do servidor exige/i)).toBeInTheDocument();
    expect(
      screen.getByText(/usuário não-root que você criou na instalação continua sendo o do seu acesso por SSH/i),
    ).toBeInTheDocument();
    // linguagem para quem pode não ser desenvolvedor: sem jargão de container
    expect(screen.queryByText(/nsenter/i)).not.toBeInTheDocument();
  });

  /**
   * Sem o NOME, a nota continuava abstrata ("o usuário que você criou") e o
   * operador seguia achando que o usuário dele tinha sido ignorado. Com o nome
   * detectado na varredura, a nota responde à dúvida real dele.
   */
  it("cita o nome do usuário detectado, quando o wizard o conhece", () => {
    render(<TerminalPanel enabled={true} sshUser="kelvin" />);
    expect(screen.getByText(/hardening do servidor exige/i)).toBeInTheDocument();
    expect(screen.getByText("kelvin")).toBeInTheDocument();
    expect(screen.getByText(/não foi ignorado/i)).toBeInTheDocument();
    expect(screen.getByText(/acesso por SSH/i)).toBeInTheDocument();
  });

  it("sem nome conhecido, mantém a nota genérica de hoje", () => {
    render(<TerminalPanel enabled={true} />);
    expect(
      screen.getByText(/usuário não-root que você criou na instalação continua sendo o do seu acesso por SSH/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/não foi ignorado/i)).not.toBeInTheDocument();
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

  it("o alerta some quando a execução termina (evento de clear) — não fica preso", async () => {
    render(<TerminalPanel enabled={true} />);
    const toggle = screen.getByRole("button", { name: /Terminal do servidor/ });

    fireEvent(window, new CustomEvent(TERMINAL_ATTENTION_EVENT, { detail: { phase: "02" } }));
    await waitFor(() => expect(screen.getByText(/OLHE O TERMINAL/)).toBeInTheDocument());

    // fim da execução (sucesso/falha/abort): o badge NÃO pode continuar pulsando
    fireEvent(window, new CustomEvent(TERMINAL_ATTENTION_CLEAR_EVENT));
    await waitFor(() => expect(screen.queryByText(/OLHE O TERMINAL/)).not.toBeInTheDocument());
    expect(toggle.className).not.toContain("animate-pulse");
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

  it("envia um clientId estável (sessionStorage) na query do WS — anti-ping-pong", async () => {
    render(<TerminalPanel enabled={true} />);
    await waitFor(() => expect(lastWs().url).toContain("/api/terminal/ws?"));
    const firstId = new URL(lastWs().url).searchParams.get("clientId");
    expect(firstId).toBeTruthy();
    expect(new URL(lastWs().url).searchParams.get("token")).toBe("token-de-teste");

    // remonta: o MESMO clientId é reutilizado (reattach do dono, não intruso)
    cleanup();
    render(<TerminalPanel enabled={true} />);
    await waitFor(() => expect(MockWebSocket.instances.length).toBe(2));
    expect(new URL(lastWs().url).searchParams.get("clientId")).toBe(firstId);
  });
});

describe("TerminalPanel — reconexão resiliente", () => {
  it("backoff exponencial com jitter: 1s → 2s → 4s entre tentativas", async () => {
    render(<TerminalPanel enabled={true} />);
    await waitFor(() => expect(screen.getByText("conectado")).toBeInTheDocument());

    vi.useFakeTimers();
    const jitter = vi.spyOn(Math, "random").mockReturnValue(0); // jitter determinístico
    // as reconexões NÃO abrem sozinhas: o servidor segue derrubando — é o
    // cenário em que o backoff precisa crescer (conexão nunca estabiliza)
    MockWebSocket.autoOpen = false;
    try {
      // queda anormal (1006): 1ª tentativa após 1s
      act(() => lastWs().serverClose(1006));
      expect(MockWebSocket.instances).toHaveLength(1);
      await act(async () => vi.advanceTimersByTimeAsync(999));
      expect(MockWebSocket.instances).toHaveLength(1);
      await act(async () => vi.advanceTimersByTimeAsync(1));
      expect(MockWebSocket.instances).toHaveLength(2);

      // cai de novo ANTES de abrir (servidor instável): 2ª tentativa após 2s
      act(() => lastWs().serverClose(1006));
      await act(async () => vi.advanceTimersByTimeAsync(1_999));
      expect(MockWebSocket.instances).toHaveLength(2);
      await act(async () => vi.advanceTimersByTimeAsync(1));
      expect(MockWebSocket.instances).toHaveLength(3);

      // e de novo: 3ª tentativa após 4s
      act(() => lastWs().serverClose(1006));
      await act(async () => vi.advanceTimersByTimeAsync(3_999));
      expect(MockWebSocket.instances).toHaveLength(3);
      await act(async () => vi.advanceTimersByTimeAsync(1));
      expect(MockWebSocket.instances).toHaveLength(4);
    } finally {
      jitter.mockRestore();
      vi.useRealTimers();
    }
  });

  it("o backoff RESETA após uma conexão bem-sucedida", async () => {
    render(<TerminalPanel enabled={true} />);
    await waitFor(() => expect(screen.getByText("conectado")).toBeInTheDocument());

    vi.useFakeTimers();
    const jitter = vi.spyOn(Math, "random").mockReturnValue(0);
    MockWebSocket.autoOpen = false; // o teste decide quando cada conexão abre
    try {
      act(() => lastWs().serverClose(1006));
      await act(async () => vi.advanceTimersByTimeAsync(1_000)); // 1ª tentativa (1s)
      expect(MockWebSocket.instances).toHaveLength(2);
      act(() => lastWs().serverOpen()); // conectou com sucesso
      // nova queda: volta para 1s (não 2s) — prova do reset ao conectar
      act(() => lastWs().serverClose(1006));
      await act(async () => vi.advanceTimersByTimeAsync(999));
      expect(MockWebSocket.instances).toHaveLength(2);
      await act(async () => vi.advanceTimersByTimeAsync(1));
      expect(MockWebSocket.instances).toHaveLength(3);
    } finally {
      jitter.mockRestore();
      vi.useRealTimers();
    }
  });

  it("close 4009 (terminal em uso em outra aba): NÃO reconecta e avisa em pt-BR", async () => {
    render(<TerminalPanel enabled={true} />);
    await waitFor(() => expect(screen.getByText("conectado")).toBeInTheDocument());

    vi.useFakeTimers();
    try {
      act(() => lastWs().serverClose(4009));
      await act(async () => vi.advanceTimersByTimeAsync(120_000)); // muito além do teto
      expect(MockWebSocket.instances).toHaveLength(1); // NUNCA reconecta
    } finally {
      vi.useRealTimers();
    }
    expect(screen.getByText(/Terminal em uso em outra aba\/janela/)).toBeInTheDocument();
    expect(screen.getByText("em uso em outra aba")).toBeInTheDocument();
  });

  it("close 4000 (reattach do mesmo clientId por outra conexão): NÃO reconecta", async () => {
    render(<TerminalPanel enabled={true} />);
    await waitFor(() => expect(screen.getByText("conectado")).toBeInTheDocument());

    vi.useFakeTimers();
    try {
      act(() => lastWs().serverClose(4000));
      await act(async () => vi.advanceTimersByTimeAsync(120_000));
      expect(MockWebSocket.instances).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
