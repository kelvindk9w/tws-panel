import { describe, expect, it } from "vitest";
import { cpuLevel, diskLevel, memoryLevel, networkLevel, projectsLevel, protectionsLevel } from "../src/services/metrics-levels.js";

describe("CPU", () => {
  it("sem nenhum dado: sem dados (nunca 'ok')", () => {
    expect(cpuLevel({ busy: null, steal: null, psi: null })).toBe("unknown");
  });
  it("steal: 5% atenção, 10% crítico, 4,9% ok", () => {
    expect(cpuLevel({ busy: 10, steal: 4.9, psi: 0 })).toBe("ok");
    expect(cpuLevel({ busy: 10, steal: 5, psi: 0 })).toBe("warning");
    expect(cpuLevel({ busy: 10, steal: 10, psi: 0 })).toBe("critical");
  });
  it("pressão: 20% atenção, 50% crítico", () => {
    expect(cpuLevel({ busy: 10, steal: 0, psi: 19.9 })).toBe("ok");
    expect(cpuLevel({ busy: 10, steal: 0, psi: 20 })).toBe("warning");
    expect(cpuLevel({ busy: 10, steal: 0, psi: 50 })).toBe("critical");
  });
  it("sem pressão, CPU a 90% ou mais é atenção; com pressão, o uso sozinho não alarma", () => {
    expect(cpuLevel({ busy: 89.9, steal: null, psi: null })).toBe("ok");
    expect(cpuLevel({ busy: 90, steal: null, psi: null })).toBe("warning");
    expect(cpuLevel({ busy: 99, steal: null, psi: 1 })).toBe("ok");
  });
  it("vale o pior dos sinais", () => {
    expect(cpuLevel({ busy: 10, steal: 5, psi: 60 })).toBe("critical");
    expect(cpuLevel({ busy: null, steal: null, psi: 0 })).toBe("ok");
  });
});

describe("memória", () => {
  it("morte por falta de memória nas últimas 24 h é crítico, com ou sem outros dados", () => {
    expect(memoryLevel({ availPct: null, psi: null, oomKills24h: 1 })).toBe("critical");
    expect(memoryLevel({ availPct: 90, psi: 0, oomKills24h: 3 })).toBe("critical");
  });
  it("sem dados nenhum: sem dados", () => {
    expect(memoryLevel({ availPct: null, psi: null, oomKills24h: 0 })).toBe("unknown");
  });
  it("disponível: abaixo de 10% atenção, abaixo de 5% crítico; 10% exatos ok", () => {
    expect(memoryLevel({ availPct: 10, psi: null, oomKills24h: 0 })).toBe("ok");
    expect(memoryLevel({ availPct: 9.9, psi: null, oomKills24h: 0 })).toBe("warning");
    expect(memoryLevel({ availPct: 4.9, psi: null, oomKills24h: 0 })).toBe("critical");
    expect(memoryLevel({ availPct: 5, psi: null, oomKills24h: 0 })).toBe("warning");
  });
  it("pressão: 10% atenção, 20% crítico; cache cheio (pouca memória livre mas muita disponível) é ok", () => {
    expect(memoryLevel({ availPct: 60, psi: 9.9, oomKills24h: 0 })).toBe("ok");
    expect(memoryLevel({ availPct: 60, psi: 10, oomKills24h: 0 })).toBe("warning");
    expect(memoryLevel({ availPct: 60, psi: 20, oomKills24h: 0 })).toBe("critical");
  });
});

describe("disco", () => {
  const base = { pct: 50, inodePct: 10, daysToFull: null };
  it("sem dados: sem dados; só inodes ou só uso já basta para avaliar", () => {
    expect(diskLevel({ pct: null, inodePct: null, daysToFull: null })).toBe("unknown");
    expect(diskLevel({ pct: null, inodePct: 95, daysToFull: null })).toBe("critical");
    expect(diskLevel({ pct: 50, inodePct: null, daysToFull: null })).toBe("ok");
  });
  it("uso: 80% atenção, 90% crítico; inodes iguais", () => {
    expect(diskLevel({ ...base, pct: 79.9 })).toBe("ok");
    expect(diskLevel({ ...base, pct: 80 })).toBe("warning");
    expect(diskLevel({ ...base, pct: 90 })).toBe("critical");
    expect(diskLevel({ ...base, inodePct: 80 })).toBe("warning");
    expect(diskLevel({ ...base, inodePct: 90 })).toBe("critical");
  });
  it("enche em menos de 30 dias atenção, em menos de 7 crítico (pelo lado rápido da faixa)", () => {
    expect(diskLevel({ ...base, daysToFull: { low: 30, high: 90 } })).toBe("ok");
    expect(diskLevel({ ...base, daysToFull: { low: 29, high: 90 } })).toBe("warning");
    expect(diskLevel({ ...base, daysToFull: { low: 7, high: 9 } })).toBe("warning");
    expect(diskLevel({ ...base, daysToFull: { low: 6, high: 9 } })).toBe("critical");
  });
});

describe("rede", () => {
  it("informativa: ok com dado, sem dados sem ele", () => {
    expect(networkLevel({ rx: 0, tx: null })).toBe("ok");
    expect(networkLevel({ rx: null, tx: 5 })).toBe("ok");
    expect(networkLevel({ rx: null, tx: null })).toBe("unknown");
  });
});

describe("projetos", () => {
  it("não medido: sem dados; sem problema: ok", () => {
    expect(projectsLevel({ measured: false, problems: [] })).toBe("unknown");
    expect(projectsLevel({ measured: true, problems: [] })).toBe("ok");
  });
  it("reiniciando, morto, em ciclo de reinício e morte por memória são críticos; não saudável e saída com erro, atenção", () => {
    for (const r of ["restarting", "dead", "restart_loop", "oom"] as const) {
      expect(projectsLevel({ measured: true, problems: [{ reasons: [r] }] })).toBe("critical");
    }
    for (const r of ["unhealthy", "exited_with_error"] as const) {
      expect(projectsLevel({ measured: true, problems: [{ reasons: [r] }] })).toBe("warning");
    }
    expect(projectsLevel({ measured: true, problems: [{ reasons: ["unhealthy"] }, { reasons: ["oom", "unhealthy"] }] })).toBe("critical");
  });
});

describe("proteções", () => {
  it("sem nenhuma informação: sem dados", () => {
    expect(protectionsLevel({ certificates: null, backups: null })).toBe("unknown");
  });
  it("certificado com problema ou backup que falhou: crítico", () => {
    expect(protectionsLevel({ certificates: { total: 3, problems: 1 }, backups: { destinationConnected: true, lastFailure: false } })).toBe("critical");
    expect(protectionsLevel({ certificates: { total: 3, problems: 0 }, backups: { destinationConnected: true, lastFailure: true } })).toBe("critical");
    expect(protectionsLevel({ certificates: null, backups: { destinationConnected: true, lastFailure: true } })).toBe("critical");
  });
  it("backup só na VPS é atenção; tudo certo é ok; só um dos lados também avalia", () => {
    expect(protectionsLevel({ certificates: { total: 3, problems: 0 }, backups: { destinationConnected: false, lastFailure: false } })).toBe("warning");
    expect(protectionsLevel({ certificates: { total: 3, problems: 0 }, backups: { destinationConnected: true, lastFailure: false } })).toBe("ok");
    expect(protectionsLevel({ certificates: { total: 0, problems: 0 }, backups: null })).toBe("ok");
    expect(protectionsLevel({ certificates: null, backups: { destinationConnected: true, lastFailure: false } })).toBe("ok");
  });
});
