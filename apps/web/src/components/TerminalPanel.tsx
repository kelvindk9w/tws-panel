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
import { getSetupToken } from "@/lib/api";
import { ChevronDown, ChevronUp, Info, Lock, TerminalSquare } from "lucide-react";

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
}

export function TerminalPanel({ enabled }: TerminalPanelProps) {
  // Começa RECOLHIDO por padrão (o usuário expande se quiser acompanhar).
  const [open, setOpen] = useState(() => sessionStorage.getItem(STORAGE_KEY) === "1");
  const [attention, setAttention] = useState(false);
  const [status, setStatus] = useState<WsStatus>("connecting");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptsRef = useRef(0);

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

    const sendInput = (data: string) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(data);
    };
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
        if (typeof ev.data === "string") term.write(ev.data);
        else if (ev.data instanceof Blob) void ev.data.arrayBuffer().then((b) => term.write(new Uint8Array(b)));
      };
      ws.onclose = (ev: CloseEvent) => {
        if (disposed) return;
        wsRef.current = null;
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

      {/* Por que a sessão é root — evita que o operador estranhe o "root@" no
          prompt achando que o usuário não-root criado na instalação foi ignorado. */}
      <p className="flex items-start gap-1.5 border-t border-white/5 px-4 py-1.5 text-[10px] leading-relaxed text-emerald-100/45">
        <Info className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
        <span>
          Esta sessão aparece como root porque é isso que o hardening do servidor exige. O usuário
          não-root que você criou na instalação continua sendo o do seu acesso por SSH.
        </span>
      </p>

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

      <div
        ref={containerRef}
        data-testid="terminal-container"
        className="w-full overflow-hidden px-1 pb-1"
        style={{ height: open ? PANEL_HEIGHT_PX : 0, display: open ? "block" : "none" }}
      />
    </section>
  );
}
