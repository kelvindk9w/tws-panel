/**
 * terminal-panel.test.tsx — TerminalPanel (visão dupla do wizard):
 *  - BLOQUEADO antes da validação do token: placeholder, SEM WebSocket e SEM xterm;
 *  - ao ser habilitado (token validado), conecta o WS IMEDIATAMENTE com o token;
 *  - começa recolhido por padrão, com a orientação fixa visível no cabeçalho;
 *  - expande/colapsa com estado persistido em sessionStorage;
 *  - alerta pulsante ("olhe o terminal") aparece quando uma fase pede ação;
 *  - input do xterm vai direto ao WS (relay puro) e saída do WS vai ao xterm;
 *  - resize do xterm é sincronizado como frame de controle JSON;
 *  - cabeçalho diz a verdade sobre usuário/modo de root de cada instalação;
 *  - frames de controle (" paas-control:") nunca chegam ao xterm;
 *  - alerta de senha do sudo (transparência + transporte inseguro + desfechos);
 *  - indicador discreto de comando root em segundo plano.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks: xterm (sem canvas no jsdom) e WebSocket
// ---------------------------------------------------------------------------

interface MockTerm {
  write: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
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
    focus = vi.fn();
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

/** Endereço simulado da página (o jsdom fica preso em http://localhost). */
let fakeLocation: {
  protocol: string;
  hostname: string;
  port?: string;
  pathname?: string;
  search?: string;
} = { protocol: "http:", hostname: "localhost" };
vi.mock("@/lib/page-location", () => ({ pageLocation: () => fakeLocation }));

import type { HostDockerAccess, TerminalElevation, TerminalInfoResponse, TerminalControlMessage } from "@paas/core";
import { encodeTerminalControl } from "@paas/core";
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

function infoFor(
  elevation: TerminalElevation,
  user = "kelvin",
  hostDockerAccess: HostDockerAccess | null = null,
): TerminalInfoResponse {
  const root = elevation === "root" || elevation === "root-legado";
  return {
    target: elevation === "container-dev" ? "container" : "host",
    user: root ? "root" : user,
    configuredUser: elevation === "root-legado" ? null : root ? "root" : user,
    rootMode: elevation === "senha" || elevation === "segundo-plano" ? elevation : null,
    elevation,
    scheduledMonitoringRunsAsRoot: true,
    hostDockerAccess,
  };
}

const ROOT_LEGADO = infoFor("root-legado");

/** O servidor manda um frame de controle pelo WS. */
function control(msg: TerminalControlMessage) {
  act(() => lastWs().serverSend(encodeTerminalControl(msg)));
}

beforeEach(() => {
  fakeLocation = { protocol: "http:", hostname: "localhost" };
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

  /**
   * Sem o NOME, a nota continuava abstrata ("o usuário que você criou") e o
   * operador seguia achando que o usuário dele tinha sido ignorado. Em sessão
   * root, com o nome detectado na varredura, a nota responde à dúvida real.
   */
  it("sessão root: cita o nome do usuário detectado, quando o wizard o conhece", () => {
    render(<TerminalPanel enabled={true} sshUser="kelvin" info={ROOT_LEGADO} />);
    expect(screen.getByText("kelvin")).toBeInTheDocument();
    expect(screen.getByText(/não foi ignorado/i)).toBeInTheDocument();
    expect(screen.getByText(/acesso por SSH/i)).toBeInTheDocument();
    // linguagem para quem pode não ser desenvolvedor: sem jargão de container
    expect(screen.queryByText(/nsenter/i)).not.toBeInTheDocument();
  });

  it("sessão root sem nome conhecido: sem a frase do usuário ignorado", () => {
    render(<TerminalPanel enabled={true} info={ROOT_LEGADO} />);
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

/**
 * Botão "abrir como <usuário>" — o operador quer VER o usuário que criou
 * dentro do terminal ao vivo (ele grava/printa essa tela). A sessão continua
 * sendo root por baixo (o scanner e as fases precisam disso): o botão apenas
 * abre um shell do usuário DENTRO dela, e `exit` volta para root.
 */
describe("TerminalPanel — abrir shell do usuário não-root (sessão root)", () => {
  it("sem sshUser: não há o que abrir, o botão não aparece", async () => {
    render(<TerminalPanel enabled={true} info={ROOT_LEGADO} />);
    await waitFor(() => expect(screen.getByText("conectado")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /abrir como/i })).not.toBeInTheDocument();
  });

  it("com sshUser e sessão conectada: o botão aparece citando o nome", async () => {
    render(<TerminalPanel enabled={true} sshUser="kelvin" info={ROOT_LEGADO} />);
    await waitFor(() => expect(screen.getByText("conectado")).toBeInTheDocument());
    const btn = screen.getByRole("button", { name: /abrir como kelvin/i });
    expect(btn).toBeInTheDocument();
    // deixa claro como voltar — o operador não pode achar que ficou preso
    expect(btn.getAttribute("title")).toMatch(/exit/i);
  });

  it("clicar envia o comando de troca de usuário pelo MESMO caminho do input", async () => {
    render(<TerminalPanel enabled={true} sshUser="kelvin" info={ROOT_LEGADO} />);
    await waitFor(() => expect(lastWs().readyState).toBe(MockWebSocket.OPEN));

    fireEvent.click(screen.getByRole("button", { name: /abrir como kelvin/i }));
    // relay puro: o comando trafega como se tivesse sido digitado no xterm
    expect(lastWs().sent).toContain("su - kelvin\n");
  });

  it("com a sessão caída (ou em outra aba), o botão não é oferecido", async () => {
    render(<TerminalPanel enabled={true} sshUser="kelvin" info={ROOT_LEGADO} />);
    await waitFor(() => expect(screen.getByText("conectado")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /abrir como kelvin/i })).toBeInTheDocument();

    act(() => lastWs().serverClose(4009)); // em uso em outra aba
    await waitFor(() => expect(screen.getByText("em uso em outra aba")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /abrir como/i })).not.toBeInTheDocument();
  });

  it("nome implausível: nenhum botão e NADA é enviado (sem injeção de comando)", async () => {
    for (const nome of ["root", "kelvin; rm -rf /", "kelvin\nreboot", "Kelvin$(id)"]) {
      render(<TerminalPanel enabled={true} sshUser={nome} info={ROOT_LEGADO} />);
      await waitFor(() => expect(lastWs().readyState).toBe(MockWebSocket.OPEN));
      expect(screen.queryByRole("button", { name: /abrir como/i })).not.toBeInTheDocument();
      expect(lastWs().sent.some((m) => m.includes("su "))).toBe(false);
      cleanup();
    }
  });

  it("o aviso de que a sessão é root continua no cabeçalho, junto com o botão", async () => {
    render(<TerminalPanel enabled={true} sshUser="kelvin" info={ROOT_LEGADO} />);
    await waitFor(() => expect(screen.getByText("conectado")).toBeInTheDocument());
    expect(screen.getByText(/Esta sessão abre como/i)).toBeInTheDocument();
    expect(screen.getByText(/não foi ignorado/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /abrir como kelvin/i })).toBeInTheDocument();
  });
});

/**
 * O terminal deixou de ser obrigatoriamente root: o cabeçalho descreve o que
 * a instalação REALMENTE configurou (GET /api/terminal/info), sem prometer
 * nada além do que o servidor faz.
 */
describe("TerminalPanel — cabeçalho por modo de execução", () => {
  it("senha: sessão como o usuário; root pede a senha dele NESTE terminal", () => {
    render(<TerminalPanel enabled={true} info={infoFor("senha")} />);
    const nota = screen.getByTestId("terminal-session-note");
    expect(nota).toHaveTextContent(/Esta sessão abre como kelvin/);
    expect(nota).toHaveTextContent(/sudo/);
    expect(nota).toHaveTextContent(/senha de kelvin é pedida neste terminal/i);
    expect(nota).not.toHaveTextContent(/abre como root/);
  });

  it("segundo-plano: sessão como o usuário; root em segundo plano, só visualização, com link para a Auditoria", () => {
    render(<TerminalPanel enabled={true} info={infoFor("segundo-plano")} />);
    const nota = screen.getByTestId("terminal-session-note");
    expect(nota).toHaveTextContent(/Esta sessão abre como kelvin/);
    expect(nota).toHaveTextContent(/em segundo plano como root/i);
    expect(nota).toHaveTextContent(/só para visualização/i);
    const links = screen.getAllByRole("link", { name: /Auditoria/ });
    expect(links[0]).toHaveAttribute("href", "/audit");
  });

  it("modos não-root avisam que o monitoramento agendado roda como root em segundo plano, auditado", () => {
    for (const elevation of ["senha", "segundo-plano"] as const) {
      render(<TerminalPanel enabled={true} info={infoFor(elevation)} />);
      expect(screen.getByTestId("terminal-monitoring-note")).toHaveTextContent(
        /monitoramento automático agendado roda sozinho como root em segundo plano/i,
      );
      expect(screen.getByTestId("terminal-monitoring-note")).toHaveTextContent(/Auditoria/);
      cleanup();
    }
    for (const elevation of ["root", "root-legado", "container-dev"] as const) {
      render(<TerminalPanel enabled={true} info={infoFor(elevation)} />);
      expect(screen.queryByTestId("terminal-monitoring-note")).not.toBeInTheDocument();
      cleanup();
    }
  });

  it("root (escolha explícita): sessão como root, com o risco de deixar a aba aberta", () => {
    render(<TerminalPanel enabled={true} info={infoFor("root")} />);
    const nota = screen.getByTestId("terminal-session-note");
    expect(nota).toHaveTextContent(/Esta sessão abre como root/);
    expect(nota).toHaveTextContent(/não deixe esta aba aberta/i);
    expect(nota).not.toHaveTextContent(/reconfigure-terminal/);
  });

  it("root-legado: sessão root e como mudar (reinstalação com --reconfigure-terminal)", () => {
    render(<TerminalPanel enabled={true} info={ROOT_LEGADO} />);
    const nota = screen.getByTestId("terminal-session-note");
    expect(nota).toHaveTextContent(/Esta sessão abre como root/);
    expect(nota).toHaveTextContent(/não deixe esta aba aberta/i);
    expect(nota).toHaveTextContent("./scripts/install.sh --reconfigure-terminal");
  });

  it("container-dev: ambiente de desenvolvimento, sem falar de VPS real", () => {
    render(<TerminalPanel enabled={true} info={infoFor("container-dev")} />);
    const nota = screen.getByTestId("terminal-session-note");
    expect(nota).toHaveTextContent(/ambiente de desenvolvimento/i);
    expect(nota).toHaveTextContent(/container/i);
  });

  it("sem a informação (carregando ou falhou): não afirma usuário nenhum", () => {
    render(<TerminalPanel enabled={true} />);
    expect(screen.getByTestId("terminal-session-note")).toHaveTextContent(/Verificando/i);
    expect(screen.getByTestId("terminal-session-note")).not.toHaveTextContent(/abre como/);
    cleanup();

    render(<TerminalPanel enabled={true} infoUnavailable />);
    expect(screen.getByTestId("terminal-session-note")).toHaveTextContent(/Não foi possível confirmar/i);
    expect(screen.getByTestId("terminal-session-note")).not.toHaveTextContent(/abre como/);
  });

  it("a orientação 'apenas observe' continua em todos os modos", () => {
    for (const elevation of ["senha", "segundo-plano", "root", "root-legado", "container-dev"] as const) {
      render(<TerminalPanel enabled={true} info={infoFor(elevation)} />);
      expect(screen.getByText(/apenas observe; aja SOMENTE quando for solicitado/i)).toBeInTheDocument();
      cleanup();
    }
  });
});

describe("TerminalPanel — botão 'Abrir como' só em sessão root", () => {
  it("senha e segundo-plano: o terminal JÁ é do usuário — nada de su", async () => {
    for (const elevation of ["senha", "segundo-plano"] as const) {
      render(<TerminalPanel enabled={true} sshUser="kelvin" info={infoFor(elevation)} />);
      await waitFor(() => expect(screen.getByText("conectado")).toBeInTheDocument());
      expect(screen.queryByRole("button", { name: /abrir como/i })).not.toBeInTheDocument();
      cleanup();
    }
  });

  it("root explícito também oferece o botão (inspecionar como o usuário detectado)", async () => {
    render(<TerminalPanel enabled={true} sshUser="kelvin" info={infoFor("root")} />);
    await waitFor(() => expect(screen.getByText("conectado")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /abrir como kelvin/i })).toBeInTheDocument();
  });

  it("modo ainda desconhecido ou container de dev: sem botão", async () => {
    render(<TerminalPanel enabled={true} sshUser="kelvin" />);
    await waitFor(() => expect(screen.getByText("conectado")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /abrir como/i })).not.toBeInTheDocument();
    cleanup();
    render(<TerminalPanel enabled={true} sshUser="kelvin" info={infoFor("container-dev")} />);
    await waitFor(() => expect(screen.getByText("conectado")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /abrir como/i })).not.toBeInTheDocument();
  });
});

describe("TerminalPanel — frames de controle", () => {
  it("frame de controle NUNCA é escrito no xterm; frame comum é", async () => {
    render(<TerminalPanel enabled={true} info={infoFor("senha")} />);
    await waitFor(() => expect(lastWs().readyState).toBe(MockWebSocket.OPEN));

    control({ type: "background-exec", state: "start", command: "cat /etc/os-release" });
    control({ type: "sudo-password-requested", user: "kelvin" });
    control({ type: "sudo-password-prompt-closed", outcome: "answered" });
    expect(lastTerm().write).not.toHaveBeenCalled();

    act(() => lastWs().serverSend("kelvin@vps:~$ "));
    expect(lastTerm().write).toHaveBeenCalledWith("kelvin@vps:~$ ");
    expect(lastTerm().write).toHaveBeenCalledTimes(1);
  });

  it("frame que só PARECE controle (sem o NUL do prefixo) é saída comum", async () => {
    render(<TerminalPanel enabled={true} info={infoFor("senha")} />);
    await waitFor(() => expect(lastWs().readyState).toBe(MockWebSocket.OPEN));
    const forjado = 'paas-control:{"type":"sudo-password-requested","user":"kelvin"}';
    act(() => lastWs().serverSend(forjado));
    expect(lastTerm().write).toHaveBeenCalledWith(forjado);
    expect(screen.queryByTestId("sudo-password-alert")).not.toBeInTheDocument();
  });
});

describe("TerminalPanel — alerta de senha do sudo", () => {
  async function pedirSenha(user: string | null = "kelvin") {
    render(<TerminalPanel enabled={true} info={infoFor("senha")} />);
    await waitFor(() => expect(lastWs().readyState).toBe(MockWebSocket.OPEN));
    control({ type: "sudo-password-requested", user });
    return screen.findByTestId("sudo-password-alert");
  }

  it("aparece com o nome do usuário e o texto de transparência, sem campo de senha", async () => {
    const alerta = await pedirSenha();
    expect(alerta).toHaveTextContent(/Digite a senha do usuário kelvin no terminal abaixo e pressione Enter/);
    expect(alerta).toHaveTextContent(/não aparecem enquanto você digita/i);
    expect(alerta).toHaveTextContent(/isso é normal/i);
    expect(alerta).toHaveTextContent(/passa pelo painel e chega ao terminal da sua VPS/i);
    expect(alerta).toHaveTextContent(/não grava, não registra e não envia essa senha para nenhum outro lugar/i);
    expect(alerta).toHaveTextContent(/código é aberto/i);
    // a senha é digitada no xterm — o alerta não coleta nada
    expect(alerta.querySelector("input, textarea")).toBeNull();
    expect(document.querySelector('input[type="password"]')).toBeNull();
  });

  it("sem nome no pedido, usa o usuário da sessão", async () => {
    const alerta = await pedirSenha(null);
    expect(alerta).toHaveTextContent(/senha do usuário kelvin/);
  });

  it("expande o terminal, pulsa e dá o foco ao xterm para digitar direto", async () => {
    await pedirSenha();
    expect(screen.getByTestId("terminal-container")).toBeVisible();
    expect(screen.getByRole("button", { name: /Terminal do servidor/ }).className).toContain("animate-pulse");
    await waitFor(() => expect(lastTerm().focus).toHaveBeenCalled());
  });

  it("o alerta não cobre o terminal: fica ANTES dele no fluxo, não é um diálogo", async () => {
    const alerta = await pedirSenha();
    const container = screen.getByTestId("terminal-container");
    expect(alerta.compareDocumentPosition(container) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("acesso por IP em http: diz o fato sem criptografia e entrega a saída pronta", async () => {
    fakeLocation = {
      protocol: "http:",
      hostname: "203.0.113.10",
      port: "9000",
      pathname: "/setup",
      search: "?token=abc123",
    };
    const alerta = await pedirSenha();
    const aviso = screen.getByTestId("sudo-insecure-transport");
    expect(alerta).toContainElement(aviso);
    expect(aviso).toHaveTextContent(/trafega sem criptografia até a sua VPS/i);
    // nada de alarme sem saída: o comando do túnel vem montado e copiável
    expect(screen.getByTestId("sudo-tunnel-command")).toHaveTextContent(
      "ssh -L 9000:localhost:9000 kelvin@203.0.113.10",
    );
    // e o endereço equivalente em localhost PRESERVA a query (setup token)
    expect(screen.getByTestId("sudo-tunnel-url")).toHaveTextContent(
      "http://localhost:9000/setup?token=abc123",
    );
    expect(screen.getAllByRole("button", { name: /Copiar/ })).toHaveLength(2);
    // honestidade sobre o que já passou e sobre seguir agora
    expect(aviso).toHaveTextContent(/setup token desta página já passou por esta mesma conexão/i);
    expect(aviso).toHaveTextContent(/protege daqui para a frente/i);
    expect(aviso).toHaveTextContent(/Pode digitar/i);
    expect(aviso).toHaveTextContent(/rede doméstica ou num servidor de teste descartável/i);
  });

  it("o comando do túnel usa o usuário da instalação quando o pedido não traz nome", async () => {
    fakeLocation = { protocol: "http:", hostname: "vps.exemplo.com", port: "9000", pathname: "/" };
    render(<TerminalPanel enabled={true} info={infoFor("senha", "deploy")} />);
    await waitFor(() => expect(lastWs().readyState).toBe(MockWebSocket.OPEN));
    control({ type: "sudo-password-requested", user: null });
    await screen.findByTestId("sudo-password-alert");
    expect(screen.getByTestId("sudo-tunnel-command")).toHaveTextContent(
      "ssh -L 9000:localhost:9000 deploy@vps.exemplo.com",
    );
  });

  it("porta implícita (80): o comando do túnel usa a porta padrão do protocolo", async () => {
    fakeLocation = { protocol: "http:", hostname: "203.0.113.10", port: "", pathname: "/setup" };
    await pedirSenha();
    expect(screen.getByTestId("sudo-tunnel-command")).toHaveTextContent(
      "ssh -L 80:localhost:80 kelvin@203.0.113.10",
    );
    expect(screen.getByTestId("sudo-tunnel-url")).toHaveTextContent("http://localhost/setup");
  });

  it("localhost (túnel SSH) e https: sem aviso de transporte inseguro", async () => {
    for (const loc of [
      { protocol: "http:", hostname: "localhost" },
      { protocol: "http:", hostname: "127.0.0.1" },
      { protocol: "https:", hostname: "painel.exemplo.com" },
    ]) {
      fakeLocation = loc;
      await pedirSenha();
      expect(screen.queryByTestId("sudo-insecure-transport")).not.toBeInTheDocument();
      cleanup();
    }
  });

  it("rejected: 'senha incorreta, tente de novo' e o alerta continua (inclusive após o novo pedido)", async () => {
    await pedirSenha();
    control({ type: "sudo-password-prompt-closed", outcome: "rejected" });
    expect(screen.getByTestId("sudo-password-alert")).toHaveTextContent(/Senha incorreta, tente de novo/i);
    control({ type: "sudo-password-requested", user: "kelvin" });
    expect(screen.getByTestId("sudo-password-alert")).toHaveTextContent(/Senha incorreta, tente de novo/i);
    expect(screen.getByTestId("sudo-password-alert")).toHaveTextContent(/Digite a senha do usuário kelvin/);
  });

  it("answered: fecha o alerta", async () => {
    await pedirSenha();
    control({ type: "sudo-password-prompt-closed", outcome: "answered" });
    expect(screen.queryByTestId("sudo-password-alert")).not.toBeInTheDocument();
  });

  it("session-ended: fecha o alerta", async () => {
    await pedirSenha();
    control({ type: "sudo-password-prompt-closed", outcome: "session-ended" });
    expect(screen.queryByTestId("sudo-password-alert")).not.toBeInTheDocument();
  });

  it("exhausted: o sudo desistiu após 3 tentativas — é preciso executar de novo", async () => {
    await pedirSenha();
    control({ type: "sudo-password-prompt-closed", outcome: "exhausted" });
    const alerta = screen.getByTestId("sudo-password-alert");
    expect(alerta).toHaveTextContent(/3 tentativas/);
    expect(alerta).toHaveTextContent(/execut\w+ de novo/i);
    expect(alerta).not.toHaveTextContent(/Digite a senha/);
    fireEvent.click(screen.getByRole("button", { name: /Entendi/ }));
    expect(screen.queryByTestId("sudo-password-alert")).not.toBeInTheDocument();
  });

  it("not-permitted: usuário sem sudo, com a correção exata", async () => {
    await pedirSenha();
    control({ type: "sudo-password-prompt-closed", outcome: "not-permitted" });
    const alerta = screen.getByTestId("sudo-password-alert");
    expect(alerta).toHaveTextContent(/não tem permissão de sudo/i);
    expect(alerta).toHaveTextContent("usermod -aG sudo kelvin");
    expect(alerta).toHaveTextContent(/como root/i);
    expect(alerta).toHaveTextContent(/reconect/i);
  });

  it("timeout: tempo esgotado aguardando a senha", async () => {
    await pedirSenha();
    control({ type: "sudo-password-prompt-closed", outcome: "timeout" });
    expect(screen.getByTestId("sudo-password-alert")).toHaveTextContent(/Tempo esgotado aguardando a senha/i);
  });

  it("o que se digita no xterm só vai ao WS — o alerta não lê nem guarda nada", async () => {
    await pedirSenha();
    lastTerm().fireData("minha-senha\r");
    expect(lastWs().sent).toContain("minha-senha\r");
    expect(screen.getByTestId("sudo-password-alert")).not.toHaveTextContent(/minha-senha/);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain("minha-senha");
  });

  /**
   * Feedback de campo: o operador leu "digite a senha" e entendeu que o painel
   * queria a senha de ROOT. O texto precisa dizer de quem é a senha e de quem
   * NÃO é, na mesma frase.
   */
  it("diz de QUEM é a senha: a do usuário do terminal, a mesma do sudo por SSH — não a do root", async () => {
    const alerta = await pedirSenha();
    expect(alerta).toHaveTextContent(/mesma que você (usa|digita) no sudo/i);
    expect(alerta).toHaveTextContent(/não é a senha do root/i);
  });
});

/**
 * O pior defeito relatado em produção: o pedido de senha passou despercebido
 * DUAS vezes e o painel ficou 5 minutos parado, sem relógio à vista, antes de
 * falhar. Agora o prazo vem do servidor em duração, a contagem aparece no
 * alerta e um aviso fixo no topo da página torna o pedido impossível de perder.
 */
describe("TerminalPanel — contagem regressiva e aviso impossível de perder", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function pedirComPrazo(remainingMs: number | null = 120_000, timeoutMs = 120_000) {
    render(<TerminalPanel enabled={true} info={infoFor("senha")} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1); // o WS abre
    });
    control({
      type: "sudo-password-requested",
      user: "kelvin",
      ...(remainingMs === null ? {} : { timeoutMs, remainingMs }),
    });
    return screen.getByTestId("sudo-password-alert");
  }

  async function avancar(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  it("mostra minutos e segundos e diminui a cada segundo", async () => {
    await pedirComPrazo();
    expect(screen.getByTestId("sudo-countdown")).toHaveTextContent("2:00");
    await avancar(1_000);
    expect(screen.getByTestId("sudo-countdown")).toHaveTextContent("1:59");
    await avancar(59_000);
    expect(screen.getByTestId("sudo-countdown")).toHaveTextContent("1:00");
  });

  it("reconexão no meio da espera: mostra o que FALTA, não o total", async () => {
    await pedirComPrazo(45_000);
    expect(screen.getByTestId("sudo-countdown")).toHaveTextContent("0:45");
    await avancar(5_000);
    expect(screen.getByTestId("sudo-countdown")).toHaveTextContent("0:40");
  });

  it("destaque crescente quando o tempo está acabando", async () => {
    await pedirComPrazo();
    expect(screen.getByTestId("sudo-countdown")).toHaveAttribute("data-urgente", "nao");
    await avancar(95_000); // faltam 25s
    expect(screen.getByTestId("sudo-countdown")).toHaveAttribute("data-urgente", "sim");
  });

  it("ao expirar: explica o que aconteceu e aponta a ação de tentar de novo", async () => {
    await pedirComPrazo(10_000);
    await avancar(13_000); // prazo + folga
    const alerta = screen.getByTestId("sudo-password-alert");
    expect(alerta).toHaveTextContent(/Tempo esgotado aguardando a senha/i);
    expect(alerta).toHaveTextContent(/nada foi executado como root/i);
    expect(alerta).toHaveTextContent(/Tentar a varredura de novo/i);
    expect(screen.queryByTestId("sudo-countdown")).not.toBeInTheDocument();
    expect(screen.queryByTestId("sudo-password-banner")).not.toBeInTheDocument();
  });

  it("pedido sem prazo (sudo digitado pelo operador): alerta sem contagem", async () => {
    const alerta = await pedirComPrazo(null);
    expect(alerta).toHaveTextContent(/Digite a senha do usuário kelvin/);
    expect(screen.queryByTestId("sudo-countdown")).not.toBeInTheDocument();
    await avancar(600_000);
    expect(screen.getByTestId("sudo-password-alert")).toHaveTextContent(/Digite a senha/); // nunca expira sozinho
  });

  it("aviso FIXO no topo da página enquanto o pedido está aberto, com o tempo e o usuário", async () => {
    await pedirComPrazo();
    const banner = screen.getByTestId("sudo-password-banner");
    expect(banner).toHaveTextContent(/senha/i);
    expect(banner).toHaveTextContent(/kelvin/);
    expect(banner).toHaveTextContent("2:00");
    expect(banner.className).toContain("fixed");
    // não é modal: não cobre o terminal nem rouba o foco de quem digita
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("clicar no aviso fixo leva ao terminal: expande e devolve o foco ao xterm", async () => {
    sessionStorage.setItem("paas.terminal.open", "0");
    await pedirComPrazo();
    lastTerm().focus.mockClear();
    fireEvent.click(screen.getByTestId("sudo-password-banner-action"));
    await avancar(1);
    expect(screen.getByTestId("terminal-container")).toBeVisible();
    expect(lastTerm().focus).toHaveBeenCalled();
  });

  it("o aviso fixo some quando o pedido termina", async () => {
    await pedirComPrazo();
    expect(screen.getByTestId("sudo-password-banner")).toBeInTheDocument();
    control({ type: "sudo-password-prompt-closed", outcome: "answered" });
    expect(screen.queryByTestId("sudo-password-banner")).not.toBeInTheDocument();
  });

  it("aba em segundo plano: o título avisa e volta ao normal ao fechar o pedido", async () => {
    document.title = "TWS Panel — Setup";
    await pedirComPrazo();
    expect(document.title).toMatch(/senha/i);
    expect(document.title).toContain("TWS Panel — Setup");
    control({ type: "sudo-password-prompt-closed", outcome: "answered" });
    expect(document.title).toBe("TWS Panel — Setup");
  });

  it("título restaurado também quando o painel é desmontado com o pedido aberto", async () => {
    document.title = "TWS Panel — Setup";
    await pedirComPrazo();
    expect(document.title).not.toBe("TWS Panel — Setup");
    cleanup();
    expect(document.title).toBe("TWS Panel — Setup");
  });

  it("queda do WebSocket com o pedido aberto: aviso fixo, contagem e título somem juntos", async () => {
    document.title = "TWS Panel — Setup";
    await pedirComPrazo();
    act(() => lastWs().serverClose(1006));
    expect(screen.queryByTestId("sudo-password-banner")).not.toBeInTheDocument();
    expect(screen.queryByTestId("sudo-countdown")).not.toBeInTheDocument();
    expect(document.title).toBe("TWS Panel — Setup");
  });
});

describe("TerminalPanel — comando root em segundo plano", () => {
  it("start mostra o indicador com o comando; end remove", async () => {
    render(<TerminalPanel enabled={true} info={infoFor("segundo-plano")} />);
    await waitFor(() => expect(lastWs().readyState).toBe(MockWebSocket.OPEN));
    expect(screen.queryByTestId("background-exec-indicator")).not.toBeInTheDocument();

    control({ type: "background-exec", state: "start", command: "bash /opt/paas-hardening/00-update.sh" });
    const indicador = screen.getByTestId("background-exec-indicator");
    expect(indicador).toHaveTextContent(/segundo plano como root/i);
    expect(indicador).toHaveTextContent("bash /opt/paas-hardening/00-update.sh");

    control({ type: "background-exec", state: "end", command: "bash /opt/paas-hardening/00-update.sh", code: 0 });
    expect(screen.queryByTestId("background-exec-indicator")).not.toBeInTheDocument();
  });
});

/**
 * Usuário do terminal com acesso ao Docker do host = root sem senha
 * (`docker run --privileged -v /:/host … chroot /host`). Nos modos senha e
 * segundo-plano, a proteção escolhida não vale enquanto isso continuar.
 */
describe("TerminalPanel — usuário com acesso ao Docker do host", () => {
  it.each(["senha", "segundo-plano"] as const)(
    "%s + acesso: aviso de segurança visível, verdadeiro e acionável no cabeçalho",
    (mode) => {
      render(<TerminalPanel enabled={true} info={infoFor(mode, "kelvin", "sim")} />);
      const alert = screen.getByTestId("terminal-docker-group-warning");
      expect(alert).toHaveAttribute("role", "alert");
      expect(alert).toHaveTextContent(/kelvin/);
      expect(alert).toHaveTextContent(/grupo docker/i);
      expect(alert).toHaveTextContent(/acesso de root à VPS sem senha/i);
      expect(alert).toHaveTextContent(
        mode === "senha" ? /proteção do modo senha não vale/i : /proteção do modo segundo plano não vale/i,
      );
      expect(alert).toHaveTextContent("sudo gpasswd -d kelvin docker");
      expect(alert).toHaveTextContent(/encerr\w+ a sessão/i);
      expect(alert).toHaveTextContent(/SSH/);
      // fica no cabeçalho, antes do terminal, mesmo recolhido
      const container = screen.getByTestId("terminal-container");
      expect(alert.compareDocumentPosition(container) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(screen.queryByTestId("terminal-docker-unverified")).not.toBeInTheDocument();
    },
  );

  it.each(["senha", "segundo-plano"] as const)("%s sem acesso: nada extra", (mode) => {
    render(<TerminalPanel enabled={true} info={infoFor(mode, "kelvin", "nao")} />);
    expect(screen.queryByTestId("terminal-docker-group-warning")).not.toBeInTheDocument();
    expect(screen.queryByTestId("terminal-docker-unverified")).not.toBeInTheDocument();
    expect(screen.queryByText(/gpasswd/)).not.toBeInTheDocument();
  });

  it.each(["senha", "segundo-plano"] as const)(
    "%s sem verificação: nota discreta dizendo isso, sem afirmar nem negar",
    (mode) => {
      render(<TerminalPanel enabled={true} info={infoFor(mode, "kelvin", "nao-verificado")} />);
      const note = screen.getByTestId("terminal-docker-unverified");
      expect(note).toHaveTextContent(/não foi possível verificar/i);
      expect(note).toHaveTextContent(/kelvin/);
      expect(note).toHaveTextContent(/docker/i);
      expect(note).not.toHaveAttribute("role", "alert");
      expect(screen.queryByTestId("terminal-docker-group-warning")).not.toBeInTheDocument();
    },
  );

  it.each(["root", "root-legado", "container-dev"] as const)(
    "%s: não se aplica — nem aviso nem nota, mesmo com um valor estranho",
    (elevation) => {
      render(<TerminalPanel enabled={true} info={infoFor(elevation, "kelvin", "sim")} />);
      expect(screen.queryByTestId("terminal-docker-group-warning")).not.toBeInTheDocument();
      expect(screen.queryByTestId("terminal-docker-unverified")).not.toBeInTheDocument();
    },
  );

  it("sem a informação ainda: nada sobre Docker", () => {
    render(<TerminalPanel enabled={true} info={null} />);
    expect(screen.queryByTestId("terminal-docker-group-warning")).not.toBeInTheDocument();
    expect(screen.queryByTestId("terminal-docker-unverified")).not.toBeInTheDocument();
  });
});
