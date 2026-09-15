/**
 * terminal.test.ts — contrato do terminal web entre servidor e interface:
 *  - os valores de PAAS_ROOT_MODE aceitos (contrato com o instalador);
 *  - o enquadramento das mensagens de controle servidor → navegador, que
 *    precisa ser impossível de forjar a partir da saída do PTY.
 */
import { describe, expect, it } from "vitest";
import {
  TERMINAL_CONTROL_PREFIX,
  TERMINAL_ROOT_MODES,
  encodeTerminalControl,
  isTerminalRootMode,
  parseTerminalControl,
  type TerminalControlMessage,
} from "../src/index";

describe("modos de root do terminal", () => {
  it("aceita exatamente 'senha' e 'segundo-plano' (contrato com o instalador)", () => {
    expect([...TERMINAL_ROOT_MODES]).toEqual(["senha", "segundo-plano"]);
    expect(isTerminalRootMode("senha")).toBe(true);
    expect(isTerminalRootMode("segundo-plano")).toBe(true);
    for (const invalido of ["", "Senha", "segundo_plano", "root", "sudo", " senha"]) {
      expect(isTerminalRootMode(invalido)).toBe(false);
    }
  });
});

describe("mensagens de controle do terminal", () => {
  const exemplos: TerminalControlMessage[] = [
    { type: "sudo-password-requested", user: "kelvin" },
    { type: "sudo-password-requested", user: null },
    { type: "sudo-password-prompt-closed", outcome: "answered" },
    { type: "sudo-password-prompt-closed", outcome: "rejected" },
    { type: "sudo-password-prompt-closed", outcome: "exhausted" },
    { type: "sudo-password-prompt-closed", outcome: "not-permitted" },
    { type: "sudo-password-prompt-closed", outcome: "timeout" },
    { type: "sudo-password-prompt-closed", outcome: "session-ended" },
    { type: "background-exec", state: "start", command: "ufw status" },
    { type: "background-exec", state: "end", command: "ufw status", code: 0 },
    { type: "background-exec", state: "end", command: "ufw status", code: null },
  ];

  it("ida e volta preserva a mensagem", () => {
    for (const msg of exemplos) {
      const frame = encodeTerminalControl(msg);
      expect(frame.startsWith(TERMINAL_CONTROL_PREFIX)).toBe(true);
      expect(parseTerminalControl(frame)).toEqual(msg);
    }
  });

  it("o prefixo começa com NUL — byte que o servidor remove da saída do PTY", () => {
    expect(TERMINAL_CONTROL_PREFIX.charCodeAt(0)).toBe(0);
  });

  it("frame comum do terminal (inclusive JSON impresso por um programa) não é controle", () => {
    expect(parseTerminalControl('{"type":"sudo-password-requested","user":"x"}')).toBeNull();
    expect(parseTerminalControl("root@vps:~# ")).toBeNull();
    expect(parseTerminalControl("")).toBeNull();
  });

  it("frame com prefixo mas conteúdo inválido é descartado", () => {
    expect(parseTerminalControl(`${TERMINAL_CONTROL_PREFIX}não é json`)).toBeNull();
    expect(parseTerminalControl(`${TERMINAL_CONTROL_PREFIX}null`)).toBeNull();
    expect(parseTerminalControl(`${TERMINAL_CONTROL_PREFIX}[]`)).toBeNull();
    expect(parseTerminalControl(`${TERMINAL_CONTROL_PREFIX}{"type":"desconhecido"}`)).toBeNull();
    expect(parseTerminalControl(`${TERMINAL_CONTROL_PREFIX}{"sem":"type"}`)).toBeNull();
  });
});
