import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostMetricId } from "@paas/core";
import { RESTART_WINDOW_SECONDS, type ContainerStatus, type TickResult } from "../src/services/metrics-collector.js";
import { ResourceWatcher, WATCH, windowAvg } from "../src/services/metrics-watch.js";
import type { HostSampleValues } from "../src/services/metrics-compute.js";

const T0 = 1_800_000_000;

interface Rig {
  w: ResourceWatcher;
  create: ReturnType<typeof vi.fn>;
  resolve: ReturnType<typeof vi.fn>;
  logs: string[];
  recent: Array<{ t: number; v: HostSampleValues }>;
  /** Anda `minutes` minutos, com a função dando os valores do host a cada minuto, e avalia a cada volta. */
  run(minutes: number, host: (i: number) => HostSampleValues, containers?: (t: number) => ContainerStatus[]): Promise<void>;
  t: number;
  /** O Docker respondeu nas voltas seguintes? */
  dockerOk: boolean;
}

function rig(listOpen?: () => Promise<Array<{ id: string; title: string }>>): Rig {
  const logs: string[] = [];
  let n = 0;
  const create = vi.fn(async () => ({ alert: { id: `alerta-${++n}` }, created: true }));
  const resolve = vi.fn(async () => undefined);
  const r: Rig = {
    w: new ResourceWatcher({ create, resolve, log: (m) => logs.push(m), ...(listOpen ? { listOpen } : {}) }),
    create,
    resolve,
    logs,
    recent: [],
    t: T0,
    dockerOk: true,
    async run(minutes, host, containers = () => []) {
      for (let i = 0; i < minutes; i++) {
        r.t += 60;
        const v = host(i);
        r.recent.push({ t: r.t, v });
        if (r.recent.length > 120) r.recent.shift();
        const tick: TickResult = { t: r.t, host: v, containers: containers(r.t), sample: { t: r.t, h: v, c: {} }, dockerOk: r.dockerOk };
        await r.w.evaluate(tick, r.recent);
      }
    },
  };
  return r;
}

const cont = (over: Partial<ContainerStatus> = {}): ContainerStatus => ({
  id: "a".repeat(64),
  name: "paas-loja-web-1",
  slug: "loja",
  service: "web",
  managed: true,
  state: "running",
  health: null,
  restartCount: 0,
  startedAt: null,
  exitCode: 0,
  oomKilled: false,
  restartsAt: [],
  oomAt: [],
  unhealthySince: null,
  ...over,
});

describe("média de janela", () => {
  const recent = (vals: Array<number | undefined>, id: HostMetricId = "psiMem") => vals.map((v, i) => ({ t: T0 + (i + 1) * 60, v: v === undefined ? {} : { [id]: v } }));
  it("média dos últimos N minutos; precisa de 80% da janela com amostra", () => {
    const r = recent([10, 20, 30, 40, 50]);
    expect(windowAvg(r, "psiMem", T0 + 300, 5)).toBe(30);
    expect(windowAvg(r, "psiMem", T0 + 300, 3)).toBe(40);
    // 4 de 5 amostras = 80%: vale; 3 de 5 = não vale
    expect(windowAvg(recent([10, undefined, 30, 40, 50]), "psiMem", T0 + 300, 5)).toBe(32.5);
    expect(windowAvg(recent([10, undefined, undefined, 40, 50]), "psiMem", T0 + 300, 5)).toBeNull();
    expect(windowAvg([], "psiMem", T0, 5)).toBeNull();
  });
  it("só conta amostras DENTRO da janela (a de exatamente N minutos atrás fica de fora)", () => {
    const r = [{ t: T0, v: { psiMem: 100 } }, ...recent([0, 0, 0, 0, 0])];
    expect(windowAvg(r, "psiMem", T0 + 300, 5)).toBe(0);
  });
});

describe("memória (pressão)", () => {
  it("só dispara com 5 minutos sustentados; um pico curto não alerta", async () => {
    const r = rig();
    await r.run(10, (i) => ({ psiMem: i === 4 ? 90 : 1 }));
    expect(r.create).not.toHaveBeenCalled();
  });

  it("sustentado ≥ 20% dispara UM alerta crítico (sem repetir a cada volta)", async () => {
    const r = rig();
    await r.run(10, () => ({ psiMem: 30 }));
    expect(r.create).toHaveBeenCalledTimes(1);
    expect(r.create).toHaveBeenCalledWith(expect.objectContaining({ severity: "critical", source: "resources", title: "Memória da VPS apertada" }));
    expect(r.w.activeKeys()).toEqual(["host:memory"]);
  });

  it("histerese: entre 10% e 20% o alerta continua; só volta ao normal com média de 15 min abaixo de 10%", async () => {
    const r = rig();
    await r.run(10, () => ({ psiMem: 30 }));
    await r.run(20, () => ({ psiMem: 15 })); // entre os limiares: continua
    expect(r.resolve).not.toHaveBeenCalled();
    expect(r.create).toHaveBeenCalledTimes(1);
    await r.run(20, () => ({ psiMem: 2 }));
    expect(r.resolve).toHaveBeenCalledTimes(1);
    expect(r.resolve).toHaveBeenCalledWith("alerta-1");
    expect(r.w.activeKeys()).toEqual([]);
  });

  it("oscilando em torno do limite não abre e fecha sem parar", async () => {
    const r = rig();
    await r.run(120, (i) => ({ psiMem: i % 2 === 0 ? 24 : 16 })); // média 20: dispara uma vez; nunca < 10
    expect(r.create).toHaveBeenCalledTimes(1);
    expect(r.resolve).not.toHaveBeenCalled();
  });

  it("depois de resolvido, um novo episódio abre outro alerta", async () => {
    const r = rig();
    await r.run(10, () => ({ psiMem: 30 }));
    await r.run(20, () => ({ psiMem: 0 }));
    await r.run(10, () => ({ psiMem: 30 }));
    expect(r.create).toHaveBeenCalledTimes(2);
  });

  it("sem PSI no kernel usa a memória disponível: < 5% dispara, > 10% volta", async () => {
    const r = rig();
    await r.run(10, () => ({ memUsedPct: 97 }));
    expect(r.create).toHaveBeenCalledTimes(1);
    await r.run(20, () => ({ memUsedPct: 93 })); // 7% disponível: entre os limiares
    expect(r.resolve).not.toHaveBeenCalled();
    await r.run(20, () => ({ memUsedPct: 80 }));
    expect(r.resolve).toHaveBeenCalledTimes(1);
  });

  it("memória usada alta com cache (disponível boa) e PSI zerada não alerta", async () => {
    const r = rig();
    await r.run(30, () => ({ memUsedPct: 40, psiMem: 0 }));
    expect(r.create).not.toHaveBeenCalled();
  });

  it("sem dado nenhum: nada dispara, e alerta ativo não é encerrado por falta de dado", async () => {
    const r = rig();
    await r.run(10, () => ({}));
    expect(r.create).not.toHaveBeenCalled();
    await r.run(10, () => ({ psiMem: 30 }));
    expect(r.create).toHaveBeenCalledTimes(1);
    await r.run(30, () => ({}));
    expect(r.resolve).not.toHaveBeenCalled();
  });
});

describe("CPU, steal e disco lento", () => {
  it("CPU: pressão ≥ 50% por 15 min dispara (aviso), < 30% encerra; sem PSI vale o uso (≥ 95% / < 80%)", async () => {
    const r = rig();
    await r.run(11, () => ({ psiCpu: 80 })); // menos de 80% da janela de 15 min
    expect(r.create).not.toHaveBeenCalled();
    await r.run(3, () => ({ psiCpu: 80 }));
    expect(r.create).toHaveBeenCalledWith(expect.objectContaining({ severity: "warning", title: "CPU da VPS no limite" }));
    await r.run(30, () => ({ psiCpu: 40 }));
    expect(r.resolve).not.toHaveBeenCalled();
    await r.run(20, () => ({ psiCpu: 10 }));
    expect(r.resolve).toHaveBeenCalledTimes(1);

    const s = rig();
    await s.run(20, () => ({ cpuBusy: 97 }));
    expect(s.create).toHaveBeenCalledTimes(1);
    await s.run(30, () => ({ cpuBusy: 85 }));
    expect(s.resolve).not.toHaveBeenCalled();
    await s.run(20, () => ({ cpuBusy: 50 }));
    expect(s.resolve).toHaveBeenCalledTimes(1);
  });

  it("CPU sem nenhum dado: não decide", async () => {
    const r = rig();
    await r.run(30, () => ({ memTotal: 5 }));
    expect(r.create).not.toHaveBeenCalled();
  });

  it("steal: média de 30 min ≥ 10% dispara; só volta com média de 60 min < 5%", async () => {
    const r = rig();
    await r.run(23, () => ({ cpuSteal: 15 })); // menos de 80% da janela de 30 min
    expect(r.create).not.toHaveBeenCalled();
    await r.run(3, () => ({ cpuSteal: 15 }));
    expect(r.create).toHaveBeenCalledWith(expect.objectContaining({ title: "O provedor está tomando CPU da VPS" }));
    await r.run(40, () => ({ cpuSteal: 1 })); // média de 60 min ainda alta
    expect(r.resolve).not.toHaveBeenCalled();
    await r.run(40, () => ({ cpuSteal: 1 }));
    expect(r.resolve).toHaveBeenCalledTimes(1);
  });

  it("steal de 5% a 9% sustentado (ruído de nuvem) não alerta", async () => {
    const r = rig();
    await r.run(90, () => ({ cpuSteal: 7 }));
    expect(r.create).not.toHaveBeenCalled();
  });

  it("disco lento: iowait OU pressão de IO ≥ 30% por 10 min dispara; volta quando os dois < 15%", async () => {
    const r = rig();
    await r.run(10, () => ({ cpuIowait: 45, psiIo: 5 }));
    expect(r.create).toHaveBeenCalledTimes(1);
    await r.run(15, () => ({ cpuIowait: 20, psiIo: 10 }));
    expect(r.resolve).not.toHaveBeenCalled();
    await r.run(15, () => ({ cpuIowait: 5, psiIo: 10 }));
    expect(r.resolve).toHaveBeenCalledTimes(1);

    const s = rig();
    await s.run(10, () => ({ psiIo: 40 }));
    expect(s.create).toHaveBeenCalledTimes(1);
  });
});

describe("inodes", () => {
  it("≥ 90% dispara, < 85% encerra, entre os dois continua", async () => {
    const r = rig();
    await r.run(1, () => ({ inodePct: 91 }));
    expect(r.create).toHaveBeenCalledWith(expect.objectContaining({ severity: "critical" }));
    await r.run(1, () => ({ inodePct: 87 }));
    expect(r.resolve).not.toHaveBeenCalled();
    await r.run(1, () => ({ inodePct: 84 }));
    expect(r.resolve).toHaveBeenCalledTimes(1);
    await r.run(1, () => ({ inodePct: 89 }));
    expect(r.create).toHaveBeenCalledTimes(1);
  });
  it("sem dado de inodes não decide", async () => {
    const r = rig();
    await r.run(3, () => ({ cpuBusy: 1 }));
    expect(r.create).not.toHaveBeenCalled();
  });
});

describe("morte por falta de memória", () => {
  it("host: qualquer processo morto no minuto vira alerta crítico na hora; um por ocorrência", async () => {
    const r = rig();
    await r.run(3, (i) => ({ oom: i === 1 ? 2 : 0 }));
    expect(r.create).toHaveBeenCalledTimes(1);
    expect(r.create).toHaveBeenCalledWith(expect.objectContaining({ severity: "critical", title: "A VPS matou um processo por falta de memória" }));
    expect(r.w.activeKeys()).toEqual([]); // evento: não fica "ativo"
    await r.run(2, () => ({ oom: 1 }));
    expect(r.create).toHaveBeenCalledTimes(3);
  });

  it("container: alerta com o nome do serviço quando a morte acontece nesta volta", async () => {
    const r = rig();
    await r.run(2, () => ({}), (t) => [cont({ oomAt: t === T0 + 120 ? [t] : [] })]);
    expect(r.create).toHaveBeenCalledTimes(1);
    expect(r.create).toHaveBeenCalledWith(expect.objectContaining({ title: "loja/web morreu por falta de memória" }));
  });
});

describe("containers", () => {
  const loop = (t: number, n: number) => Array.from({ length: n }, () => t - 30);

  it("mais de 3 reinícios em 15 min dispara (3 não); some a 15 min de calmaria", async () => {
    const three = rig();
    await three.run(2, () => ({}), (t) => [cont({ restartsAt: loop(t, 3) })]);
    expect(three.create).not.toHaveBeenCalled();

    const r = rig();
    await r.run(2, () => ({}), (t) => [cont({ restartsAt: loop(t, 4) })]);
    expect(r.create).toHaveBeenCalledTimes(1);
    expect(r.create).toHaveBeenCalledWith(expect.objectContaining({ severity: "critical", title: "loja/web reinicia sem parar" }));
    await r.run(5, () => ({}), (t) => [cont({ restartsAt: loop(t, 2) })]); // ainda reiniciando, mas abaixo do laço: continua
    expect(r.resolve).not.toHaveBeenCalled();
    await r.run(1, () => ({}), () => [cont({ restartsAt: [] })]);
    expect(r.resolve).toHaveBeenCalledTimes(1);
  });

  it("não saudável por mais de 5 minutos dispara; volta depois de 10 voltas saudáveis seguidas", async () => {
    const r = rig();
    const since = T0 + 60;
    await r.run(5, () => ({}), () => [cont({ health: "unhealthy", unhealthySince: since })]); // 4 min
    expect(r.create).not.toHaveBeenCalled();
    await r.run(2, () => ({}), () => [cont({ health: "unhealthy", unhealthySince: since })]); // > 5 min
    expect(r.create).toHaveBeenCalledWith(expect.objectContaining({ severity: "warning", title: "loja/web não passa na verificação de saúde" }));
    await r.run(9, () => ({}), () => [cont()]);
    expect(r.resolve).not.toHaveBeenCalled();
    await r.run(1, () => ({}), () => [cont()]);
    expect(r.resolve).toHaveBeenCalledTimes(1);
  });

  it("uma volta não saudável no meio zera a contagem de voltas saudáveis", async () => {
    const r = rig();
    await r.run(8, () => ({}), (t) => [cont({ health: "unhealthy", unhealthySince: t - 600 })]);
    await r.run(9, () => ({}), () => [cont()]);
    await r.run(1, () => ({}), (t) => [cont({ health: "unhealthy", unhealthySince: t - 600 })]);
    await r.run(9, () => ({}), () => [cont()]);
    expect(r.resolve).not.toHaveBeenCalled();
    await r.run(1, () => ({}), () => [cont()]);
    expect(r.resolve).toHaveBeenCalledTimes(1);
  });

  it("container que some (projeto apagado) encerra os alertas dele", async () => {
    const r = rig();
    await r.run(2, () => ({}), (t) => [cont({ restartsAt: loop(t, 5) })]);
    expect(r.w.activeKeys()).toEqual([`c:${"a".repeat(64)}:loop`]);
    await r.run(1, () => ({}), () => []);
    expect(r.resolve).toHaveBeenCalledTimes(1);
    expect(r.w.activeKeys()).toEqual([]);
  });

  it("fora de projeto o nome é o do container", async () => {
    const r = rig();
    await r.run(2, () => ({}), (t) => [cont({ slug: null, service: null, name: "redis", restartsAt: loop(t, 5) })]);
    expect(r.create).toHaveBeenCalledWith(expect.objectContaining({ title: "redis reinicia sem parar" }));
  });

  it("reinícios velhos (fora da janela de 15 min) não contam", async () => {
    const r = rig();
    await r.run(2, () => ({}), (t) => [cont({ restartsAt: loop(t - RESTART_WINDOW_SECONDS, 6) })]);
    expect(r.create).not.toHaveBeenCalled();
  });
});

describe("falhas da central de alertas", () => {
  beforeEach(() => undefined);

  it("criar o alerta falhando: não marca como ativo e tenta de novo na volta seguinte; só o log sabe", async () => {
    const r = rig();
    r.create.mockRejectedValueOnce(new Error("disco")).mockRejectedValueOnce("texto");
    await r.run(1, () => ({ inodePct: 99 }));
    expect(r.w.activeKeys()).toEqual([]);
    await r.run(1, () => ({ inodePct: 99 }));
    expect(r.w.activeKeys()).toEqual([]);
    await r.run(1, () => ({ inodePct: 99 }));
    expect(r.w.activeKeys()).toEqual(["host:inodes"]);
    expect(r.logs.filter((l) => l.includes("alerta não gravado"))).toHaveLength(2);
  });

  it("encerrar falhando: continua ativo e tenta de novo", async () => {
    const r = rig();
    await r.run(1, () => ({ inodePct: 99 }));
    r.resolve.mockRejectedValueOnce(new Error("disco")).mockRejectedValueOnce("texto");
    await r.run(1, () => ({ inodePct: 10 }));
    expect(r.w.activeKeys()).toEqual(["host:inodes"]);
    await r.run(1, () => ({ inodePct: 10 }));
    expect(r.w.activeKeys()).toEqual(["host:inodes"]);
    await r.run(1, () => ({ inodePct: 10 }));
    expect(r.w.activeKeys()).toEqual([]);
    expect(r.logs.filter((l) => l.includes("alerta não encerrado"))).toHaveLength(2);
  });

  it("alerta que já estava aberto de antes (created=false) também é encerrado depois", async () => {
    const r = rig();
    r.create.mockResolvedValueOnce({ alert: { id: "antigo" }, created: false });
    await r.run(1, () => ({ inodePct: 99 }));
    await r.run(1, () => ({ inodePct: 10 }));
    expect(r.resolve).toHaveBeenCalledWith("antigo");
  });
});

describe("limiares fixos", () => {
  it("os números da pesquisa", () => {
    expect(WATCH).toMatchObject({ memPsiRaise: 20, memPsiClear: 10, cpuPsiRaise: 50, cpuPsiClear: 30, stealRaise: 10, stealClear: 5, ioRaise: 30, ioClear: 15, inodeRaise: 90, inodeClear: 85, restartLoop: 3, unhealthySeconds: 300 });
  });
});

describe("Docker sem resposta (volta sem leitura dos containers)", () => {
  const loopOf = (t: number) => Array.from({ length: 5 }, () => t - 30);

  it("cria o alerta, o Docker falha por algumas voltas, volta: nada é encerrado nem recriado (sem nova notificação)", async () => {
    const r = rig();
    await r.run(2, () => ({}), (t) => [cont({ restartsAt: loopOf(t) })]);
    expect(r.create).toHaveBeenCalledTimes(1);
    r.dockerOk = false;
    await r.run(3, () => ({}), () => []); // lista vazia + dockerOk=false: o coletor não leu
    expect(r.resolve).not.toHaveBeenCalled();
    expect(r.w.activeKeys()).toEqual([`c:${"a".repeat(64)}:loop`]);
    r.dockerOk = true;
    await r.run(2, () => ({}), (t) => [cont({ restartsAt: loopOf(t) })]);
    expect(r.resolve).not.toHaveBeenCalled();
    expect(r.create).toHaveBeenCalledTimes(1);
  });

  it("o contador de voltas saudáveis também não é zerado nem avança sem leitura", async () => {
    const r = rig();
    await r.run(8, () => ({}), (t) => [cont({ health: "unhealthy", unhealthySince: t - 600 })]);
    await r.run(9, () => ({}), () => [cont()]);
    r.dockerOk = false;
    await r.run(5, () => ({}), () => []);
    r.dockerOk = true;
    expect(r.resolve).not.toHaveBeenCalled();
    await r.run(1, () => ({}), () => [cont()]);
    expect(r.resolve).toHaveBeenCalledTimes(1);
  });

  it("o host continua sendo avaliado sem o Docker", async () => {
    const r = rig();
    r.dockerOk = false;
    await r.run(5, () => ({ psiMem: 50 }));
    expect(r.create).toHaveBeenCalledWith(expect.objectContaining({ title: "Memória da VPS apertada" }));
  });
});

describe("alertas abertos de antes de reiniciar o painel", () => {
  const loopOf = (t: number) => Array.from({ length: 5 }, () => t - 30);

  it("adota o alerta aberto de host e o encerra pela histerese normal (sem nova notificação enquanto a condição dura)", async () => {
    const listOpen = vi.fn(async () => [{ id: "velho-1", title: "Memória da VPS apertada" }]);
    const r = rig(listOpen);
    await r.run(20, () => ({ psiMem: 15 })); // entre 10% e 20%: continua aberto, sem criar outro
    expect(r.create).not.toHaveBeenCalled();
    expect(r.resolve).not.toHaveBeenCalled();
    expect(r.w.activeKeys()).toEqual(["host:memory"]);
    await r.run(15, () => ({ psiMem: 1 }));
    expect(r.resolve).toHaveBeenCalledWith("velho-1");
    expect(listOpen).toHaveBeenCalledTimes(1);
  });

  it("alerta cuja condição acabou durante a parada se resolve sozinho", async () => {
    const r = rig(async () => [{ id: "velho-2", title: "Disco da VPS lento" }]);
    await r.run(12, () => ({ cpuIowait: 1, psiIo: 1 }));
    expect(r.resolve).toHaveBeenCalledWith("velho-2");
  });

  it("alerta de container: adota se o container existe; encerra se não existe mais; duplicata do mesmo título é encerrada", async () => {
    const r = rig(async () => [
      { id: "c-1", title: "loja/web reinicia sem parar" },
      { id: "c-2", title: "loja/web reinicia sem parar" },
      { id: "c-3", title: "velho/api não passa na verificação de saúde" },
    ]);
    await r.run(1, () => ({}), (t) => [cont({ restartsAt: loopOf(t) })]);
    expect(r.w.activeKeys()).toEqual([`c:${"a".repeat(64)}:loop`]);
    expect(r.create).not.toHaveBeenCalled();
    expect(r.resolve.mock.calls.map((c) => c[0]).sort()).toEqual(["c-2", "c-3"]);
  });

  it("eventos (morte por falta de memória) e alertas de outros assuntos ficam como estão", async () => {
    const r = rig(async () => [
      { id: "e-1", title: "A VPS matou um processo por falta de memória" },
      { id: "e-2", title: "loja/web morreu por falta de memória" },
      { id: "x-1", title: "Algo que não é do vigia" },
    ]);
    await r.run(3, () => ({}), () => [cont()]);
    expect(r.resolve).not.toHaveBeenCalled();
    expect(r.w.activeKeys()).toEqual([]);
  });

  it("só adota quando o Docker respondeu (container 'sumido' por falta de leitura não é encerrado)", async () => {
    const listOpen = vi.fn(async () => [{ id: "c-1", title: "loja/web reinicia sem parar" }]);
    const r = rig(listOpen);
    r.dockerOk = false;
    await r.run(3, () => ({}), () => []);
    expect(listOpen).not.toHaveBeenCalled();
    r.dockerOk = true;
    await r.run(1, () => ({}), (t) => [cont({ restartsAt: loopOf(t) })]);
    expect(listOpen).toHaveBeenCalledTimes(1);
    expect(r.resolve).not.toHaveBeenCalled();
    expect(r.create).not.toHaveBeenCalled();
  });

  it("não conseguir ler os alertas abertos vai ao log e tenta de novo na volta seguinte; sem a função, nada é adotado", async () => {
    let fail = true;
    const listOpen = vi.fn(async () => {
      if (fail) throw new Error("disco");
      return [{ id: "velho-1", title: "Memória da VPS apertada" }];
    });
    const r = rig(listOpen);
    await r.run(1, () => ({}));
    expect(r.logs.join("\n")).toContain("alertas abertos não lidos (disco)");
    fail = false;
    await r.run(1, () => ({}));
    expect(r.w.activeKeys()).toEqual(["host:memory"]);
    const semFuncao = rig();
    await semFuncao.run(2, () => ({}));
    expect(semFuncao.w.activeKeys()).toEqual([]);
  });

  it("erro que não é Error também é registrado", async () => {
    const r = rig(async () => Promise.reject("texto"));
    await r.run(1, () => ({}));
    expect(r.logs.join("\n")).toContain("(texto)");
  });
});

describe("vigia: sobreviventes da revisão", () => {
  const loopOf = (t: number) => Array.from({ length: 5 }, () => t - 30);

  it("volta sem leitura do Docker que traz containers (mantidos): nada é avaliado, nem o contador de voltas saudáveis anda", async () => {
    const r = rig();
    await r.run(8, () => ({}), (t) => [cont({ health: "unhealthy", unhealthySince: t - 600 })]);
    expect(r.create).toHaveBeenCalledTimes(1);
    r.dockerOk = false;
    await r.run(12, () => ({}), () => [cont()]); // "saudáveis" só no estado mantido
    expect(r.resolve).not.toHaveBeenCalled();
    r.dockerOk = true;
    await r.run(9, () => ({}), () => [cont()]);
    expect(r.resolve).not.toHaveBeenCalled(); // faltam as 10 voltas de verdade
    await r.run(1, () => ({}), () => [cont()]);
    expect(r.resolve).toHaveBeenCalledTimes(1);
  });

  it("adoção não pega o alerta de evento de OOM: uma morte nova na primeira volta não encerra o alerta aberto", async () => {
    const r = rig(async () => [{ id: "evento-1", title: "loja/web morreu por falta de memória" }]);
    await r.run(1, () => ({}), (t) => [cont({ oomAt: [t] })]);
    expect(r.resolve).not.toHaveBeenCalled();
    expect(r.create).toHaveBeenCalledTimes(1);
    expect(r.create).toHaveBeenCalledWith(expect.objectContaining({ title: "loja/web morreu por falta de memória" }));
  });

  it("laço de reinício adotado só volta ao normal depois de uma janela inteira observada (histórico começou vazio)", async () => {
    const r = rig(async () => [{ id: "laco-1", title: "loja/web reinicia sem parar" }]);
    await r.run(10, () => ({}), () => [cont({ restartsAt: [] })]);
    expect(r.resolve).not.toHaveBeenCalled();
    await r.run(6, () => ({}), () => [cont({ restartsAt: [] })]); // passou de 15 min desde a adoção
    expect(r.resolve).toHaveBeenCalledWith("laco-1");
  });

  it("laço adotado que continua: não encerra e não notifica de novo", async () => {
    const r = rig(async () => [{ id: "laco-1", title: "loja/web reinicia sem parar" }]);
    await r.run(20, () => ({}), (t) => [cont({ restartsAt: loopOf(t) })]);
    expect(r.resolve).not.toHaveBeenCalled();
    expect(r.create).not.toHaveBeenCalled();
  });

  it("réplicas do mesmo serviço dividem o alerta: só se encerra quando a última se recupera", async () => {
    const a = "a".repeat(64);
    const b = "b".repeat(64);
    const r = rig();
    // as duas em laço: o segundo create devolve o mesmo alerta (dedupe por título)
    r.create.mockImplementation(async () => ({ alert: { id: "unico" }, created: true }));
    await r.run(2, () => ({}), (t) => [cont({ id: a, restartsAt: loopOf(t) }), cont({ id: b, restartsAt: loopOf(t) })]);
    expect(r.w.activeKeys()).toHaveLength(2);
    // a réplica A se recupera, a B continua em laço
    await r.run(1, () => ({}), (t) => [cont({ id: a, restartsAt: [] }), cont({ id: b, restartsAt: loopOf(t) })]);
    expect(r.resolve).not.toHaveBeenCalled();
    expect(r.w.activeKeys()).toEqual([`c:${b}:loop`]);
    // B também
    await r.run(1, () => ({}), () => [cont({ id: a, restartsAt: [] }), cont({ id: b, restartsAt: [] })]);
    expect(r.resolve).toHaveBeenCalledTimes(1);
    expect(r.resolve).toHaveBeenCalledWith("unico");
  });

  it("a mensagem do container não afirma que foi o limite dele", async () => {
    const r = rig();
    await r.run(1, () => ({}), (t) => [cont({ oomAt: [t] })]);
    const detail = (r.create.mock.calls[0] as unknown as [{ detail: string }])[0].detail;
    expect(detail).not.toContain("passou do limite");
    expect(detail).toContain("VPS");
  });
});

describe("morte de container que já saiu da lista", () => {
  it("abre o alerta com o rótulo lembrado, um por ocorrência, sem ficar ativo; fora de projeto usa o nome", async () => {
    const r = rig();
    const orphan = (label: string) => ({ label, count: 1 });
    r.t += 60;
    await r.w.evaluate({ t: r.t, host: {}, containers: [], sample: { t: r.t, h: {}, c: {} }, dockerOk: true, orphanOoms: [orphan("loja/web"), orphan("redis")] }, []);
    expect(r.create).toHaveBeenCalledTimes(2);
    expect(r.create).toHaveBeenCalledWith(expect.objectContaining({ severity: "critical", title: "loja/web morreu por falta de memória" }));
    expect(r.create).toHaveBeenCalledWith(expect.objectContaining({ title: "redis morreu por falta de memória" }));
    expect(r.w.activeKeys()).toEqual([]);
    // com o Docker sem resposta o aviso também sai (o evento já aconteceu)
    r.t += 60;
    await r.w.evaluate({ t: r.t, host: {}, containers: [], sample: { t: r.t, h: {}, c: {} }, dockerOk: false, orphanOoms: [orphan("loja/web")] }, []);
    expect(r.create).toHaveBeenCalledTimes(3);
  });
});
