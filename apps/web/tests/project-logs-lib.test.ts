/**
 * project-logs-lib.test.ts — funções puras da aba Logs: filtro de texto local,
 * texto para copiar, "perto do fim" da rolagem, hora curta e "projeto parado".
 */
import { describe, expect, it } from "vitest";
import type { ProjectLogLine, ProjectLogService } from "@paas/core";
import { filterLogLines, isNearBottom, isProjectStopped, linesToText, logTimeLabel } from "@/lib/project-logs";

const line = (over: Partial<ProjectLogLine> = {}): ProjectLogLine => ({
  time: "2026-10-24T11:00:00.123Z",
  service: "api",
  container: "paas-x-api-1",
  stream: "stdout",
  text: "servidor no ar",
  ...over,
});

const svc = (state: string): ProjectLogService => ({
  service: "api",
  container: "c",
  state,
  status: "",
  health: null,
  restartCount: 0,
  startedAt: null,
  finishedAt: null,
  exitCode: null,
  logsError: null,
});

describe("filterLogLines", () => {
  const lines = [line({ text: "Conexão RECUSADA" }), line({ text: "ok", service: "web" }), line({ text: "pronto" })];

  it("sem filtro (ou só espaços) devolve tudo", () => {
    expect(filterLogLines(lines, "")).toHaveLength(3);
    expect(filterLogLines(lines, "   ")).toHaveLength(3);
  });

  it("ignora maiúsculas, no texto", () => {
    expect(filterLogLines(lines, "recusada").map((l) => l.text)).toEqual(["Conexão RECUSADA"]);
  });

  it("também casa o nome do serviço", () => {
    expect(filterLogLines(lines, "web").map((l) => l.text)).toEqual(["ok"]);
  });

  it("sem resultado devolve vazio", () => {
    expect(filterLogLines(lines, "zzz")).toEqual([]);
  });
});

describe("linesToText", () => {
  it("uma linha por linha, com horário, serviço e marca de erro", () => {
    expect(linesToText([line(), line({ stream: "stderr", text: "falhou", time: null })])).toBe(
      "2026-10-24T11:00:00.123Z api servidor no ar\napi [stderr] falhou",
    );
  });

  it("vazio dá texto vazio", () => {
    expect(linesToText([])).toBe("");
  });
});

describe("isNearBottom", () => {
  const el = (scrollHeight: number, scrollTop: number, clientHeight: number) => ({ scrollHeight, scrollTop, clientHeight }) as HTMLElement;
  it("no fim ou a poucos pixels dele", () => {
    expect(isNearBottom(el(1000, 600, 400))).toBe(true);
    expect(isNearBottom(el(1000, 580, 400))).toBe(true);
  });
  it("mais acima, não", () => {
    expect(isNearBottom(el(1000, 500, 400))).toBe(false);
  });
});

describe("logTimeLabel", () => {
  it("hora, minuto e segundo no fuso do navegador, 24 h", () => {
    const iso = "2026-10-24T11:05:09Z";
    const d = new Date(iso);
    const p = (n: number) => String(n).padStart(2, "0");
    expect(logTimeLabel(iso)).toBe(`${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`);
  });
  it("sem horário ou inválido, vazio", () => {
    expect(logTimeLabel(null)).toBe("");
    expect(logTimeLabel("lixo")).toBe("");
  });
});

describe("isProjectStopped", () => {
  it("sem serviços não é 'parado' (nunca subiu)", () => {
    expect(isProjectStopped([])).toBe(false);
  });
  it("todos parados, criados, mortos ou pausados = parado", () => {
    expect(isProjectStopped([svc("exited"), svc("created"), svc("dead"), svc("paused")])).toBe(true);
  });
  it("um rodando ou reiniciando = não está parado", () => {
    expect(isProjectStopped([svc("exited"), svc("running")])).toBe(false);
    expect(isProjectStopped([svc("restarting")])).toBe(false);
  });
});
