/**
 * TerminalPanel — terminal web embutido (visão dupla do wizard).
 *
 * Fixo no rodapé de TODOS os 4 passos do wizard: em cima a UI formatada
 * (cards/fases), embaixo o terminal real ao vivo do servidor (xterm.js +
 * WebSocket + PTY no alvo). Leigos acompanham o formatado; técnicos veem os
 * comandos rodando de verdade — e quando algo pede senha/confirmação, a
 * resposta é digitada DIRETO aqui (o input segue pelo PTY; o painel nunca
 * lê/armazena o que é digitado).
 *
 * - altura colapsável/expansível, estado persistido em sessionStorage;
 * - alerta pulsante (evento "paas:terminal-attention") quando uma fase
 *   precisa de ação no terminal — o painel se expande sozinho;
 * - reconexão automática com backoff; resize do PTY sincronizado.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { getSetupToken } from "@/lib/api";
import { ChevronDown, ChevronUp, TerminalSquare } from "lucide-react";

/** Evento disparado pela UI (ex.: fase aguardando confirmação) para acender
 * o alerta pulsante do terminal ("olhe o terminal"). */
export const TERMINAL_ATTENTION_EVENT = "paas:terminal-attention";

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

type WsStatus = "connecting" | "online" | "offline";

function terminalWsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  const token = getSetupToken();
  const query = token ? `?token=${encodeURIComponent(token)}` : "";
  return `${proto}://${window.location.host}/api/terminal/ws${query}`;
}

export function TerminalPanel() {
  const [open, setOpen] = useState(() => sessionStorage.getItem(STORAGE_KEY) !== "0");
  const [attention, setAttention] = useState(false);
  const [status, setStatus] = useState<WsStatus>("connecting");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptsRef = useRef(0);

  // -------------------------------------------------------------- WS + xterm
  useEffect(() => {
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
      ws.onclose = () => {
        if (disposed) return;
        setStatus("offline");
        wsRef.current = null;
        const delay = Math.min(1_000 * 2 ** attemptsRef.current, 15_000);
        attemptsRef.current += 1;
        reconnectRef.current = setTimeout(connect, delay);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ------------------------------------------------------ resize sincronizado
  useEffect(() => {
    if (!open) return;
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
  }, [open]);

  // ------------------------------------------------- alerta "olhe o terminal"
  useEffect(() => {
    const onAttention = () => {
      setAttention(true);
      setOpen(true);
    };
    window.addEventListener(TERMINAL_ATTENTION_EVENT, onAttention);
    return () => window.removeEventListener(TERMINAL_ATTENTION_EVENT, onAttention);
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

  const statusLabel =
    status === "online" ? "conectado" : status === "connecting" ? "conectando…" : "reconectando…";
  const statusColor =
    status === "online" ? "bg-emerald-400" : status === "connecting" ? "bg-amber-400" : "bg-red-400";

  return (
    <section
      aria-label="Terminal do servidor"
      className="sticky bottom-0 z-40 border-t border-border bg-[#0b0f0d] shadow-[0_-8px_30px_rgba(0,0,0,0.45)]"
    >
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className={`flex w-full items-center gap-2 px-4 py-2 text-left text-xs font-medium text-emerald-100/90 hover:bg-white/5 ${
          attention ? "animate-pulse bg-amber-500/20 text-amber-300" : ""
        }`}
      >
        <TerminalSquare className="h-4 w-4" />
        <span>Terminal do servidor — ao vivo</span>
        <span className="flex items-center gap-1.5 text-[10px] font-normal text-muted-foreground">
          <span className={`inline-block h-1.5 w-1.5 rounded-full ${statusColor}`} />
          {statusLabel}
        </span>
        {attention && (
          <span className="rounded bg-amber-500 px-1.5 py-0.5 text-[10px] font-bold text-black">
            ⚠️ AÇÃO NECESSÁRIA — OLHE O TERMINAL
          </span>
        )}
        <span className="ml-auto text-muted-foreground">
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
        </span>
      </button>
      <div
        ref={containerRef}
        data-testid="terminal-container"
        className="w-full overflow-hidden px-1 pb-1"
        style={{ height: open ? PANEL_HEIGHT_PX : 0, display: open ? "block" : "none" }}
      />
    </section>
  );
}
