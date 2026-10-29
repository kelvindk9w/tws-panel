/**
 * terminal-gate.test.ts — a habilitação do terminal depois do setup: janela máxima, ociosidade
 * (só ENTRADA conta), desligar na hora, mensagens e auditoria. Relógio e timers falsos.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalGate, terminalGateEndMessage } from "../src/services/terminal-gate.js";

const MIN = 60_000;
let audits: Array<{ action: string; detail: string; actor: string }>;
let gate: TerminalGate;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-29T12:00:00Z"));
  audits = [];
  gate = new TerminalGate({
    windowMs: 30 * MIN,
    idleMs: 15 * MIN,
    audit: (action, detail, actor) => audits.push({ action, detail, actor }),
  });
});

afterEach(() => {
  gate.dispose();
  vi.useRealTimers();
});

describe("TerminalGate", () => {
  it("começa desligado e habilita só a sessão que pediu", () => {
    expect(gate.isEnabled("s1")).toBe(false);
    gate.enable("s1", "admin");
    expect(gate.isEnabled("s1")).toBe(true);
    expect(gate.isEnabled("s2")).toBe(false);
    expect(audits.map((a) => a.action)).toEqual(["terminal.enabled"]);
    expect(audits[0]!.actor).toBe("admin");
  });

  it("o estado diz quanto falta da janela e da ociosidade", () => {
    gate.enable("s1", "admin");
    vi.advanceTimersByTime(5 * MIN);
    const status = gate.status("s1");
    expect(status).toMatchObject({ enabled: true, remainingMs: 25 * MIN, idleRemainingMs: 10 * MIN, windowMs: 30 * MIN, idleMs: 15 * MIN, lastEnd: null });
    expect(Date.parse(status.expiresAt!)).toBe(Date.now() + 25 * MIN);
  });

  it("a janela acaba: desliga, avisa quem ouve e audita como expirada", () => {
    const ended: Array<[string, string]> = [];
    gate.onEnded((id, reason) => ended.push([id, reason]));
    gate.enable("s1", "admin");
    // entrada constante: a ociosidade nunca vence, a janela sim
    for (let i = 0; i < 29; i++) {
      vi.advanceTimersByTime(MIN);
      gate.touch("s1");
    }
    expect(gate.isEnabled("s1")).toBe(true);
    vi.advanceTimersByTime(MIN);
    expect(ended).toEqual([["s1", "window"]]);
    expect(gate.isEnabled("s1")).toBe(false);
    expect(gate.status("s1")).toMatchObject({ enabled: false, lastEnd: "window", remainingMs: 0 });
    expect(audits.at(-1)).toMatchObject({ action: "terminal.expired" });
    expect(audits.at(-1)!.detail).toContain("30 min");
  });

  it("15 min sem entrada desligam antes da janela; entrada adia", () => {
    const ended: string[] = [];
    gate.onEnded((_id, reason) => ended.push(reason));
    gate.enable("s1", "admin");
    vi.advanceTimersByTime(14 * MIN);
    gate.touch("s1");
    vi.advanceTimersByTime(14 * MIN);
    expect(gate.isEnabled("s1")).toBe(true);
    expect(ended).toEqual([]);
    vi.advanceTimersByTime(MIN);
    expect(ended).toEqual(["idle"]);
    expect(gate.status("s1").lastEnd).toBe("idle");
    expect(audits.at(-1)!.detail).toContain("15 min sem entrada");
  });

  it("sem timer disparado, a conferência na hora já recusa um prazo vencido", () => {
    gate.enable("s1", "admin");
    vi.setSystemTime(Date.now() + 31 * MIN); // relógio saltou sem o timer rodar
    expect(gate.isEnabled("s1")).toBe(false);
    expect(gate.status("s1").lastEnd).toBe("idle");
  });

  it("touch em sessão desligada ou vencida não habilita nada", () => {
    gate.touch("nunca");
    gate.enable("s1", "admin");
    vi.setSystemTime(Date.now() + 16 * MIN);
    gate.touch("s1");
    expect(gate.isEnabled("s1")).toBe(false);
  });

  it("desligar à mão avisa, audita e guarda o motivo; repetir não faz nada", () => {
    const ended: string[] = [];
    gate.onEnded((_id, reason) => ended.push(reason));
    gate.enable("s1", "admin");
    expect(gate.disable("s1", "manual")).toBe(true);
    expect(gate.disable("s1", "manual")).toBe(false);
    expect(ended).toEqual(["manual"]);
    expect(audits.at(-1)).toMatchObject({ action: "terminal.disabled" });
    expect(gate.status("s1").lastEnd).toBe("manual");
    gate.enable("s1", "admin");
    expect(gate.status("s1").lastEnd).toBeNull();
  });

  it("habilitar de novo renova a janela (e não deixa timer antigo desligar)", () => {
    gate.enable("s1", "admin");
    vi.advanceTimersByTime(14 * MIN);
    gate.enable("s1", "admin");
    vi.advanceTimersByTime(14 * MIN);
    expect(gate.isEnabled("s1")).toBe(true);
  });

  it("disableAll desliga todas as sessões (troca de senha, 2FA desligado)", () => {
    gate.enable("s1", "admin");
    gate.enable("s2", "admin");
    expect(gate.disableAll("credentials")).toBe(2);
    expect(gate.isEnabled("s1") || gate.isEnabled("s2")).toBe(false);
    expect(gate.disableAll("credentials")).toBe(0);
  });

  it("revogar a sessão no SessionStore desliga só essa", () => {
    let revoke: (ids: readonly string[]) => void = () => undefined;
    const off = gate.watch({ onRevoked: (listener) => ((revoke = listener), () => undefined) });
    gate.enable("s1", "admin");
    gate.enable("s2", "admin");
    revoke(["s1", "outra"]);
    expect(gate.isEnabled("s1")).toBe(false);
    expect(gate.isEnabled("s2")).toBe(true);
    expect(gate.status("s1").lastEnd).toBe("session");
    off();
  });

  it("um ouvinte com defeito não impede o desligamento nem os outros ouvintes", () => {
    const seen: string[] = [];
    gate.onEnded(() => {
      throw new Error("defeito");
    });
    const off = gate.onEnded((id) => seen.push(id));
    gate.enable("s1", "admin");
    gate.disable("s1", "manual");
    expect(seen).toEqual(["s1"]);
    off();
    gate.enable("s1", "admin");
    gate.disable("s1", "manual");
    expect(seen).toEqual(["s1"]);
  });

  it("lembra só dos últimos motivos (memória limitada)", () => {
    for (let i = 0; i < 70; i++) {
      gate.enable(`s${i}`, "admin");
      gate.disable(`s${i}`, "manual");
    }
    expect(gate.status("s0").lastEnd).toBeNull();
    expect(gate.status("s69").lastEnd).toBe("manual");
  });

  it("dispose limpa os timers sem auditar nem avisar", () => {
    const ended: string[] = [];
    gate.onEnded((id) => ended.push(id));
    gate.enable("s1", "admin");
    gate.dispose();
    vi.advanceTimersByTime(60 * MIN);
    expect(ended).toEqual([]);
    expect(audits.map((a) => a.action)).toEqual(["terminal.enabled"]);
  });

  it("sem função de auditoria nem relógio próprio, funciona com os padrões", () => {
    const plain = new TerminalGate({ windowMs: 2 * MIN, idleMs: MIN });
    plain.enable("s1", "admin");
    expect(plain.isEnabled("s1")).toBe(true);
    plain.disable("s1", "manual");
    plain.dispose();
  });

  it("as mensagens de cada motivo dizem o que aconteceu", () => {
    const opts = { windowMs: 30 * MIN, idleMs: 15 * MIN };
    expect(terminalGateEndMessage("window", opts)).toContain("30 min");
    expect(terminalGateEndMessage("idle", opts)).toContain("15 min");
    expect(terminalGateEndMessage("credentials", opts)).toContain("senha");
    expect(terminalGateEndMessage("session", opts)).toContain("sessão");
    expect(terminalGateEndMessage("manual", opts)).toContain("desligado");
  });
});
