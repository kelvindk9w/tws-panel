/**
 * aof-repair.test.ts — o reparo do AOF do redis pela regra (Docker em dublê): medir antes e nada alterar quando
 * não dá (imagem sem a ferramenta, manifesto ausente, arquivo íntegro, corte maior que o confirmado), a sequência
 * parar → copiar → cortar → ligar, a falha em cada etapa (e o serviço religado), a pasta de dados e a do AOF
 * vindas do container (nunca do cliente nem do log), o projeto parado pela pessoa que continua parado, o dono
 * conferido pela identidade do container e um reparo por projeto de cada vez.
 */
import { describe, expect, it, vi } from "vitest";
import type { DockerContainerInfo } from "@paas/core";
import {
  AOF_EXIT,
  AOF_OUTPUT_MAX,
  AofRepairService,
  BACKUP_SCRIPT,
  FIX_SCRIPT,
  MEASURE_SCRIPT,
  backupDirName,
  helperMount,
  isSafeAbsPath,
  mountFor,
  parseCheckAofOutput,
  resolveDataDir,
  type AofRepairDeps,
} from "../src/services/aof-repair.js";
import type { AofContainerInspect, AofDocker, AofHelperResult, AofHelperSpec, AofMount } from "../src/services/aof-repair-docker.js";

const NOW = Date.UTC(2026, 10, 14, 3, 15, 9);
const ID = "a".repeat(64);
const PROJECT = { id: "p1", slug: "loja", name: "Loja" };
// Redis 8.4+ (com a pasta no log) e Redis 7.x–8.2 (só o nome), texto de src/aof.c
const AOF_LINE =
  "# Bad file format reading the append only file appendonlydir/appendonly.aof.27.incr.aof at offset 29790725.          make a backup of your AOF file, then use ./redis-check-aof --fix <filename.manifest>.          Alternatively you can set the 'aof-load-corrupt-tail-max-size' configuration option to 1397 and restart the server.";
const AOF_LINE_7 = "# Bad file format reading the append only file appendonly.aof.27.incr.aof: make a backup of your AOF file, then use ./redis-check-aof --fix <filename.manifest>";
const VALKEY_TRUNCATED =
  "# Unexpected end of file reading the append only file appendonly.aof.27.incr.aof. You can: 1) Make a backup of your AOF file, then use ./valkey-check-aof --fix <filename.manifest>. 2) Alternatively you can set the 'aof-load-truncated' configuration option to yes and restart the server.";
const analyzed = (diff: number) => `AOF analyzed: filename=appendonly.aof.27.incr.aof, size=29792122, ok_up_to=29790725, ok_up_to_line=1, diff=${diff}`;
const MEASURE_OUT = `Start checking Multi Part AOF\n${analyzed(0).replace("27.incr", "1.base")}\n${analyzed(1397)}\nAOF appendonly.aof.27.incr.aof is not valid. Use the --fix option to try fixing it.\n`;
const FIX_OUT = `${analyzed(1397)}\n${analyzed(1397)}\nThis will shrink the AOF appendonly.aof.27.incr.aof from 29792122 bytes, with 1397 bytes, to 29790725 bytes\nContinue? [y/N]: Successfully truncated AOF appendonly.aof.27.incr.aof\n`;

const listed = (over: Partial<DockerContainerInfo> = {}): DockerContainerInfo => ({
  id: ID.slice(0, 12),
  name: "paas-loja-redis-1",
  image: "redis:8",
  state: "restarting",
  status: "Restarting (1) 5 seconds ago",
  managed: true,
  projectSlug: "loja",
  composeProject: "paas-loja",
  service: "redis",
  ports: [],
  ...over,
});

const inspected = (over: Partial<AofContainerInspect> = {}): AofContainerInspect => ({
  id: ID,
  name: "paas-loja-redis-1",
  image: "sha256:" + "b".repeat(64),
  state: "restarting",
  labels: { "com.docker.compose.project": "paas-loja", "com.docker.compose.service": "redis" },
  workingDir: "/data",
  argv: ["docker-entrypoint.sh", "redis-server", "--appendonly", "yes"],
  mounts: [{ type: "volume", name: "paas-loja_redis-data", source: "/var/lib/docker/volumes/paas-loja_redis-data/_data", destination: "/data", rw: true }],
  ...over,
});

type Step = "measure" | "backup" | "fix";
const stepOf = (s: AofHelperSpec): Step => (s.script === MEASURE_SCRIPT ? "measure" : s.script === BACKUP_SCRIPT ? "backup" : "fix");

function rig(opts: {
  containers?: DockerContainerInfo[] | (() => Promise<DockerContainerInfo[]>);
  inspect?: AofContainerInspect | null;
  lines?: string[] | null;
  helper?: Partial<Record<Step, AofHelperResult>>;
  stopFails?: boolean;
  startFails?: boolean;
  auditFails?: boolean;
  /** O projeto está parado pela pessoa: uma resposta por consulta (a última se repete). */
  stopped?: Array<boolean | "throw">;
} = {}) {
  const calls: string[] = [];
  const specs: AofHelperSpec[] = [];
  const audits: Array<{ actor: string; action: string; target: string; detail: string }> = [];
  const released = { hold: 0, maintenance: 0 };
  const manual: string[] = [];
  const results: Record<Step, AofHelperResult> = {
    measure: { code: 1, output: MEASURE_OUT, timedOut: false },
    backup: { code: 0, output: "copia feita: appendonlydir.bak-20261114-031509\n", timedOut: false },
    fix: { code: 0, output: FIX_OUT, timedOut: false },
    ...opts.helper,
  };
  const docker: AofDocker = {
    inspect: vi.fn(async () => (opts.inspect === undefined ? inspected() : opts.inspect)),
    helper: vi.fn(async (spec: AofHelperSpec) => {
      const step = stepOf(spec);
      calls.push(step);
      specs.push(spec);
      return results[step];
    }),
    stop: vi.fn(async () => {
      calls.push("stop");
      if (opts.stopFails) throw new Error("tempo esgotado");
    }),
    start: vi.fn(async () => {
      calls.push("start");
      if (opts.startFails) throw new Error("porta ocupada");
    }),
  };
  const deps: AofRepairDeps = {
    listContainers: typeof opts.containers === "function" ? opts.containers : async () => (opts.containers as DockerContainerInfo[] | undefined) ?? [listed()],
    logs: vi.fn(async () => (opts.lines === undefined ? ["* Server initialized", AOF_LINE] : opts.lines)),
    docker,
    hold: vi.fn(async () => () => {
      released.hold++;
    }),
    maintenance: vi.fn(() => () => {
      released.maintenance++;
    }),
    noteManualAction: (slug) => manual.push(slug),
    stoppedByUser: vi.fn(async () => {
      const seq = opts.stopped ?? [false];
      const v = seq.length > 1 ? seq.shift()! : seq[0]!;
      if (v === "throw") throw new Error("projetos.json ilegível");
      return v;
    }),
    forgetDiagnosis: vi.fn(),
    audit: async (e) => {
      if (opts.auditFails) throw new Error("disco cheio");
      audits.push(e);
    },
    now: () => NOW,
  };
  return { svc: new AofRepairService(deps), deps, docker, calls, specs, audits, released, manual };
}

async function failure(p: Promise<unknown>): Promise<{ statusCode: number; code: string; message: string; details?: Record<string, unknown> }> {
  try {
    await p;
  } catch (err) {
    return err as { statusCode: number; code: string; message: string; details?: Record<string, unknown> };
  }
  throw new Error("esperava falhar");
}

describe("funções puras", () => {
  it("parseCheckAofOutput: a última linha 'AOF analyzed' vale; corte só com 'Successfully truncated'", () => {
    expect(parseCheckAofOutput(MEASURE_OUT)).toEqual({ diff: 1397, truncated: false });
    expect(parseCheckAofOutput(FIX_OUT)).toEqual({ diff: 1397, truncated: true });
    expect(parseCheckAofOutput("Cannot open file x, aborting...")).toEqual({ diff: null, truncated: false });
    expect(parseCheckAofOutput(analyzed(0).replace("diff=0", "diff=99999999999999999999"))).toEqual({ diff: null, truncated: false });
  });

  it("resolveDataDir: --dir absoluto, --dir relativo à pasta de trabalho, ou a pasta de trabalho", () => {
    expect(resolveDataDir({ argv: ["redis-server"], workingDir: "/data" })).toBe("/data");
    expect(resolveDataDir({ argv: ["redis-server", "--dir", "/var/lib/redis"], workingDir: "/data" })).toBe("/var/lib/redis");
    expect(resolveDataDir({ argv: ["redis-server", "--dir", "sub/", "--dir", "./aof"], workingDir: "/data/" })).toBe("/data/aof");
    expect(resolveDataDir({ argv: ["redis-server", "--dir", "/x/"], workingDir: null })).toBe("/x");
  });

  it("resolveDataDir: sem como saber, raiz, '..' ou caracteres perigosos: null", () => {
    expect(resolveDataDir({ argv: ["redis-server"], workingDir: null })).toBeNull();
    expect(resolveDataDir({ argv: ["redis-server"], workingDir: "relativa" })).toBeNull();
    expect(resolveDataDir({ argv: ["redis-server", "--dir", "rel"], workingDir: null })).toBeNull();
    expect(resolveDataDir({ argv: ["redis-server", "--dir", "/"], workingDir: "/data" })).toBeNull();
    expect(resolveDataDir({ argv: ["redis-server", "--dir", "/data,dst=/etc"], workingDir: "/data" })).toBeNull();
    expect(resolveDataDir({ argv: ["redis-server", "--dir", "/a b"], workingDir: "/data" })).toBeNull();
    // `--dir` sem valor no fim é ignorado
    expect(resolveDataDir({ argv: ["redis-server", "--dir"], workingDir: "/data" })).toBe("/data");
  });

  it("isSafeAbsPath", () => {
    expect(isSafeAbsPath("/data")).toBe(true);
    for (const bad of ["data", "/data/", "/a/../b", "//data", "/a/./b", "/a,b", "/a=b", "/a b", "/a\nb", "/$(id)"]) expect(isSafeAbsPath(bad)).toBe(false);
  });

  it("mountFor: o volume que contém a pasta (o mais específico); tmpfs e pastas vizinhas não servem", () => {
    const m = (destination: string, type = "volume"): AofMount => ({ type, name: "v", source: "/s", destination, rw: true });
    expect(mountFor("/data", [m("/data")])?.destination).toBe("/data");
    expect(mountFor("/data/aof", [m("/data"), m("/data/aof")])?.destination).toBe("/data/aof");
    expect(mountFor("/data/aof", [m("/data/aof"), m("/data")])?.destination).toBe("/data/aof");
    expect(mountFor("/database", [m("/data")])).toBeNull();
    expect(mountFor("/data", [m("/data", "tmpfs")])).toBeNull();
    expect(mountFor("/data", [])).toBeNull();
  });

  it("helperMount: só nome de volume e caminho de bind seguros", () => {
    expect(helperMount({ type: "volume", name: "paas-loja_redis", source: "/x", destination: "/data", rw: true })).toEqual({ type: "volume", source: "paas-loja_redis", destination: "/data" });
    expect(helperMount({ type: "bind", name: null, source: "/srv/redis", destination: "/data", rw: true })).toEqual({ type: "bind", source: "/srv/redis", destination: "/data" });
    expect(helperMount({ type: "volume", name: null, source: "/x", destination: "/data", rw: true })).toBeNull();
    expect(helperMount({ type: "volume", name: "a,dst=/etc", source: "/x", destination: "/data", rw: true })).toBeNull();
    expect(helperMount({ type: "bind", name: null, source: "/", destination: "/data", rw: true })).toBeNull();
    expect(helperMount({ type: "bind", name: null, source: "/srv/a,b", destination: "/data", rw: true })).toBeNull();
    expect(helperMount({ type: "volume", name: "v", source: "/x", destination: "/", rw: true })).toBeNull();
  });

  it("backupDirName: <pasta>.bak-AAAAMMDD-HHMMSS em UTC", () => {
    expect(backupDirName("appendonlydir", NOW)).toBe("appendonlydir.bak-20261114-031509");
  });

  it("scripts: argumentos posicionais (nada do log vira texto de shell), sim ao --fix só depois de conferir o máximo", () => {
    for (const s of [MEASURE_SCRIPT, FIX_SCRIPT]) {
      expect(s).toContain('command -v "$tool"');
      expect(s).toContain('[ -f "$dir/$manifest" ]');
    }
    expect(MEASURE_SCRIPT).not.toContain("--fix");
    expect(FIX_SCRIPT.indexOf('[ "$d" -le "$max" ] || exit 94')).toBeLessThan(FIX_SCRIPT.indexOf("--fix"));
    expect(BACKUP_SCRIPT).toContain('cp -a "$dir" "$bak"');
    expect(BACKUP_SCRIPT).toContain('rm -rf "$bak"');
  });
});

describe("medir (nada é alterado)", () => {
  it("devolve os bytes que a ferramenta cortaria, sem parar o serviço", async () => {
    const r = rig();
    expect(await r.svc.measure(PROJECT, "redis")).toEqual({ service: "redis", file: "appendonly.aof.27.incr.aof", bytes: 1397 });
    expect(r.calls).toEqual(["measure"]);
    expect(r.specs[0]).toMatchObject({
      image: "sha256:" + "b".repeat(64),
      mount: { type: "volume", source: "paas-loja_redis-data", destination: "/data" },
      workdir: "/data",
      args: ["redis-check-aof", "appendonlydir", "appendonly.aof.manifest"],
    });
    expect(r.svc.isBusy("p1")).toBe(false);
  });

  it("valkey: a ferramenta da imagem é a valkey-check-aof", async () => {
    const r = rig({ lines: [AOF_LINE.replace("./redis-check-aof", "./valkey-check-aof")] });
    await r.svc.measure(PROJECT, "redis");
    expect(r.specs[0]!.args[0]).toBe("valkey-check-aof");
  });

  it("Redis 7.x a 8.2 (só o nome no log): a pasta do AOF é a padrão, vinda do container", async () => {
    const r = rig({ lines: [AOF_LINE_7] });
    expect(await r.svc.measure(PROJECT, "redis")).toEqual({ service: "redis", file: "appendonly.aof.27.incr.aof", bytes: 1397 });
    expect(r.specs[0]!.args).toEqual(["redis-check-aof", "appendonlydir", "appendonly.aof.manifest"]);
  });

  it("pasta do AOF trocada por --appenddirname no container: vale a do container, com o log só com o nome", async () => {
    const r = rig({ lines: [VALKEY_TRUNCATED], inspect: inspected({ argv: ["valkey-server", "--appendonly", "yes", "--appenddirname", "dados-aof"] }) });
    await r.svc.measure(PROJECT, "redis");
    expect(r.specs[0]!.args).toEqual(["valkey-check-aof", "dados-aof", "appendonly.aof.manifest"]);
    const rep2 = rig({ lines: [AOF_LINE_7], inspect: inspected({ argv: ["redis-server", "--appenddirname", "dados-aof"] }) });
    const out = await rep2.svc.repair(PROJECT, "redis", 5000, "kelvin");
    expect(out.backup).toBe("dados-aof.bak-20261114-031509");
    expect(rep2.specs[1]!.args).toEqual(["dados-aof", "dados-aof.bak-20261114-031509"]);
    expect(rep2.specs[2]!.args).toEqual(["redis-check-aof", "dados-aof", "appendonly.aof.manifest", "5000"]);
  });

  it("a pasta escrita no log (Redis 8.4+) diferente da configuração do container, ou --appenddirname inseguro: 422, nada feito", async () => {
    for (const argv of [["redis-server", "--appenddirname", "outra"], ["redis-server", "--appenddirname", "../etc"]]) {
      const r = rig({ inspect: inspected({ argv }) });
      expect(await failure(r.svc.repair(PROJECT, "redis", 5000, "kelvin"))).toMatchObject({ statusCode: 422, code: "aof_data_dir_unknown" });
      expect(r.calls).toEqual([]);
    }
  });

  it("arquivo íntegro: 409 aof_already_valid", async () => {
    const r = rig({ helper: { measure: { code: 0, output: `${analyzed(0)}\nAll AOF files and manifest are valid\n`, timedOut: false } } });
    expect(await failure(r.svc.measure(PROJECT, "redis"))).toMatchObject({ statusCode: 409, code: "aof_already_valid" });
  });
});

describe("validação do pedido e do alvo", () => {
  it.each([
    ["nome malicioso de serviço", { service: "../redis" }, 400, "invalid_service"],
    ["serviço com espaço e ponto-e-vírgula", { service: "redis; rm -rf /" }, 400, "invalid_service"],
    ["serviço que não existe no projeto", { service: "cache" }, 404, "service_not_found"],
  ])("%s", async (_n, body, status, code) => {
    const r = rig();
    expect(await failure(r.svc.repair(PROJECT, body.service, 5000, "kelvin"))).toMatchObject({ statusCode: status, code });
    expect(r.docker.stop).not.toHaveBeenCalled();
  });

  it("serviço de OUTRO projeto (mesmo nome de serviço): 404, nada consultado nele", async () => {
    const r = rig({ containers: [listed({ projectSlug: "blog", composeProject: "paas-blog", name: "paas-blog-redis-1" })] });
    expect(await failure(r.svc.repair(PROJECT, "redis", 5000, "kelvin"))).toMatchObject({ statusCode: 404, code: "service_not_found" });
    expect(r.docker.inspect).not.toHaveBeenCalled();
  });

  it("a lista dizia que era do projeto, mas a identidade no inspect diz outra (label forjada): 404", async () => {
    const r = rig({ inspect: inspected({ labels: { "com.docker.compose.project": "paas-blog", "paas.project": "loja", "paas.managed": "true" } }) });
    expect(await failure(r.svc.repair(PROJECT, "redis", 5000, "kelvin"))).toMatchObject({ statusCode: 404, code: "service_not_found" });
    expect(r.calls).toEqual([]);
  });

  it("container que não é do painel (não gerenciado) não conta", async () => {
    const r = rig({ containers: [listed({ managed: false })] });
    expect(await failure(r.svc.measure(PROJECT, "redis"))).toMatchObject({ statusCode: 404 });
  });

  it("réplicas: recusa com 409 (o reparo pelo painel é de um container)", async () => {
    const r = rig({ containers: [listed(), listed({ id: "c".repeat(12), name: "paas-loja-redis-2" })] });
    expect(await failure(r.svc.measure(PROJECT, "redis"))).toMatchObject({ statusCode: 409, code: "aof_multiple_containers" });
  });

  it("serviço sem nome de compose: vale o nome do container", async () => {
    const r = rig({ containers: [listed({ service: null, name: "redis" })] });
    expect((await r.svc.measure(PROJECT, "redis")).bytes).toBe(1397);
  });

  it("Docker não responde ao inspect, log ilegível, log sem a mensagem: nada é feito", async () => {
    expect(await failure(rig({ inspect: null }).svc.measure(PROJECT, "redis"))).toMatchObject({ statusCode: 503, code: "docker_unavailable" });
    expect(await failure(rig({ lines: null }).svc.measure(PROJECT, "redis"))).toMatchObject({ statusCode: 503, code: "aof_logs_unavailable" });
    const r = rig({ lines: ["* Ready to accept connections tcp"] });
    expect(await failure(r.svc.repair(PROJECT, "redis", 5000, "kelvin"))).toMatchObject({ statusCode: 409, code: "aof_not_detected" });
    expect(r.calls).toEqual([]);
  });

  it("pasta de dados desconhecida, fora de volume, volume só leitura ou com nome inseguro: 422 e nada alterado", async () => {
    const cases: Array<[Partial<AofContainerInspect>, string]> = [
      [{ workingDir: null, argv: ["redis-server"] }, "aof_data_dir_unknown"],
      [{ mounts: [] }, "aof_not_on_volume"],
      [{ mounts: [{ type: "volume", name: "v", source: "/s", destination: "/data", rw: false }] }, "aof_volume_read_only"],
      [{ mounts: [{ type: "volume", name: "v,dst=/etc", source: "/s", destination: "/data", rw: true }] }, "aof_data_dir_unknown"],
    ];
    for (const [over, code] of cases) {
      const r = rig({ inspect: inspected(over) });
      expect(await failure(r.svc.repair(PROJECT, "redis", 5000, "kelvin"))).toMatchObject({ statusCode: 422, code });
      expect(r.calls).toEqual([]);
    }
  });

  it("maxBytes inválido: 400 antes de qualquer coisa", async () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      const r = rig();
      expect(await failure(r.svc.repair(PROJECT, "redis", bad, "kelvin"))).toMatchObject({ statusCode: 400, code: "invalid_max_bytes" });
      expect(r.deps.hold).not.toHaveBeenCalled();
    }
  });
});

describe("antes de parar: imagem sem a ferramenta, manifesto ausente, prazo, saída estranha, corte maior que o confirmado", () => {
  it.each([
    [AOF_EXIT.noTool, "aof_tool_missing", 422],
    [127, "aof_tool_missing", 422],
    [126, "aof_tool_missing", 422],
    [AOF_EXIT.noManifest, "aof_manifest_missing", 422],
    [125, "aof_check_failed", 502],
  ])("código %s → %s, serviço nem parado", async (code, err, status) => {
    const r = rig({ helper: { measure: { code, output: "docker: Error response from daemon", timedOut: false } } });
    expect(await failure(r.svc.repair(PROJECT, "redis", 5000, "kelvin"))).toMatchObject({ statusCode: status, code: err });
    expect(r.calls).toEqual(["measure"]);
    expect(r.released).toEqual({ hold: 1, maintenance: 1 });
  });

  it("ferramenta que respondeu sem a linha de análise: 502 com a saída", async () => {
    const r = rig({ helper: { measure: { code: 1, output: "Cannot open file appendonlydir/x: Permission denied, aborting...", timedOut: false } } });
    const e = await failure(r.svc.repair(PROJECT, "redis", 5000, "kelvin"));
    expect(e).toMatchObject({ statusCode: 502, code: "aof_check_failed" });
    expect(String(e.details?.output)).toContain("Permission denied");
  });

  it("medição passou do prazo: 504", async () => {
    const r = rig({ helper: { measure: { code: 1, output: "", timedOut: true } } });
    expect(await failure(r.svc.repair(PROJECT, "redis", 5000, "kelvin"))).toMatchObject({ statusCode: 504, code: "aof_timeout" });
  });

  it("arquivo já íntegro: 409 e nada parado", async () => {
    const r = rig({ helper: { measure: { code: 0, output: analyzed(0), timedOut: false } } });
    expect(await failure(r.svc.repair(PROJECT, "redis", 5000, "kelvin"))).toMatchObject({ statusCode: 409, code: "aof_already_valid" });
    expect(r.calls).toEqual(["measure"]);
  });

  it("o corte passaria do confirmado: 409 com os bytes medidos, nada parado", async () => {
    const r = rig();
    const e = await failure(r.svc.repair(PROJECT, "redis", 1000, "kelvin"));
    expect(e).toMatchObject({ statusCode: 409, code: "aof_discard_exceeds", details: { bytes: 1397 } });
    expect(r.calls).toEqual(["measure"]);
  });
});

describe("reparo: parar → copiar → cortar → ligar", () => {
  it("caminho feliz: a ordem certa, a cópia com data e hora, o resultado, a auditoria e a manutenção", async () => {
    const r = rig();
    const out = await r.svc.repair(PROJECT, "redis", 1397, "kelvin");
    expect(r.calls).toEqual(["measure", "stop", "backup", "fix", "start"]);
    expect(out).toMatchObject({ ok: true, outcome: "repaired", service: "redis", backup: "appendonlydir.bak-20261114-031509", discardedBytes: 1397, restarted: true, keptStopped: false });
    expect(out.output).toContain("Successfully truncated");
    expect(r.specs[1]!.args).toEqual(["appendonlydir", "appendonlydir.bak-20261114-031509"]);
    expect(r.specs[2]!.args).toEqual(["redis-check-aof", "appendonlydir", "appendonly.aof.manifest", "1397"]);
    expect(r.deps.hold).toHaveBeenCalledWith("p1", expect.stringContaining("redis"));
    expect(r.deps.maintenance).toHaveBeenCalledWith("loja");
    expect(r.released).toEqual({ hold: 1, maintenance: 1 });
    expect(r.manual).toEqual(["loja", "loja"]);
    expect(r.audits).toEqual([expect.objectContaining({ actor: "kelvin", action: "project.aof_repaired", target: "loja" })]);
    expect(r.audits[0]!.detail).toContain("1397 bytes");
    expect(r.audits[0]!.detail).toContain("appendonlydir.bak-20261114-031509");
  });

  it("projeto parado pela pessoa: repara e o serviço FICA parado; o resultado e a auditoria dizem isso", async () => {
    const r = rig({ stopped: [true] });
    const out = await r.svc.repair(PROJECT, "redis", 5000, "kelvin");
    expect(r.calls).toEqual(["measure", "stop", "backup", "fix"]);
    expect(out).toMatchObject({ ok: true, outcome: "repaired", discardedBytes: 1397, restarted: false, keptStopped: true });
    expect(out.output).toContain("parado por você");
    expect(r.audits[0]).toMatchObject({ action: "project.aof_repaired" });
    expect(r.audits[0]!.detail).toContain("ficou parado");
  });

  it("parado pela pessoa enquanto o reparo rodava (conferido logo antes de ligar): não liga", async () => {
    const r = rig({ stopped: [false, true] });
    const out = await r.svc.repair(PROJECT, "redis", 5000, "kelvin");
    expect(r.calls).not.toContain("start");
    expect(out).toMatchObject({ outcome: "repaired", keptStopped: true, restarted: false });
    expect(r.deps.stoppedByUser).toHaveBeenCalledTimes(2);
  });

  it("projeto parado e a cópia ou o corte falharam: volta ao estado anterior, parado", async () => {
    const a = rig({ stopped: [true], helper: { backup: { code: 96, output: "", timedOut: false } } });
    expect(await a.svc.repair(PROJECT, "redis", 5000, "kelvin")).toMatchObject({ outcome: "backup_failed", restarted: false, keptStopped: true });
    expect(a.calls).not.toContain("start");
    expect(a.audits[0]!.detail).toContain("Serviço deixado parado");
    const b = rig({ stopped: [true], helper: { fix: { code: 1, output: "", timedOut: false } } });
    expect(await b.svc.repair(PROJECT, "redis", 5000, "kelvin")).toMatchObject({ outcome: "fix_failed", restarted: false, keptStopped: true });
  });

  it("não deu para ler se o projeto está parado: volta ao que era (em ciclo = ligado)", async () => {
    const r = rig({ stopped: ["throw"] });
    const out = await r.svc.repair(PROJECT, "redis", 5000, "kelvin");
    expect(r.calls).toEqual(["measure", "stop", "backup", "fix", "start"]);
    expect(out).toMatchObject({ restarted: true, keptStopped: false });
  });

  it("o container não para: 502, nada alterado, auditado", async () => {
    const r = rig({ stopFails: true });
    expect(await failure(r.svc.repair(PROJECT, "redis", 5000, "kelvin"))).toMatchObject({ statusCode: 502, code: "aof_stop_failed" });
    expect(r.calls).toEqual(["measure", "stop"]);
    expect(r.audits[0]!.action).toBe("project.aof_repair_failed");
    expect(r.released).toEqual({ hold: 1, maintenance: 1 });
  });

  it.each([
    [{ code: AOF_EXIT.copyFailed, output: "cp: write error: No space left on device", timedOut: false }, "espaço em disco"],
    [{ code: AOF_EXIT.backupExists, output: "", timedOut: false }, "Já existe uma cópia"],
    [{ code: 1, output: "", timedOut: true }, "passou do prazo"],
  ])("cópia falhou (%#): nada cortado, serviço religado", async (backup, text) => {
    const r = rig({ helper: { backup } });
    const out = await r.svc.repair(PROJECT, "redis", 5000, "kelvin");
    expect(r.calls).toEqual(["measure", "stop", "backup", "start"]);
    expect(out).toMatchObject({ ok: false, outcome: "backup_failed", backup: null, discardedBytes: null, restarted: true });
    expect(out.output).toContain(text);
    expect(r.audits[0]!.action).toBe("project.aof_repair_failed");
  });

  it.each([
    [{ code: 1, output: `${analyzed(1397)}\nFailed to truncate AOF appendonly.aof.3.incr.aof because it is not the last file\n`, timedOut: false }, "não cortou"],
    [{ code: AOF_EXIT.exceeds, output: analyzed(9999), timedOut: false }, "passaria dos 5000 bytes"],
    [{ code: AOF_EXIT.alreadyValid, output: analyzed(0), timedOut: false }, "já está íntegro"],
    [{ code: 1, output: "", timedOut: true }, "passou do prazo"],
    [{ code: 0, output: analyzed(1397), timedOut: false }, "não cortou"],
  ])("--fix falhou (%#): serviço religado no estado anterior, a cópia fica", async (fix, text) => {
    const r = rig({ helper: { fix } });
    const out = await r.svc.repair(PROJECT, "redis", 5000, "kelvin");
    expect(r.calls).toEqual(["measure", "stop", "backup", "fix", "start"]);
    expect(out).toMatchObject({ ok: false, outcome: "fix_failed", backup: "appendonlydir.bak-20261114-031509", discardedBytes: null, restarted: true });
    expect(out.output).toContain(text);
    expect(r.audits[0]!.detail).toContain("A cópia appendonlydir.bak-20261114-031509 ficou");
  });

  it("cortou, mas o serviço não voltou: start_failed (cópia e corte ficam), auditado como falha", async () => {
    const r = rig({ startFails: true });
    const out = await r.svc.repair(PROJECT, "redis", 5000, "kelvin");
    expect(out).toMatchObject({ ok: false, outcome: "start_failed", discardedBytes: 1397, restarted: false });
    expect(out.output).toContain("NÃO voltou a subir: porta ocupada");
    expect(r.audits[0]!.action).toBe("project.aof_repair_failed");
  });

  it("cópia ou corte falharam e o serviço também não voltou: restarted false", async () => {
    const a = rig({ startFails: true, helper: { backup: { code: 96, output: "", timedOut: false } } });
    expect(await a.svc.repair(PROJECT, "redis", 5000, "kelvin")).toMatchObject({ outcome: "backup_failed", restarted: false });
    const b = rig({ startFails: true, helper: { fix: { code: 1, output: "", timedOut: false } } });
    expect(await b.svc.repair(PROJECT, "redis", 5000, "kelvin")).toMatchObject({ outcome: "fix_failed", restarted: false });
  });

  it("auditoria que falha não muda o resultado; saída enorme é cortada no começo", async () => {
    const r = rig({ auditFails: true, helper: { fix: { code: 0, output: `${"x".repeat(AOF_OUTPUT_MAX + 50)}\n${FIX_OUT}`, timedOut: false } } });
    const out = await r.svc.repair(PROJECT, "redis", 5000, "kelvin");
    expect(out.ok).toBe(true);
    expect(out.output.startsWith("…")).toBe(true);
    expect(out.output.length).toBeLessThanOrEqual(AOF_OUTPUT_MAX + 1);
    expect(out.output).toContain("Serviço ligado de novo");
  });

  it("erro não-Error no stop/start vira texto", async () => {
    const r = rig();
    r.docker.stop = vi.fn(async () => Promise.reject("socket"));
    expect((await failure(r.svc.repair(PROJECT, "redis", 5000, "kelvin"))).message).toContain("socket");
    const s = rig();
    s.docker.start = vi.fn(async () => Promise.reject("socket"));
    expect((await s.svc.repair(PROJECT, "redis", 5000, "kelvin")).output).toContain("NÃO voltou a subir: socket");
  });
});

describe("concorrência", () => {
  it("duplo clique: o segundo pedido no mesmo projeto recebe 409 na hora; outro projeto segue; a trava sai no fim", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const r = rig({
      containers: async () => {
        await gate;
        return [listed()];
      },
    });
    const first = r.svc.repair(PROJECT, "redis", 5000, "kelvin");
    expect(r.svc.isBusy("p1")).toBe(true);
    expect(await failure(r.svc.repair(PROJECT, "redis", 5000, "kelvin"))).toMatchObject({ statusCode: 409, code: "aof_repair_in_progress" });
    expect(await failure(r.svc.measure(PROJECT, "redis"))).toMatchObject({ statusCode: 409, code: "aof_repair_in_progress" });
    const other = r.svc.measure({ id: "p2", slug: "blog", name: "Blog" }, "redis").catch((e: { code: string }) => e.code);
    release();
    expect((await first).outcome).toBe("repaired");
    expect(await other).toBe("service_not_found");
    expect(r.svc.isBusy("p1")).toBe(false);
    expect(r.deps.hold).toHaveBeenCalledTimes(1);
  });

  it("projeto com deploy em andamento (a reserva recusa): 409 e nada feito; a trava sai", async () => {
    const r = rig();
    r.deps.hold = vi.fn(async () => {
      throw Object.assign(new Error("Já existe um deploy em andamento para este projeto."), { statusCode: 409, code: "deploy_in_progress" });
    });
    expect(await failure(r.svc.repair(PROJECT, "redis", 5000, "kelvin"))).toMatchObject({ statusCode: 409, code: "deploy_in_progress" });
    expect(r.calls).toEqual([]);
    expect(r.svc.isBusy("p1")).toBe(false);
  });
});

describe("parar/iniciar/remover em curso (a outra metade da trava)", () => {
  it("com uma ação do projeto rodando, medir e reparar recusam com 409 aof_project_busy e nada é feito", async () => {
    const r = rig();
    const end = r.svc.beginProjectAction("p1");
    expect(await failure(r.svc.measure(PROJECT, "redis"))).toMatchObject({ statusCode: 409, code: "aof_project_busy" });
    expect(await failure(r.svc.repair(PROJECT, "redis", 5000, "kelvin"))).toMatchObject({ statusCode: 409, code: "aof_project_busy" });
    expect(r.calls).toEqual([]);
    expect(r.deps.hold).not.toHaveBeenCalled();
    expect(r.svc.isBusy("p1")).toBe(false);
    // outro projeto não é afetado
    expect(await failure(r.svc.measure({ id: "p2", slug: "blog", name: "Blog" }, "redis"))).toMatchObject({ code: "service_not_found" });
    end();
    expect((await r.svc.measure(PROJECT, "redis")).bytes).toBe(1397);
  });

  it("duas ações ao mesmo tempo: só libera quando as duas acabam; desmarcar duas vezes não solta a outra", async () => {
    const r = rig();
    const a = r.svc.beginProjectAction("p1");
    const b = r.svc.beginProjectAction("p1");
    a();
    a();
    expect(await failure(r.svc.measure(PROJECT, "redis"))).toMatchObject({ code: "aof_project_busy" });
    b();
    expect((await r.svc.measure(PROJECT, "redis")).bytes).toBe(1397);
  });

  it("com reparo em andamento, a ação do projeto é que recusa (409 aof_repair_in_progress) e não marca nada", async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const r = rig({
      containers: async () => {
        await gate;
        return [listed()];
      },
    });
    const run = r.svc.repair(PROJECT, "redis", 5000, "kelvin");
    expect(() => r.svc.beginProjectAction("p1")).toThrow(expect.objectContaining({ statusCode: 409, code: "aof_repair_in_progress" }));
    release();
    expect((await run).outcome).toBe("repaired");
    // nada ficou marcado pela recusa
    expect((await r.svc.measure(PROJECT, "redis")).bytes).toBe(1397);
  });
});

describe("depois do reparo", () => {
  it("arquivo cortado: o diagnóstico do container sai na hora (também se o serviço não voltou); falha antes do corte não limpa", async () => {
    const ok = rig();
    await ok.svc.repair(PROJECT, "redis", 5000, "kelvin");
    expect(ok.deps.forgetDiagnosis).toHaveBeenCalledWith(ID);
    const notStarted = rig({ startFails: true });
    await notStarted.svc.repair(PROJECT, "redis", 5000, "kelvin");
    expect(notStarted.deps.forgetDiagnosis).toHaveBeenCalledWith(ID);
    const fixFailed = rig({ helper: { fix: { code: 1, output: "", timedOut: false } } });
    await fixFailed.svc.repair(PROJECT, "redis", 5000, "kelvin");
    expect(fixFailed.deps.forgetDiagnosis).not.toHaveBeenCalled();
    const backupFailed = rig({ helper: { backup: { code: 96, output: "", timedOut: false } } });
    await backupFailed.svc.repair(PROJECT, "redis", 5000, "kelvin");
    expect(backupFailed.deps.forgetDiagnosis).not.toHaveBeenCalled();
  });

  it("limpar o diagnóstico que falha (ou que não existe) não muda o resultado", async () => {
    const r = rig();
    r.deps.forgetDiagnosis = vi.fn(() => {
      throw new Error("quebrou");
    });
    expect((await r.svc.repair(PROJECT, "redis", 5000, "kelvin")).outcome).toBe("repaired");
    const s2 = rig();
    delete s2.deps.forgetDiagnosis;
    expect((await s2.svc.repair(PROJECT, "redis", 5000, "kelvin")).outcome).toBe("repaired");
  });
});

describe("valkey: os textos dizem valkey", () => {
  it("auditoria do reparo, das falhas e os erros da pasta e do arquivo íntegro", async () => {
    const ok = rig({ lines: [VALKEY_TRUNCATED] });
    await ok.svc.repair(PROJECT, "redis", 5000, "kelvin");
    expect(ok.audits[0]!.detail).toMatch(/^Arquivo do valkey reparado/);
    expect(ok.audits[0]!.detail).not.toContain("do redis");
    const backup = rig({ lines: [VALKEY_TRUNCATED], helper: { backup: { code: 96, output: "", timedOut: false } } });
    await backup.svc.repair(PROJECT, "redis", 5000, "kelvin");
    expect(backup.audits[0]!.detail).toContain("Reparo do arquivo do valkey: a cópia");
    const fix = rig({ lines: [VALKEY_TRUNCATED], helper: { fix: { code: 1, output: "", timedOut: false } } });
    await fix.svc.repair(PROJECT, "redis", 5000, "kelvin");
    expect(fix.audits[0]!.detail).toContain("Reparo do arquivo do valkey: a ferramenta");
    const stop = rig({ lines: [VALKEY_TRUNCATED], stopFails: true });
    await failure(stop.svc.repair(PROJECT, "redis", 5000, "kelvin"));
    expect(stop.audits[0]!.detail).toContain("Reparo do arquivo do valkey não começou");
    const vol = rig({ lines: [VALKEY_TRUNCATED], inspect: inspected({ mounts: [] }) });
    expect((await failure(vol.svc.measure(PROJECT, "redis"))).message).toContain("pasta de dados do valkey");
    const valid = rig({ lines: [VALKEY_TRUNCATED], helper: { measure: { code: 0, output: analyzed(0), timedOut: false } } });
    expect((await failure(valid.svc.measure(PROJECT, "redis"))).message).toContain("arquivo do valkey está íntegro");
    expect((await failure(valid.svc.repair(PROJECT, "redis", 5000, "kelvin"))).message).toContain("arquivo do valkey está íntegro");
  });

  it("redis continua dizendo redis", async () => {
    const r = rig();
    await r.svc.repair(PROJECT, "redis", 5000, "kelvin");
    expect(r.audits[0]!.detail).toMatch(/^Arquivo do redis reparado/);
  });
});
