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
 *    o painel para o centro da tela e põe o cursor no CAMPO DE SENHA do alerta.
 *    O alerta fica ACIMA do terminal, dentro da janela, sem sobrepor a área de
 *    digitação. O campo existe por um defeito de campo: o pedido apareceu e
 *    nenhuma tecla chegou ao terminal (foco fora do xterm, e a senha não
 *    aparece enquanto se digita). "Enviar" manda a senha + Enter pelo MESMO
 *    caminho do teclado (sendInput → WS → PTY): nada é guardado, o campo é
 *    esvaziado no envio e continua sendo possível digitar direto no xterm.
 *    "Cancelar" pede ao servidor que encerre o sudo (TERMINAL_SUDO_CANCEL_REQUEST).
 *    O painel NÃO desiste sozinho: sem prazo configurado no servidor, o pedido
 *    fica aberto até a pessoa enviar ou cancelar. Texto de transparência
 *    obrigatório (por onde a senha passa e o que o painel não faz com ela) e
 *    o texto diz DE QUEM é a senha: a do usuário do terminal, a mesma do sudo
 *    por SSH — não a do root (o operador entendeu o contrário em campo);
 *  - o pedido é IMPOSSÍVEL DE NÃO VER (defeito real: passou despercebido duas
 *    vezes e a varredura morreu por timeout depois de 5 min de silêncio):
 *      · contagem regressiva mm:ss no alerta, com destaque vermelho pulsante
 *        nos últimos 30s. O prazo vem do servidor em DURAÇÃO (remainingMs) e
 *        vira um instante do relógio DESTE navegador — relógio dessincronizado
 *        entre navegador e VPS não atrapalha. Quem reconecta no meio recebe o
 *        que FALTA (replay em routes/terminal.ts), então a contagem não
 *        recomeça do zero;
 *      · faixa FIXA no topo da PÁGINA (role=alert) enquanto o pedido está
 *        aberto: visível com a página rolada em qualquer ponto e com a janela
 *        do terminal recolhida; clicar nela expande, rola até o terminal e
 *        devolve o foco ao xterm. Não é modal — não cobre onde se digita;
 *      · título da aba prefixado com "⚠ senha necessária — " enquanto o pedido
 *        está aberto (o único sinal visível com a aba em segundo plano),
 *        restaurado ao fechar o pedido e ao desmontar o painel;
 *      · ao esgotar o prazo (com folga: quem manda no relógio é o servidor), o
 *        alerta explica que nada rodou como root e aponta a ação de repetir;
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
 *    answered/session-ended fecham; exhausted/not-permitted/timeout/cancelled
 *    trocam o pedido por uma explicação acionável até o operador dispensar;
 *  - modo segundo-plano: indicador discreto do comando root em execução
 *    (background-exec start/end); a saída espelhada chega como frame comum;
 *  - ao cair o WebSocket, o alerta de senha FICA (a pessoa pode estar
 *    digitando), diz que a conexão caiu e trava o envio; ao reconectar o
 *    servidor diz o estado — pedido aberto (requested) ou nenhum (idle). O
 *    indicador de segundo plano é limpo (poderia afirmar algo que já terminou);
 *  - com a conexão caída, o que se digita no xterm NÃO é enviado — e isso é
 *    dito (aviso visível e uma linha no terminal), em vez de sumir calado;
 *  - ao (re)conectar a tela é limpa ANTES do histórico que o servidor reenvia:
 *    sem isso o histórico era escrito por cima do que já estava na tela
 *    (linhas duplicadas e cortadas, visto em campo);
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
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  TERMINAL_SUDO_CANCEL_REQUEST,
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
import { PasswordInput } from "@/components/ui/password-input";
import { ChevronDown, ChevronUp, Cog, Info, KeyRound, Lock, ShieldAlert, TerminalSquare } from "lucide-react";
import { Trans, t as translate, useI18n, type Key } from "@/i18n";

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

type WsStatus = "connecting" | "online" | "offline" | "busy" | "ended";

/** Códigos de close definidos pelo servidor (apps/server/src/routes/terminal.ts). */
const WS_CLOSE_REPLACED = 4000; // o MESMO clientId reanexou por outra conexão
const WS_CLOSE_BUSY = 4009; // sessão tem dono (outro clientId): NÃO reconectar
const WS_CLOSE_SESSION_ENDED = 4401; // a sessão de login acabou (saída, troca de senha, vencimento): NÃO reconectar

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
  /**
   * Como o WebSocket se autentica: "setup-token" (assistente de instalação,
   * padrão) ou "session" (depois do setup: o token já não vale e o cookie da
   * sessão de login vai sozinho no handshake). Sem o modo "session", a tela de
   * hardening fora do assistente ficava sem terminal — e, no modo senha, o
   * pedido de senha do sudo era invisível.
   */
  authMode?: "setup-token" | "session";
}

/** Desfechos do prompt do sudo que exigem explicação (não fecham sozinhos). */
type SudoFailureOutcome = Extract<SudoPromptOutcome, "exhausted" | "not-permitted" | "timeout" | "cancelled">;

type SudoAlert =
  /**
   * O sudo está pedindo a senha agora. `retry`: a anterior foi recusada.
   *
   * `expiresAt` é um instante do RELÓGIO DESTE NAVEGADOR: o servidor manda
   * quanto FALTA (duração) e aqui soma-se ao Date.now() local. Nenhum instante
   * do servidor é comparado com o do navegador, então um relógio adiantado ou
   * atrasado na VPS (ou aqui) não altera a contagem em nada — só a latência da
   * mensagem, que é de milissegundos. null = pedido sem relógio (um `sudo` que
   * o próprio operador digitou): mostra o alerta, sem contagem.
   */
  | {
      kind: "prompt";
      user: string | null;
      retry: boolean;
      seq: number;
      expiresAt: number | null;
      totalMs: number | null;
      /** A senha foi enviada pelo campo e o sudo ainda não respondeu. */
      sent: boolean;
    }
  /** O sudo desistiu / não pode / o painel cansou de esperar. */
  | { kind: "failed"; user: string | null; outcome: SudoFailureOutcome };

/**
 * Folga entre a contagem chegar a zero AQUI e o alerta virar "tempo esgotado".
 * Quem decide o fim é o servidor (é lá que o relógio da senha corre e o Ctrl-C
 * é enviado); a folga evita anunciar a falha um instante ANTES de o servidor
 * ainda aceitar a senha. Se a mensagem do servidor chegar antes, ela vence.
 */
const SUDO_EXPIRY_GRACE_MS = 2_000;

/** Rótulo de cada estado da conexão (a chave é resolvida na renderização). */
const STATUS_LABEL: Record<WsStatus, Key> = {
  online: "terminal.status.online",
  connecting: "terminal.status.connecting",
  busy: "terminal.status.busy",
  ended: "terminal.status.ended",
  offline: "terminal.status.reconnecting",
};

export function TerminalPanel({
  enabled,
  sshUser,
  info,
  infoUnavailable,
  authMode = "setup-token",
}: TerminalPanelProps) {
  const { t } = useI18n();
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
  const passwordInputRef = useRef<HTMLInputElement>(null);
  /** Já avisamos, nesta queda, que o que se digita não está sendo enviado. */
  const droppedNoticeRef = useRef(false);
  const [inputDropped, setInputDropped] = useState(false);

  /**
   * ÚNICO caminho de input do painel: o que o operador digita no xterm e o
   * comando do botão "abrir como <usuário>" saem exatamente por aqui — bytes
   * crus no MESMO WebSocket. Nada é logado, auditado ou inspecionado (regra de
   * ouro do relay puro; ver apps/server/src/services/terminal-service.ts).
   */
  const sendInput = useCallback((data: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(data);
      return;
    }
    // Conexão caída: o que foi digitado NÃO chega à VPS. Dizer isso (uma vez
    // por queda), em vez de descartar calado — foi assim que uma senha se
    // perdeu em campo sem ninguém perceber.
    if (!droppedNoticeRef.current) {
      droppedNoticeRef.current = true;
      termRef.current?.write(`\r\n\x1b[31m${translate("terminal.droppedLine")}\x1b[0m\r\n`);
      setInputDropped(true);
    }
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
          // duração → instante LOCAL (ver o comentário do tipo SudoAlert)
          expiresAt: typeof msg.remainingMs === "number" ? Date.now() + msg.remainingMs : null,
          totalMs: typeof msg.timeoutMs === "number" ? msg.timeoutMs : null,
          sent: false,
        }));
        setAttention(true);
        setOpen(true);
        return;
      case "sudo-password-prompt-closed":
        setSudoAlert((prev) => {
          const user = prev?.user ?? null;
          switch (msg.outcome) {
            case "rejected":
              return {
                kind: "prompt",
                user,
                retry: true,
                seq: prev?.kind === "prompt" ? prev.seq : 0,
                // o pedido novo (que vem logo em seguida) traz o prazo novo;
                // até lá, segue valendo o que já estava correndo
                expiresAt: prev?.kind === "prompt" ? prev.expiresAt : null,
                totalMs: prev?.kind === "prompt" ? prev.totalMs : null,
                sent: false,
              };
            case "answered":
            case "session-ended":
              return null;
            default:
              return { kind: "failed", user, outcome: msg.outcome };
          }
        });
        return;
      case "sudo-password-idle":
        // Nenhum pedido aberto no servidor (enviado a quem reconecta): um
        // alerta de pedido que ficou da conexão anterior já não vale.
        setSudoAlert((prev) => (prev?.kind === "prompt" ? null : prev));
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
      // Assistente: NUNCA conectar sem token (o servidor recusaria, 401).
      // Depois do setup ("session"): o cookie de sessão autentica o handshake.
      if (authMode === "setup-token" && !getSetupToken()) return;
      setStatus("connecting");
      const ws = new WebSocket(terminalWsUrl());
      wsRef.current = ws;
      ws.onopen = () => {
        attemptsRef.current = 0;
        // O servidor reenvia o histórico inteiro a cada conexão: limpar ANTES,
        // senão ele é escrito por cima do que já está na tela (duplicado).
        term.reset();
        droppedNoticeRef.current = false;
        setInputDropped(false);
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
        // O alerta de senha FICA (a pessoa pode estar digitando): ele mostra
        // que a conexão caiu e trava o envio; ao reconectar, o servidor diz se
        // o pedido ainda vale (requested) ou não (idle). Já o indicador de
        // segundo plano antigo afirmaria algo que talvez já tenha terminado.
        setBackgroundCommand(null);
        if (ev.code === WS_CLOSE_BUSY || ev.code === WS_CLOSE_REPLACED) {
          // Sessão em uso por OUTRA aba/janela (ou esta aba reanexou por outra
          // conexão): NÃO reconectar — reconectar aqui é o que gerava o
          // ping-pong infinito derrubando a sessão do dono.
          // Esta aba não volta a conectar: um pedido de senha nela não tem
          // como ser respondido daqui — quem responde é a aba dona.
          setSudoAlert((prev) => (prev?.kind === "prompt" ? null : prev));
          setStatus("busy");
          return;
        }
        if (ev.code === WS_CLOSE_SESSION_ENDED) {
          // A sessão de login acabou: reconectar só receberia 401. Quem
          // continua é quem entrar de novo (o PTY segue vivo no servidor).
          setSudoAlert((prev) => (prev?.kind === "prompt" ? null : prev));
          setStatus("ended");
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
  }, [enabled, authMode]);

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
  // O cursor vai para o CAMPO de senha do alerta (não para o xterm): o foco
  // no xterm dependia de a pessoa não clicar em mais nada — e em campo
  // nenhuma tecla chegou ao terminal.
  const promptSeq = sudoAlert?.kind === "prompt" ? sudoAlert.seq : null;
  useEffect(() => {
    if (promptSeq === null || !open) return;
    sectionRef.current?.scrollIntoView?.({ block: "center", behavior: "smooth" });
    passwordInputRef.current?.focus();
  }, [promptSeq, open]);

  /** Leva a pessoa ao alerta (clique no aviso fixo do topo da página). */
  const goToTerminal = useCallback(() => {
    setOpen(true);
    sessionStorage.setItem(STORAGE_KEY, "1");
    sectionRef.current?.scrollIntoView?.({ block: "center", behavior: "smooth" });
    if (passwordInputRef.current) passwordInputRef.current.focus();
    else termRef.current?.focus();
  }, []);

  /**
   * "Enviar senha": a senha + Enter saem pelo MESMO caminho do teclado do
   * xterm (sendInput → WS → PTY). Nada é guardado: o campo é esvaziado por
   * quem chama. Sem conexão, não envia (o botão já fica travado).
   */
  const submitPassword = useCallback(
    (password: string): boolean => {
      if (password.length === 0 || wsRef.current?.readyState !== WebSocket.OPEN) return false;
      sendInput(`${password}\r`);
      setAttention(false);
      setSudoAlert((prev) => (prev?.kind === "prompt" ? { ...prev, sent: true, retry: false } : prev));
      return true;
    },
    [sendInput],
  );

  /** "Cancelar": o servidor encerra o sudo e registra o desfecho "cancelled". */
  const cancelPassword = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(TERMINAL_SUDO_CANCEL_REQUEST);
  }, []);

  // ------------------------------------------- pedido de senha: fim do prazo
  // Quem manda no relógio é o SERVIDOR (é lá que o Ctrl-C sai); esta contagem
  // local existe para o operador não ficar diante de um alerta que pede uma
  // senha que já não vale — por exemplo se a mensagem do servidor se perder.
  const promptExpiresAt = sudoAlert?.kind === "prompt" ? sudoAlert.expiresAt : null;
  useEffect(() => {
    if (promptExpiresAt === null) return;
    const delay = Math.max(0, promptExpiresAt + SUDO_EXPIRY_GRACE_MS - Date.now());
    const timer = setTimeout(() => {
      setSudoAlert((prev) =>
        prev?.kind === "prompt" ? { kind: "failed", user: prev.user, outcome: "timeout" } : prev,
      );
    }, delay);
    return () => clearTimeout(timer);
  }, [promptExpiresAt]);

  // ----------------------------------------- aba em segundo plano: o título
  // O pedido pode chegar com a aba fora da tela; o título é o único sinal que
  // aparece na barra de abas. Restaurado ao fechar o pedido e ao desmontar.
  const promptOpen = sudoAlert?.kind === "prompt";
  useEffect(() => {
    if (!promptOpen) return;
    const original = document.title;
    const prefix = translate("terminal.tabTitlePrefix");
    // já prefixado (pedido repetido antes de restaurar): não empilha prefixo
    if (!original.startsWith(prefix)) document.title = `${prefix}${original}`;
    return () => {
      document.title = original;
    };
  }, [promptOpen]);

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
        aria-label={t("terminal.aria")}
        data-testid="terminal-locked"
        className="overflow-hidden rounded-xl border border-dashed border-border bg-muted/20"
      >
        <div className="flex items-center gap-3 px-4 py-3 text-xs text-muted-foreground">
          <Lock className="h-4 w-4 shrink-0" />
          <p>
            <Trans k="terminal.locked" components={{ b: <strong /> }} />
          </p>
        </div>
      </section>
    );
  }

  const statusLabel = t(STATUS_LABEL[status]);
  const statusColor =
    status === "online"
      ? "bg-emerald-400"
      : status === "connecting"
        ? "bg-amber-400"
        : "bg-red-400";

  return (
    <section
      ref={sectionRef}
      aria-label={t("terminal.aria")}
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
        <span>{t("terminal.titlebar")}</span>
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
            {t("terminal.attention")}
          </span>
        )}
        <span className="ml-auto flex items-center gap-1 text-muted-foreground">
          <span className="text-[10px]">{open ? t("terminal.collapse") : t("terminal.expand")}</span>
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
                <Trans k="terminal.monitoringNote" components={{ audit: (c) => <AuditLink>{c}</AuditLink> }} />
              </span>
            </p>
          )}
          {dockerAccess === "nao-verificado" && info && (
            <p className="flex items-start gap-1.5" data-testid="terminal-docker-unverified">
              <Info className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
              <span>
                <Trans
                  k="terminal.dockerUnverified"
                  params={{ user: info.user }}
                  components={{ name: <strong className={NAME} />, code: <code className={NAME} /> }}
                />
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
              <span className="shrink-0">{t("terminal.backgroundRunning")}</span>
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
            title={t("terminal.openAs.title", { user: userShellName })}
            className="shrink-0 rounded border border-emerald-400/30 bg-emerald-400/10 px-2 py-0.5 text-[10px] font-medium text-emerald-100/80 transition-colors hover:bg-emerald-400/20"
          >
            {t("terminal.openAs.label", { user: userShellName })}
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
              <Trans
                k="terminal.dockerWarning.title"
                params={{ user: info.user }}
                components={{ mono: <span className="font-mono" /> }}
              />
            </p>
            <p>
              <Trans
                k="terminal.dockerWarning.body"
                params={{
                  user: info.user,
                  mode: info.elevation === "senha" ? t("terminal.dockerWarning.modePassword") : t("terminal.dockerWarning.modeBackground"),
                }}
                components={{ mono: <strong className="font-mono" /> }}
              />
            </p>
            <p>
              <Trans
                k="terminal.dockerWarning.fix"
                params={{ user: info.user, command: `sudo gpasswd -d ${info.user} docker` }}
                components={{
                  cmd: <code className="rounded bg-black/50 px-1 font-mono text-emerald-300" />,
                  code: <code className="font-mono" />,
                }}
              />
            </p>
          </div>
        </div>
      )}

      {inputDropped && (
        <p
          role="alert"
          data-testid="terminal-input-dropped"
          className="border-t border-red-500/40 bg-red-600/15 px-4 py-2 text-[11px] leading-relaxed text-red-200"
        >
          <Trans k="terminal.inputDropped" components={{ b: <strong /> }} />
        </p>
      )}

      {status === "busy" && (
        <p className="border-t border-amber-500/30 bg-amber-500/10 px-4 py-2 text-[11px] leading-relaxed text-amber-200">
          <Trans k="terminal.busy" components={{ b: <strong /> }} />
        </p>
      )}

      {status === "ended" && (
        <p className="border-t border-amber-500/30 bg-amber-500/10 px-4 py-2 text-[11px] leading-relaxed text-amber-200">
          <Trans k="terminal.ended" components={{ b: <strong /> }} />
        </p>
      )}

      {/* Orientação fixa — visível mesmo recolhido */}
      <p className="border-t border-white/5 px-4 py-2 text-[11px] leading-relaxed text-emerald-100/60">
        <Trans k="terminal.guidance" components={{ b: <strong className="text-emerald-100/80" /> }} />
      </p>

      {/* Aviso FIXO no topo da PÁGINA: a janela do terminal pode estar
          recolhida ou fora da área visível — foi exatamente o que fez o pedido
          passar despercebido duas vezes. Não é modal (não cobre o terminal nem
          rouba o foco de quem digita a senha): é uma faixa que leva até ele. */}
      {sudoAlert?.kind === "prompt" && (
        <div
          role="alert"
          data-testid="sudo-password-banner"
          className="fixed inset-x-0 top-0 z-50 border-b-2 border-amber-400 bg-amber-500 text-black shadow-[0_4px_20px_rgba(0,0,0,0.45)]"
          style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
        >
          <button
            type="button"
            data-testid="sudo-password-banner-action"
            onClick={goToTerminal}
            className="mx-auto flex w-full max-w-4xl items-center gap-2 px-4 py-2 text-left text-sm font-semibold"
          >
            <KeyRound className="h-4 w-4 shrink-0 animate-pulse" aria-hidden />
            <span className="flex-1">
              <Trans
                k="terminal.banner.waiting"
                params={{ who: sudoAlert.user ?? info?.user ?? t("terminal.sudo.fallbackName") }}
                components={{ mono: <span className="font-mono" /> }}
              />
            </span>
            {sudoAlert.expiresAt !== null && (
              <SudoCountdown expiresAt={sudoAlert.expiresAt} totalMs={sudoAlert.totalMs} variant="banner" />
            )}
            <span className="shrink-0 rounded bg-black/20 px-2 py-0.5 text-[11px] uppercase">{t("terminal.banner.go")}</span>
          </button>
        </div>
      )}

      {sudoAlert && (
        <SudoPasswordAlert
          alert={sudoAlert}
          connected={status === "online"}
          inputRef={passwordInputRef}
          onSubmitPassword={submitPassword}
          onCancel={cancelPassword}
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
function AuditLink({ children }: { children: ReactNode }) {
  return (
    <a href="/audit" className="underline decoration-dotted underline-offset-2 hover:text-emerald-100/80">
      {children}
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
  const { t } = useI18n();
  const nameTag = <strong className={NAME} />;
  const auditTag = (c: ReactNode) => <AuditLink>{c}</AuditLink>;
  if (!info) {
    return unavailable ? <span>{t("terminal.note.unavailable")}</span> : <span>{t("terminal.note.checking")}</span>;
  }

  // Na sessão root, o operador que criou um usuário na instalação precisa ler
  // que ele não foi ignorado — dizer isso no abstrato não bastava.
  const sshUserLine = sshUser ? (
    <Trans k="terminal.note.sshUser" params={{ user: sshUser }} components={{ name: nameTag, b: <strong /> }} />
  ) : null;

  switch (info.elevation) {
    case "senha":
      return (
        <span>
          <Trans k="terminal.note.password" params={{ user: info.user }} components={{ name: nameTag, b: <strong /> }} />
        </span>
      );
    case "segundo-plano":
      return (
        <span>
          <Trans k="terminal.note.background" params={{ user: info.user }} components={{ name: nameTag, audit: auditTag }} />
        </span>
      );
    case "root":
      return (
        <span>
          <Trans k="terminal.note.root" components={{ name: nameTag }} />
          {sshUserLine}
        </span>
      );
    case "root-legado":
      return (
        <span>
          <Trans k="terminal.note.rootLegacy" components={{ name: nameTag, code: <code className={NAME} /> }} />
          {sshUserLine}
        </span>
      );
    case "container-dev":
      return (
        <span>
          {t("terminal.note.containerDev")}
        </span>
      );
  }
}

/** mm:ss a partir de milissegundos (arredondando para cima: 1ms ainda é 1s). */
function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Faltando isto ou menos, o destaque muda (vermelho + pulso). */
const SUDO_URGENT_MS = 30_000;

/**
 * Contagem regressiva da espera pela senha.
 *
 * O prazo chega do servidor como DURAÇÃO e vira um instante do relógio DESTE
 * navegador (ver SudoAlert): a conta feita aqui é sempre "instante local menos
 * agora local", então relógio dessincronizado entre navegador e VPS não
 * atrapalha. Reconexão no meio da espera continua de onde estava, porque o
 * servidor reenvia o que FALTA, não o prazo inteiro.
 */
function SudoCountdown({
  expiresAt,
  totalMs,
  variant,
}: {
  expiresAt: number;
  totalMs: number | null;
  variant: "alert" | "banner";
}) {
  const [remaining, setRemaining] = useState(() => Math.max(0, expiresAt - Date.now()));
  useEffect(() => {
    setRemaining(Math.max(0, expiresAt - Date.now()));
    const id = setInterval(() => setRemaining(Math.max(0, expiresAt - Date.now())), 1_000);
    return () => clearInterval(id);
  }, [expiresAt]);

  const { t } = useI18n();
  const urgente = remaining <= SUDO_URGENT_MS;
  const label = formatRemaining(remaining);
  if (variant === "banner") {
    return (
      <span className={`shrink-0 font-mono text-sm ${urgente ? "animate-pulse font-bold" : ""}`}>{label}</span>
    );
  }
  return (
    <span
      data-testid="sudo-countdown"
      data-urgente={urgente ? "sim" : "nao"}
      aria-live="off"
      className={`inline-flex items-center gap-1.5 rounded px-2 py-0.5 font-mono text-sm font-bold ${
        urgente ? "animate-pulse bg-red-500/30 text-red-100 ring-1 ring-red-400" : "bg-amber-400/20 text-amber-100"
      }`}
    >
      ⏳ {label}
      {totalMs !== null && (
        <span className="font-sans text-[10px] font-normal opacity-70">{t("terminal.sudo.countdownOf", { total: formatRemaining(totalMs) })}</span>
      )}
    </span>
  );
}

function SudoPasswordAlert({
  alert,
  connected,
  inputRef,
  onSubmitPassword,
  onCancel,
  fallbackUser,
  configuredUser,
  onDismiss,
}: {
  alert: SudoAlert;
  /** WebSocket do terminal aberto (sem ele, a senha não tem como chegar). */
  connected: boolean;
  inputRef: RefObject<HTMLInputElement>;
  /** Envia a senha + Enter ao terminal; false = não enviou. */
  onSubmitPassword: (password: string) => boolean;
  onCancel: () => void;
  /** Usuário da sessão (modos não-root), quando o pedido não trouxe o nome. */
  fallbackUser: string | null;
  /** Usuário escolhido na instalação — último recurso para o comando do túnel. */
  configuredUser?: string | null;
  onDismiss: () => void;
}) {
  const { t } = useI18n();
  const user = alert.user ?? fallbackUser;
  // o nome do usuário (ou, sem ele, "o usuário do terminal") entra nos textos pela tag <who>
  const whoTag = user ? <strong className="font-mono text-amber-100" /> : <strong />;
  const who = user ?? t("terminal.sudo.fallbackWho");
  // Calculado a cada render: é o endereço com que ESTA página foi aberta.
  const loc = pageLocation();
  const insecure = isInsecureTransport(loc);
  // Usuário do comando do túnel: o do pedido, o da sessão, o da instalação —
  // e, se nada disso existir, um marcador claro de "preencha aqui".
  const tunnelUser = user ?? (configuredUser && isValidSshUsername(configuredUser) ? configuredUser : t("terminal.sudo.tunnelUserPlaceholder"));
  const tunnelCmd = sshTunnelCommand(loc, tunnelUser);
  const tunnelUrl = localhostUrl(loc);
  // O valor digitado vive só aqui, até o envio (então é esvaziado). Não vai a
  // storage nenhum. Sobrevive a uma queda de conexão: o alerta não é desmontado.
  const [password, setPassword] = useState("");
  const userName = user ?? t("terminal.sudo.fallbackName");
  const canSend = connected && !(alert.kind === "prompt" && alert.sent);
  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    if (!canSend) return;
    if (onSubmitPassword(password)) setPassword("");
  };

  return (
    <div
      role="alert"
      data-testid="sudo-password-alert"
      className="border-y-2 border-amber-500/70 bg-amber-500/15 px-4 py-3 text-xs leading-relaxed text-amber-50"
    >
      {alert.kind === "prompt" ? (
        <div className="mx-auto flex max-w-2xl flex-col gap-2">
          <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-amber-200">
            <KeyRound className="h-4 w-4 shrink-0" aria-hidden /> {t("terminal.sudo.title")}
            {alert.expiresAt !== null && (
              <SudoCountdown expiresAt={alert.expiresAt} totalMs={alert.totalMs} variant="alert" />
            )}
          </p>
          {alert.retry && (
            <p className="rounded bg-red-500/20 px-2 py-1 font-semibold text-red-200">
              {t("terminal.sudo.retry")}
            </p>
          )}
          <p className="text-[13px]">
            <Trans k="terminal.sudo.instructions" params={{ who }} components={{ who: whoTag, b: <strong /> }} />
          </p>
          <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
            <label htmlFor="sudo-password-input" className="sr-only">
              {t("terminal.sudo.passwordLabel", { name: userName })}
            </label>
            <PasswordInput
              id="sudo-password-input"
              ref={inputRef}
              autoComplete="off"
              spellCheck={false}
              value={password}
              onChange={(ev) => setPassword(ev.target.value)}
              placeholder={t("terminal.sudo.passwordLabel", { name: userName })}
              containerClassName="min-w-0 flex-1"
              className="h-auto rounded border-amber-400/60 bg-black/60 py-1.5 font-mono text-amber-50 placeholder:text-amber-100/40 focus-visible:ring-2 focus-visible:ring-amber-400"
            />
            <button
              type="submit"
              disabled={!canSend}
              className="rounded bg-amber-400 px-3 py-1.5 text-sm font-semibold text-black hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t("terminal.sudo.send")}
            </button>
            <button
              type="button"
              onClick={onCancel}
              disabled={!connected}
              className="rounded border border-amber-400/50 px-3 py-1.5 text-sm font-medium text-amber-100 hover:bg-amber-400/15 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t("terminal.sudo.cancel")}
            </button>
          </form>
          {!connected && (
            <p className="rounded bg-red-500/20 px-2 py-1 font-semibold text-red-200">
              {t("terminal.sudo.disconnected")}
            </p>
          )}
          {connected && alert.sent && (
            <p className="text-amber-100/90">{t("terminal.sudo.sent")}</p>
          )}
          <p className="text-amber-100/80">
            <Trans k="terminal.sudo.typeDirect" components={{ b: <strong /> }} />
          </p>
          {/* Feedback de campo: o operador entendeu que o painel pedia a senha
              de root. É a senha DELE, a mesma do sudo por SSH. */}
          <p className="text-[13px] font-medium text-amber-100">
            <Trans
              k="terminal.sudo.whose"
              params={{ who }}
              components={{ who: whoTag, code: <code className="font-mono" />, b: <strong /> }}
            />
          </p>
          {alert.expiresAt !== null ? (
            <p className="text-amber-100/80">
              {t("terminal.sudo.deadline")}
            </p>
          ) : (
            <p className="text-amber-100/80">
              {t("terminal.sudo.noDeadline")}
            </p>
          )}
          <p className="text-amber-100/80">
            {t("terminal.sudo.transparency")}
          </p>
          {insecure && (
            <div
              data-testid="sudo-insecure-transport"
              className="flex flex-col gap-2 rounded border border-amber-400/50 bg-amber-950/30 px-2.5 py-2 text-amber-50/90"
            >
              <p className="flex items-start gap-2">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" aria-hidden />
                <span>
                  {t("terminal.insecure.fact")}
                </span>
              </p>
              <p>
                <Trans k="terminal.insecure.runTunnel" components={{ b: <strong /> }} />
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
              <p>{t("terminal.insecure.openUrl")}</p>
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
                {t("terminal.insecure.honest")}
              </p>
              <p className="text-amber-100/70">
                {t("terminal.insecure.proceed")}
              </p>
            </div>
          )}
        </div>
      ) : (
        <div className="mx-auto flex max-w-2xl flex-col gap-2">
          <p className="flex items-center gap-2 text-sm font-semibold text-amber-200">
            <ShieldAlert className="h-4 w-4 shrink-0" aria-hidden />
            {alert.outcome === "exhausted" && t("terminal.failed.exhausted.title")}
            {alert.outcome === "not-permitted" && t("terminal.failed.notPermitted.title")}
            {alert.outcome === "timeout" && t("terminal.failed.timeout.title")}
            {alert.outcome === "cancelled" && t("terminal.failed.cancelled.title")}
          </p>
          {alert.outcome === "exhausted" && (
            <p>{t("terminal.failed.exhausted.body")}</p>
          )}
          {alert.outcome === "not-permitted" && (
            <p>
              <Trans
                k="terminal.failed.notPermitted.body"
                params={{ who, command: `usermod -aG sudo ${user ?? t("terminal.failed.userPlaceholder")}` }}
                components={{
                  who: whoTag,
                  cmd: <code className="rounded bg-black/50 px-1 font-mono text-emerald-300" />,
                  code: <code className="font-mono" />,
                }}
              />
            </p>
          )}
          {alert.outcome === "cancelled" && (
            <p>
              <Trans k="terminal.failed.cancelled.body" params={{ who }} components={{ who: whoTag, b: <strong /> }} />
            </p>
          )}
          {alert.outcome === "timeout" && (
            <>
              <p>
                <Trans k="terminal.failed.timeout.body1" params={{ who }} components={{ who: whoTag, b: <strong /> }} />
              </p>
              <p>
                <Trans k="terminal.failed.timeout.body2" components={{ b: <strong /> }} />
              </p>
            </>
          )}
          <div>
            <button
              type="button"
              onClick={onDismiss}
              className="rounded border border-amber-400/50 bg-amber-400/15 px-2 py-0.5 text-[11px] font-medium hover:bg-amber-400/25"
            >
              {t("terminal.failed.dismiss")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
