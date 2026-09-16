/**
 * TerminalPanel — terminal web embutido (visão dupla do wizard).
 *
 * Janela contida DENTRO da área de conteúdo do wizard (estilo IDE: borda
 * arredondada, sombra, barra de título), em todos os 4 passos: em cima a UI
 * formatada (cards/fases), embaixo o terminal real ao vivo do servidor
 * (xterm.js + WebSocket + PTY no alvo). Leigos acompanham o formatado;
 * técnicos veem os comandos rodando de verdade — e quando algo pede
 * senha/confirmação, a resposta é digitada DIRETO aqui (o input segue pelo
 * PTY; o painel nunca lê/armazena o que é digitado).
 *
 * REGRAS DE UX/SEGURANÇA (feedback de campo):
 *  - BLOQUEADO até o setup token ser validado: sem token válido o painel
 *    renderiza apenas um placeholder informativo — NENHUM WebSocket é aberto
 *    e nenhum input é aceito;
 *  - ao validar o token (prop `enabled` → true), o WS conecta IMEDIATAMENTE;
 *  - começa RECOLHIDO, com a orientação fixa no cabeçalho ("apenas observe;
 *    aja SOMENTE quando for solicitado");
 *  - o cabeçalho diz a VERDADE sobre com qual usuário a sessão abre e como
 *    os comandos de root rodam, lendo GET /api/terminal/info (prop `info`,
 *    buscada pelo wizard só com o terminal liberado). Nunca afirma um modo
 *    que o servidor não declarou: enquanto a info não chega (ou se falhou),
 *    diz só isso. Por modo (`elevation`):
 *      · senha: sessão como o usuário; o que precisa de root roda aqui com
 *        sudo e a senha DELE é pedida neste terminal;
 *      · segundo-plano: sessão como o usuário; o root roda em segundo plano
 *        pelo host bridge, a saída aqui é só visualização e fica na Auditoria;
 *      · root / root-legado: sessão root + risco de deixar a aba aberta; no
 *        legado, como mudar (./scripts/install.sh --reconfigure-terminal);
 *      · container-dev: ambiente de desenvolvimento (container descartável);
 *    nos modos não-root, uma linha avisa que o monitoramento AGENDADO roda
 *    sozinho como root em segundo plano, auditado (não há quem digite senha);
 *  - usuário com acesso ao Docker do host (`info.hostDockerAccess`, verificado
 *    NO HOST pelo servidor): quem escreve no docker.sock — em geral o grupo
 *    docker — obtém root sem senha, e a proteção dos modos senha/segundo-plano
 *    deixa de valer. Só nesses dois modos:
 *      · "sim" → aviso de segurança destacado (role=alert) no cabeçalho, com
 *        o comando para corrigir (`sudo gpasswd -d <usuário> docker`) e que é
 *        preciso encerrar a sessão (este terminal e as sessões SSH) para valer;
 *      · "nao-verificado" → nota discreta dizendo que não deu para verificar
 *        (nunca afirma nem nega);
 *      · "nao" → nada extra.
 *    Nas sessões root e no container de dev não se aplica e nada aparece. O
 *    terminal não é bloqueado: a decisão é do operador;
 *  - botão "abrir como <usuário>" SÓ em sessão root (root/root-legado), com
 *    `sshUser` VÁLIDO (isValidSshUsername) e sessão conectada: digita
 *    `su - <usuário>` pelo MESMO caminho de input do xterm (relay puro, nada
 *    logado), para o operador inspecionar o servidor como o usuário detectado.
 *    A sessão segue root por baixo e um `exit` volta ao root (o title diz
 *    isso). Nos modos senha/segundo-plano o terminal JÁ abre como o usuário:
 *    o botão não existe (um `su -` ali só pediria senha à toa);
 *  - frames de controle do servidor (prefixo "\u0000paas-control:", decodificados
 *    com parseTerminalControl) NUNCA são escritos no xterm;
 *  - pedido de senha do sudo (sudo-password-requested): expande, pulsa, rola
 *    o painel para o centro da tela e dá FOCO ao xterm. O alerta fica ACIMA do
 *    terminal, dentro da janela, sem sobrepor a área de digitação — um modal
 *    no meio da tela cobriria o terminal e roubaria o foco. Ele NÃO tem campo
 *    de senha: a senha é digitada no xterm e segue o relay puro; o painel não
 *    lê, não guarda e não inspeciona o que é digitado. Texto de transparência
 *    obrigatório (por onde a senha passa e o que o painel não faz com ela);
 *  - transporte inseguro: página fora de https E fora do túnel SSH
 *    (localhost/127.0.0.1/[::1]) → aviso no alerta. O texto diz o fato em uma
 *    frase e entrega a SAÍDA pronta (feedback de campo: o aviso anterior só
 *    assustava e deixava a pessoa travada): o comando do túnel montado com o
 *    usuário do terminal, o host desta URL e a porta desta página, o endereço
 *    equivalente em localhost preservando a query (o setup token vive nela),
 *    a nota honesta de que o token já trafegou nesta conexão — o túnel protege
 *    daqui para a frente — e o que significa seguir agora mesmo assim. Não
 *    bloqueia a digitação: a decisão é do operador;
 *  - desfechos do prompt: rejected mantém o alerta com "senha incorreta";
 *    answered/session-ended fecham; exhausted/not-permitted/timeout trocam o
 *    pedido por uma explicação acionável até o operador dispensar;
 *  - modo segundo-plano: indicador discreto do comando root em execução
 *    (background-exec start/end); a saída espelhada chega como frame comum;
 *  - ao cair o WebSocket, alerta de senha e indicador são limpos: o servidor
 *    reenvia o pedido de senha a quem reconecta com o prompt aberto, e um
 *    indicador antigo poderia afirmar algo que já terminou;
 *  - altura colapsável/expansível, estado persistido em sessionStorage;
 *  - alerta pulsante (evento "paas:terminal-attention") quando uma fase
 *    precisa de ação no terminal — o painel se expande sozinho;
 *  - reconexão automática com backoff exponencial + jitter (teto 30s) e
 *    reattach por clientId: a sessão vive no SERVIDOR, então quedas de WS
 *    não interrompem fases — ao reconectar, o scrollback é retransmitido;
 *  - se o servidor recusar com 4009 (terminal em uso em OUTRA aba/janela),
 *    NÃO reconecta: sem isso duas abas disputavam a sessão em ping-pong
 *    infinito (~1 conexão/1.5s) e derrubavam execuções em andamento.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  isValidSshUsername,
  parseTerminalControl,
  type SudoPromptOutcome,
  type TerminalControlMessage,
  type TerminalInfoResponse,
} from "@paas/core";
import { getSetupToken } from "@/lib/api";
import { pageLocation } from "@/lib/page-location";
import { isInsecureTransport, localhostUrl, sshTunnelCommand } from "@/lib/terminal-info";
import { CopyButton } from "@/components/CopyButton";
import { ChevronDown, ChevronUp, Cog, Info, KeyRound, Lock, ShieldAlert, TerminalSquare } from "lucide-react";

/** Evento disparado pela UI (ex.: fase aguardando confirmação) para acender
 * o alerta pulsante do terminal ("olhe o terminal"). */
export const TERMINAL_ATTENTION_EVENT = "paas:terminal-attention";

/** Evento disparado quando a espera por ação TERMINA (job concluído/abortado
 * ou acesso confirmado) — apaga o alerta pulsante. */
export const TERMINAL_ATTENTION_CLEAR_EVENT = "paas:terminal-attention-clear";

const STORAGE_KEY = "paas.terminal.open";
const PANEL_HEIGHT_PX = 320;

const XTERM_THEME = {
  background: "#0b0f0d",
  foreground: "#d7e3dd",
  cursor: "#34d399",
  cursorAccent: "#0b0f0d",
  selectionBackground: "#134e4a",
  black: "#0b0f0d",
  red: "#f87171",
  green: "#34d399",
  yellow: "#fbbf24",
  blue: "#60a5fa",
  magenta: "#c084fc",
  cyan: "#22d3ee",
  white: "#e2e8f0",
  brightBlack: "#475569",
  brightRed: "#fca5a5",
  brightGreen: "#6ee7b7",
  brightYellow: "#fde68a",
  brightBlue: "#93c5fd",
  brightMagenta: "#d8b4fe",
  brightCyan: "#67e8f9",
  brightWhite: "#f8fafc",
};

type WsStatus = "connecting" | "online" | "offline" | "busy";

/** Códigos de close definidos pelo servidor (apps/server/src/routes/terminal.ts). */
const WS_CLOSE_REPLACED = 4000; // o MESMO clientId reanexou por outra conexão
const WS_CLOSE_BUSY = 4009; // sessão tem dono (outro clientId): NÃO reconectar

const CLIENT_ID_KEY = "paas.terminal.client-id";

/**
 * Identidade estável DESTA aba para o reattach anti-ping-pong: o servidor só
 * deixa o dono (mesmo clientId) reanexar; outro clientId é recusado (4009).
 */
function terminalClientId(): string {
  let id = sessionStorage.getItem(CLIENT_ID_KEY);
  if (!id) {
    id =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `c-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    sessionStorage.setItem(CLIENT_ID_KEY, id);
  }
  return id;
}

function terminalWsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  const token = getSetupToken();
  const params = new URLSearchParams({ clientId: terminalClientId() });
  if (token) params.set("token", token);
  return `${proto}://${window.location.host}/api/terminal/ws?${params.toString()}`;
}

interface TerminalPanelProps {
  /** true somente DEPOIS de o setup token ter sido validado pelo wizard.
   * Antes disso o terminal nem tenta conectar (placeholder bloqueado). */
  enabled: boolean;
  /**
   * Usuário não-root detectado no servidor (ou escolhido pelo operador) na
   * etapa de Segurança. OPCIONAL de propósito: sem ele a nota do cabeçalho
   * segue genérica, e nenhum uso existente do painel precisa mudar.
   */
  sshUser?: string | null;
  /**
   * Com qual usuário o terminal abre e como o root é obtido
   * (GET /api/terminal/info). Ausente/null enquanto carrega ou se falhou —
   * o cabeçalho então não afirma usuário nenhum.
   */
  info?: TerminalInfoResponse | null;
  /** A consulta de /api/terminal/info falhou. */
  infoUnavailable?: boolean;
}

/** Desfechos do prompt do sudo que exigem explicação (não fecham sozinhos). */
type SudoFailureOutcome = Extract<SudoPromptOutcome, "exhausted" | "not-permitted" | "timeout">;

type SudoAlert =
  /** O sudo está pedindo a senha agora. `retry`: a anterior foi recusada. */
  | { kind: "prompt"; user: string | null; retry: boolean; seq: number }
  /** O sudo desistiu / não pode / o painel cansou de esperar. */
  | { kind: "failed"; user: string | null; outcome: SudoFailureOutcome };

export function TerminalPanel({ enabled, sshUser, info, infoUnavailable }: TerminalPanelProps) {
  // Começa RECOLHIDO por padrão (o usuário expande se quiser acompanhar).
  const [open, setOpen] = useState(() => sessionStorage.getItem(STORAGE_KEY) === "1");
  const [attention, setAttention] = useState(false);
  const [status, setStatus] = useState<WsStatus>("connecting");
  const [sudoAlert, setSudoAlert] = useState<SudoAlert | null>(null);
  /** Comando root rodando agora em segundo plano (modo segundo-plano). */
  const [backgroundCommand, setBackgroundCommand] = useState<string | null>(null);
  const sectionRef = useRef<HTMLElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptsRef = useRef(0);

  /**
   * ÚNICO caminho de input do painel: o que o operador digita no xterm e o
   * comando do botão "abrir como <usuário>" saem exatamente por aqui — bytes
   * crus no MESMO WebSocket. Nada é logado, auditado ou inspecionado (regra de
   * ouro do relay puro; ver apps/server/src/services/terminal-service.ts).
   */
  const sendInput = useCallback((data: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(data);
  }, []);

  /**
   * Mensagens de controle do servidor (nunca chegam ao xterm). Só usa
   * setters de estado — estável, pode ser chamada de dentro do WS.
   */
  const handleControl = useCallback((msg: TerminalControlMessage) => {
    switch (msg.type) {
      case "sudo-password-requested":
        setSudoAlert((prev) => ({
          kind: "prompt",
          user: msg.user,
          // o "senha incorreta" sobrevive ao novo pedido que vem logo depois
          retry: prev?.kind === "prompt" ? prev.retry : false,
          seq: prev?.kind === "prompt" ? prev.seq + 1 : 0,
        }));
        setAttention(true);
        setOpen(true);
        return;
      case "sudo-password-prompt-closed":
        setSudoAlert((prev) => {
          const user = prev?.user ?? null;
          switch (msg.outcome) {
            case "rejected":
              return { kind: "prompt", user, retry: true, seq: prev?.kind === "prompt" ? prev.seq : 0 };
            case "answered":
            case "session-ended":
              return null;
            default:
              return { kind: "failed", user, outcome: msg.outcome };
          }
        });
        return;
      case "background-exec":
        setBackgroundCommand(msg.state === "start" ? msg.command : null);
        return;
    }
  }, []);

  // -------------------------------------------------------------- WS + xterm
  // Só roda quando `enabled` vira true (token validado): conecta NA HORA.
  useEffect(() => {
    if (!enabled) return;

    const term = new Terminal({
      theme: XTERM_THEME,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: 13,
      cursorBlink: true,
      convertEol: false,
      scrollback: 5_000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    termRef.current = term;
    fitRef.current = fit;
    if (containerRef.current) term.open(containerRef.current);

    const dataSub = term.onData(sendInput);

    let disposed = false;
    const connect = () => {
      if (disposed) return;
      // NUNCA conectar sem token: o servidor recusaria o upgrade (401).
      if (!getSetupToken()) return;
      setStatus("connecting");
      const ws = new WebSocket(terminalWsUrl());
      wsRef.current = ws;
      ws.onopen = () => {
        attemptsRef.current = 0;
        setStatus("online");
        // sincroniza o tamanho do PTY ao (re)conectar
        try {
          fit.fit();
          ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
        } catch {
          // container oculto: o resize acontece ao expandir
        }
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data === "string") {
          // Controle primeiro: um frame de controle NUNCA é escrito no xterm.
          const control = parseTerminalControl(ev.data);
          if (control) handleControl(control);
          else term.write(ev.data);
        }
        else if (ev.data instanceof Blob) void ev.data.arrayBuffer().then((b) => term.write(new Uint8Array(b)));
      };
      ws.onclose = (ev: CloseEvent) => {
        if (disposed) return;
        wsRef.current = null;
        // Sem conexão, nada disso é confirmável: o servidor reenvia o pedido de
        // senha a quem reconecta com o prompt aberto; um indicador de segundo
        // plano antigo afirmaria algo que talvez já tenha terminado.
        setSudoAlert((prev) => (prev?.kind === "prompt" ? null : prev));
        setBackgroundCommand(null);
        if (ev.code === WS_CLOSE_BUSY || ev.code === WS_CLOSE_REPLACED) {
          // Sessão em uso por OUTRA aba/janela (ou esta aba reanexou por outra
          // conexão): NÃO reconectar — reconectar aqui é o que gerava o
          // ping-pong infinito derrubando a sessão do dono.
          setStatus("busy");
          return;
        }
        setStatus("offline");
        // Backoff exponencial com jitter: 1s → 2s → 4s → … (teto 30s).
        // Reseta ao conectar com sucesso (ws.onopen).
        const backoff = Math.min(1_000 * 2 ** attemptsRef.current, 30_000);
        attemptsRef.current += 1;
        reconnectRef.current = setTimeout(connect, backoff + Math.random() * 1_000);
      };
      ws.onerror = () => ws.close();
    };
    connect();

    return () => {
      disposed = true;
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      wsRef.current?.close();
      dataSub.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [enabled]);

  // ------------------------------------------------------ resize sincronizado
  useEffect(() => {
    if (!enabled || !open) return;
    const term = termRef.current;
    const fit = fitRef.current;
    const el = containerRef.current;
    if (!term || !fit || !el) return;
    const sync = () => {
      try {
        fit.fit();
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
        }
      } catch {
        // layout ainda instável — próximo evento sincroniza
      }
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    return () => observer.disconnect();
  }, [enabled, open]);

  // ------------------------------------------------- alerta "olhe o terminal"
  useEffect(() => {
    const onAttention = () => {
      setAttention(true);
      setOpen(true);
    };
    const onClear = () => setAttention(false);
    window.addEventListener(TERMINAL_ATTENTION_EVENT, onAttention);
    window.addEventListener(TERMINAL_ATTENTION_CLEAR_EVENT, onClear);
    return () => {
      window.removeEventListener(TERMINAL_ATTENTION_EVENT, onAttention);
      window.removeEventListener(TERMINAL_ATTENTION_CLEAR_EVENT, onClear);
    };
  }, []);

  // o alerta some quando o usuário interage com o terminal
  useEffect(() => {
    const term = termRef.current;
    if (!attention || !term) return;
    const sub = term.onData(() => setAttention(false));
    return () => sub.dispose();
  }, [attention]);

  /**
   * O nome vem da prop e é interpolado num comando de shell: só é aceito se
   * passar pela MESMA validação do resto do sistema (isValidSshUsername, em
   * @paas/core), cujo formato — [a-z_][a-z0-9_-]{0,31} e nunca "root" — não
   * admite espaço, aspas, ";", "$", "\n" nem qualquer metacaractere. Nome fora
   * disso: nenhum botão e nenhum byte enviado.
   */
  const userShellName = sshUser && isValidSshUsername(sshUser) ? sshUser : null;
  const elevation = info?.elevation ?? null;
  const rootSession = elevation === "root" || elevation === "root-legado";
  // Acesso ao Docker do host só importa quando o terminal é de um usuário comum.
  const dockerAccess =
    elevation === "senha" || elevation === "segundo-plano" ? (info?.hostDockerAccess ?? "nao-verificado") : null;
  // Só faz sentido trocar de usuário numa sessão que COMPROVADAMENTE é root;
  // sessão caída/em outra aba não aceita input: não ofereça a ação.
  const canOpenUserShell = rootSession && userShellName !== null && status === "online";

  // ------------------------------------------- pedido de senha: foco no xterm
  // A pessoa vai digitar AGORA: painel no centro da tela e cursor no terminal.
  // Repete a cada novo pedido (seq), inclusive depois de uma senha recusada.
  const promptSeq = sudoAlert?.kind === "prompt" ? sudoAlert.seq : null;
  useEffect(() => {
    if (promptSeq === null || !open) return;
    sectionRef.current?.scrollIntoView?.({ block: "center", behavior: "smooth" });
    termRef.current?.focus();
  }, [promptSeq, open]);

  const openUserShell = useCallback(() => {
    if (!userShellName || !isValidSshUsername(userShellName)) return;
    sendInput(`su - ${userShellName}\n`);
  }, [sendInput, userShellName]);

  const toggle = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      sessionStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      return next;
    });
  }, []);

  // ------------------------------------------------------ bloqueado (sem token)
  if (!enabled) {
    return (
      <section
        aria-label="Terminal do servidor"
        data-testid="terminal-locked"
        className="overflow-hidden rounded-xl border border-dashed border-border bg-muted/20"
      >
        <div className="flex items-center gap-3 px-4 py-3 text-xs text-muted-foreground">
          <Lock className="h-4 w-4 shrink-0" />
          <p>
            🖥️ <strong>Terminal ao vivo do servidor</strong> — bloqueado por segurança. Informe o{" "}
            <strong>setup token</strong> na etapa de boas-vindas para liberá-lo.
          </p>
        </div>
      </section>
    );
  }

  const statusLabel =
    status === "online"
      ? "conectado"
      : status === "connecting"
        ? "conectando…"
        : status === "busy"
          ? "em uso em outra aba"
          : "reconectando…";
  const statusColor =
    status === "online"
      ? "bg-emerald-400"
      : status === "connecting"
        ? "bg-amber-400"
        : "bg-red-400";

  return (
    <section
      ref={sectionRef}
      aria-label="Terminal do servidor"
      className="overflow-hidden rounded-xl border border-[#22302a] bg-[#0b0f0d] shadow-[inset_0_1px_0_0_rgba(255,255,255,0.05),0_12px_40px_rgba(0,0,0,0.5)]"
    >
      {/* Barra de título estilo IDE (janela contida) */}
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className={`flex w-full items-center gap-3 bg-gradient-to-b from-white/[0.05] to-transparent px-4 py-2.5 text-left text-xs font-medium text-emerald-100/90 transition-colors duration-200 hover:bg-white/5 ${
          attention ? "animate-pulse bg-amber-500/20 text-amber-300" : ""
        }`}
      >
        <span className="flex items-center gap-1.5" aria-hidden>
          <span className="h-2.5 w-2.5 rounded-full bg-red-500/80" />
          <span className="h-2.5 w-2.5 rounded-full bg-amber-500/80" />
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-500/80" />
        </span>
        <TerminalSquare className="h-4 w-4" />
        <span>Terminal do servidor — ao vivo</span>
        <span className="flex items-center gap-1.5 text-[10px] font-normal text-muted-foreground">
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full transition-all duration-300 ${statusColor} ${
              status === "online" ? "shadow-[0_0_6px_rgba(52,211,153,0.9)]" : "animate-pulse"
            }`}
          />
          {statusLabel}
        </span>
        {attention && (
          <span className="rounded bg-amber-500 px-1.5 py-0.5 text-[10px] font-bold text-black">
            ⚠️ AÇÃO NECESSÁRIA — OLHE O TERMINAL
          </span>
        )}
        <span className="ml-auto flex items-center gap-1 text-muted-foreground">
          <span className="text-[10px]">{open ? "recolher" : "expandir"}</span>
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
        </span>
      </button>

      {/* Com qual usuário a sessão abre e como o root é obtido — a partir do
          que a instalação configurou (info), nunca de uma suposição. */}
      <div className="flex items-start gap-2 border-t border-white/5 px-4 py-1.5">
        <div className="flex flex-1 flex-col gap-1 text-[10px] leading-relaxed text-emerald-100/45">
          <p className="flex items-start gap-1.5" data-testid="terminal-session-note">
            <Info className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
            <SessionNote info={info ?? null} unavailable={infoUnavailable === true} sshUser={userShellName} />
          </p>
          {(elevation === "senha" || elevation === "segundo-plano") && (
            <p className="flex items-start gap-1.5" data-testid="terminal-monitoring-note">
              <Cog className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
              <span>
                O monitoramento automático agendado roda sozinho como root em segundo plano (não há
                ninguém para digitar senha) e cada comando dele fica registrado na <AuditLink />.
              </span>
            </p>
          )}
          {dockerAccess === "nao-verificado" && info && (
            <p className="flex items-start gap-1.5" data-testid="terminal-docker-unverified">
              <Info className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
              <span>
                Não foi possível verificar se <strong className={NAME}>{info.user}</strong> tem acesso ao
                Docker do servidor (por exemplo, pelo grupo docker). Se tiver, ele consegue virar root sem
                senha — confira no servidor com <code className={NAME}>id {info.user}</code>.
              </span>
            </p>
          )}
          {backgroundCommand !== null && (
            <p
              className="flex items-center gap-1.5 text-amber-200/80"
              data-testid="background-exec-indicator"
              title={backgroundCommand}
            >
              <Cog className="h-3 w-3 shrink-0 animate-spin" aria-hidden />
              <span className="shrink-0">Executando em segundo plano como root:</span>
              <code className="truncate font-mono text-amber-100/90">{backgroundCommand}</code>
            </p>
          )}
        </div>
        {/* Sessão root: abre um shell do usuário detectado DENTRO dela,
            digitando o comando pelo mesmo caminho do input (a sessão segue
            root por baixo). Nos modos em que o terminal já é do usuário, some. */}
        {canOpenUserShell && (
          <button
            type="button"
            onClick={openUserShell}
            title={`Abre um shell de ${userShellName} dentro desta sessão (o prompt vira ${userShellName}@…). A sessão continua sendo root por baixo — a varredura e as fases NÃO passam a rodar como ${userShellName}. Digite exit no terminal para voltar ao root.`}
            className="shrink-0 rounded border border-emerald-400/30 bg-emerald-400/10 px-2 py-0.5 text-[10px] font-medium text-emerald-100/80 transition-colors hover:bg-emerald-400/20"
          >
            {`Abrir como ${userShellName}`}
          </button>
        )}
      </div>

      {dockerAccess === "sim" && info && (
        <div
          role="alert"
          data-testid="terminal-docker-group-warning"
          className="flex items-start gap-2 border-t-2 border-red-500/70 bg-red-600/20 px-4 py-2.5 text-xs leading-relaxed text-red-100"
        >
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-300" aria-hidden />
          <div className="flex flex-col gap-1">
            <p className="font-semibold text-red-200">
              Atenção: o usuário <span className="font-mono">{info.user}</span> tem acesso ao Docker do
              servidor
            </p>
            <p>
              O usuário <strong className="font-mono">{info.user}</strong> está no grupo docker (ou tem outro
              acesso ao Docker do servidor), o que permite obter acesso de root à VPS sem senha. A proteção
              do {info.elevation === "senha" ? "modo senha" : "modo segundo plano"} não vale enquanto isso
              continuar: uma aba esquecida aberta com este terminal ainda dá root.
            </p>
            <p>
              Para corrigir, rode no servidor{" "}
              <code className="rounded bg-black/50 px-1 font-mono text-emerald-300">
                sudo gpasswd -d {info.user} docker
              </code>{" "}
              e depois encerre a sessão: digite <code className="font-mono">exit</code> neste terminal e
              saia de todas as sessões SSH de {info.user} — a mudança só vale para sessões abertas depois
              dela.
            </p>
          </div>
        </div>
      )}

      {status === "busy" && (
        <p className="border-t border-amber-500/30 bg-amber-500/10 px-4 py-2 text-[11px] leading-relaxed text-amber-200">
          ⚠️ <strong>Terminal em uso em outra aba/janela.</strong> Feche a outra aba e recarregue
          esta página para retomar o controle. A sessão no servidor NÃO foi interrompida.
        </p>
      )}

      {/* Orientação fixa — visível mesmo recolhido */}
      <p className="border-t border-white/5 px-4 py-2 text-[11px] leading-relaxed text-emerald-100/60">
        🖥️ Terminal ao vivo do servidor — ativo e funcional. Você pode expandir para acompanhar.{" "}
        <strong className="text-emerald-100/80">Recomendação: apenas observe; aja SOMENTE quando for
        solicitado.</strong>{" "}
        Interferir por conta própria pode interromper ou quebrar o processo.
      </p>

      {sudoAlert && (
        <SudoPasswordAlert
          alert={sudoAlert}
          fallbackUser={info && info.elevation !== "root" && info.elevation !== "root-legado" ? info.user : null}
          configuredUser={info?.configuredUser ?? null}
          onDismiss={() => setSudoAlert(null)}
        />
      )}

      <div
        ref={containerRef}
        data-testid="terminal-container"
        className="w-full overflow-hidden px-1 pb-1"
        style={{ height: open ? PANEL_HEIGHT_PX : 0, display: open ? "block" : "none" }}
      />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Textos do cabeçalho e do alerta de senha
// ---------------------------------------------------------------------------

/** Link para a Auditoria (a página exige a conta de administrador). */
function AuditLink() {
  return (
    <a href="/audit" className="underline decoration-dotted underline-offset-2 hover:text-emerald-100/80">
      Auditoria
    </a>
  );
}

const NAME = "font-mono text-emerald-100/70";

function SessionNote({
  info,
  unavailable,
  sshUser,
}: {
  info: TerminalInfoResponse | null;
  unavailable: boolean;
  sshUser: string | null;
}) {
  if (!info) {
    return unavailable ? (
      <span>
        Não foi possível confirmar com qual usuário esta sessão abre (o painel não respondeu). O
        prompt do terminal mostra o usuário real.
      </span>
    ) : (
      <span>Verificando com qual usuário esta sessão abre…</span>
    );
  }

  // Na sessão root, o operador que criou um usuário na instalação precisa ler
  // que ele não foi ignorado — dizer isso no abstrato não bastava.
  const sshUserLine = sshUser ? (
    <>
      {" "}O usuário <strong className={NAME}>{sshUser}</strong> <strong>não foi ignorado</strong> — ele
      continua sendo o do seu acesso por SSH.
    </>
  ) : null;

  switch (info.elevation) {
    case "senha":
      return (
        <span>
          Esta sessão abre como <strong className={NAME}>{info.user}</strong>. Quando a varredura ou uma
          fase precisa de root, o comando roda aqui mesmo com <strong>sudo</strong> e a senha de{" "}
          <strong className={NAME}>{info.user}</strong> é pedida neste terminal.
        </span>
      );
    case "segundo-plano":
      return (
        <span>
          Esta sessão abre como <strong className={NAME}>{info.user}</strong>. Os comandos que precisam
          de root (varredura e fases) rodam em segundo plano como root, fora deste shell: a saída
          deles aparece aqui só para visualização e cada comando fica registrado na <AuditLink /> (a
          página fica disponível depois de criar a conta de administrador).
        </span>
      );
    case "root":
      return (
        <span>
          Esta sessão abre como <strong className={NAME}>root</strong>, conforme escolhido na instalação.
          Tudo o que for digitado aqui roda com poder total sobre o servidor — não deixe esta aba aberta
          sem necessidade.{sshUserLine}
        </span>
      );
    case "root-legado":
      return (
        <span>
          Esta sessão abre como <strong className={NAME}>root</strong>: esta instalação não definiu um
          usuário para o terminal, então ele segue como nas versões anteriores. Tudo o que for digitado
          aqui roda com poder total sobre o servidor — não deixe esta aba aberta sem necessidade. Para
          abrir como um usuário comum, rode no servidor{" "}
          <code className={NAME}>./scripts/install.sh --reconfigure-terminal</code>.{sshUserLine}
        </span>
      );
    case "container-dev":
      return (
        <span>
          Ambiente de desenvolvimento: este é o terminal do container de testes descartável, não o de
          uma VPS real. Usuário e modo de root da instalação não se aplicam aqui.
        </span>
      );
  }
}

function SudoPasswordAlert({
  alert,
  fallbackUser,
  configuredUser,
  onDismiss,
}: {
  alert: SudoAlert;
  /** Usuário da sessão (modos não-root), quando o pedido não trouxe o nome. */
  fallbackUser: string | null;
  /** Usuário escolhido na instalação — último recurso para o comando do túnel. */
  configuredUser?: string | null;
  onDismiss: () => void;
}) {
  const user = alert.user ?? fallbackUser;
  const userLabel = user ? (
    <strong className="font-mono text-amber-100">{user}</strong>
  ) : (
    <strong>do terminal</strong>
  );
  // Calculado a cada render: é o endereço com que ESTA página foi aberta.
  const loc = pageLocation();
  const insecure = isInsecureTransport(loc);
  // Usuário do comando do túnel: o do pedido, o da sessão, o da instalação —
  // e, se nada disso existir, um marcador claro de "preencha aqui".
  const tunnelUser = user ?? (configuredUser && isValidSshUsername(configuredUser) ? configuredUser : "usuario");
  const tunnelCmd = sshTunnelCommand(loc, tunnelUser);
  const tunnelUrl = localhostUrl(loc);

  return (
    <div
      role="alert"
      data-testid="sudo-password-alert"
      className="border-y-2 border-amber-500/70 bg-amber-500/15 px-4 py-3 text-xs leading-relaxed text-amber-50"
    >
      {alert.kind === "prompt" ? (
        <div className="mx-auto flex max-w-2xl flex-col gap-2">
          <p className="flex items-center gap-2 text-sm font-semibold text-amber-200">
            <KeyRound className="h-4 w-4 shrink-0" aria-hidden /> O sudo está pedindo a senha
          </p>
          {alert.retry && (
            <p className="rounded bg-red-500/20 px-2 py-1 font-semibold text-red-200">
              ❌ Senha incorreta, tente de novo.
            </p>
          )}
          <p className="text-[13px]">
            Digite a senha do usuário {userLabel} no terminal abaixo e pressione <strong>Enter</strong>.
            Os caracteres não aparecem enquanto você digita — isso é normal.
          </p>
          <p className="text-amber-100/80">
            A senha vai do seu navegador, passa pelo painel e chega ao terminal da sua VPS. O painel não
            grava, não registra e não envia essa senha para nenhum outro lugar. O código é aberto e pode
            ser conferido.
          </p>
          {insecure && (
            <div
              data-testid="sudo-insecure-transport"
              className="flex flex-col gap-2 rounded border border-amber-400/50 bg-amber-950/30 px-2.5 py-2 text-amber-50/90"
            >
              <p className="flex items-start gap-2">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" aria-hidden />
                <span>
                  Esta página foi aberta por http e fora do túnel SSH, então o que você digita aqui —
                  inclusive a senha — trafega sem criptografia até a sua VPS.
                </span>
              </p>
              <p>
                Dá para resolver em um minuto. No <strong>seu computador</strong>, abra um terminal e
                rode:
              </p>
              <span className="flex items-center gap-1">
                <code
                  data-testid="sudo-tunnel-command"
                  className="flex-1 overflow-x-auto rounded bg-black/50 px-2 py-1 font-mono text-[11px] text-emerald-300"
                >
                  {tunnelCmd}
                </code>
                <CopyButton text={tunnelCmd} />
              </span>
              <p>Com o túnel aberto, volte ao painel por este endereço:</p>
              <span className="flex items-center gap-1">
                <code
                  data-testid="sudo-tunnel-url"
                  className="flex-1 overflow-x-auto rounded bg-black/50 px-2 py-1 font-mono text-[11px] text-emerald-300"
                >
                  {tunnelUrl}
                </code>
                <CopyButton text={tunnelUrl} />
              </span>
              <p className="text-amber-100/70">
                Sendo honesto: o setup token desta página já passou por esta mesma conexão quando você a
                abriu. O túnel protege daqui para a frente, não o que já trafegou.
              </p>
              <p className="text-amber-100/70">
                Prefere seguir agora? Pode digitar — nada aqui está bloqueado. O risco é alguém com
                acesso à rede entre você e a VPS; numa rede doméstica ou num servidor de teste
                descartável, essa é uma decisão razoável sua.
              </p>
            </div>
          )}
        </div>
      ) : (
        <div className="mx-auto flex max-w-2xl flex-col gap-2">
          <p className="flex items-center gap-2 text-sm font-semibold text-amber-200">
            <ShieldAlert className="h-4 w-4 shrink-0" aria-hidden />
            {alert.outcome === "exhausted" && "O sudo desistiu após 3 tentativas"}
            {alert.outcome === "not-permitted" && "Sem permissão de sudo"}
            {alert.outcome === "timeout" && "Tempo esgotado aguardando a senha"}
          </p>
          {alert.outcome === "exhausted" && (
            <p>
              A senha foi recusada 3 vezes e o sudo desistiu. Nada foi executado como root. Para
              continuar, execute de novo a varredura ou a fase e digite a senha correta quando ela for
              pedida.
            </p>
          )}
          {alert.outcome === "not-permitted" && (
            <p>
              O usuário {userLabel} não tem permissão de sudo neste servidor, então nada foi executado
              como root. Para corrigir, entre no servidor como root e rode{" "}
              <code className="rounded bg-black/50 px-1 font-mono text-emerald-300">
                usermod -aG sudo {user ?? "<usuário>"}
              </code>
              . Depois reconecte com uma sessão nova (digite <code className="font-mono">exit</code> neste
              terminal e recarregue a página) — a permissão só vale para sessões abertas depois da
              mudança — e execute de novo.
            </p>
          )}
          {alert.outcome === "timeout" && (
            <p>
              Tempo esgotado aguardando a senha: o painel cancelou o pedido e nada foi executado como
              root. Execute de novo quando puder digitar a senha no terminal.
            </p>
          )}
          <div>
            <button
              type="button"
              onClick={onDismiss}
              className="rounded border border-amber-400/50 bg-amber-400/15 px-2 py-0.5 text-[11px] font-medium hover:bg-amber-400/25"
            >
              Entendi
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
