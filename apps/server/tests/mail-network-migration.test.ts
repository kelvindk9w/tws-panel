/**
 * Migração das redes do e-mail (A4): a ordem evita deixar projeto, webmail ou
 * painel sem o Stalwart no meio do caminho.
 */
import { describe, expect, it } from "vitest";
import { migrateMailNetworks } from "../src/services/mail-network-migration.js";

function deps(overrides: Partial<{ joinProject: (id: string, log: (m: string) => void) => Promise<number>; syncWebmail: () => Promise<void>; join: () => Promise<void> }> = {}) {
  const events: string[] = [];
  const logs: string[] = [];
  return {
    events,
    logs,
    value: {
      mail: {
        joinMailNetworks: overrides.join ?? (async () => void events.push("stalwart entra nas redes novas")),
        emailProjectIds: async () => ["p1", "p2"],
        leaveProjectNetwork: async () => void events.push("stalwart sai da paas-net"),
      },
      joinProject: overrides.joinProject ?? (async (id: string, log: (m: string) => void) => (log("log do deploy"), events.push(`projeto ${id} entra na paas-mail`), 1)),
      syncWebmail: overrides.syncWebmail ?? (async () => void events.push("webmail muda de rede")),
      log: (m: string) => void logs.push(m),
    },
  };
}

describe("migrateMailNetworks", () => {
  it("ordem: Stalwart entra → projetos entram → webmail muda → Stalwart sai", async () => {
    const d = deps();
    await migrateMailNetworks(d.value);
    expect(d.events).toEqual([
      "stalwart entra nas redes novas",
      "projeto p1 entra na paas-mail",
      "projeto p2 entra na paas-mail",
      "webmail muda de rede",
      "stalwart sai da paas-net",
    ]);
    // o logger da migração chega ao join (avisos e desligamentos não se perdem)
    expect(d.logs).toEqual(["log do deploy", "log do deploy"]);
  });

  it("projeto que não deu para ligar e webmail que falhou: avisa e segue até o fim", async () => {
    const d = deps({
      joinProject: async (id) => {
        if (id === "p1") throw new Error("container sumiu");
        return 1;
      },
      syncWebmail: async () => {
        throw new Error("docker ocupado");
      },
    });
    await migrateMailNetworks(d.value);
    expect(d.logs.join("\n")).toContain("projeto p1");
    expect(d.logs.join("\n")).toContain("container sumiu");
    expect(d.logs.join("\n")).toContain("webmail não mudou de rede agora (docker ocupado)");
    expect(d.events.at(-1)).toBe("stalwart sai da paas-net");
  });

  it("se o Stalwart não entrou nas redes novas, NADA é tirado de lugar (a exceção sobe)", async () => {
    const d = deps({
      join: async () => {
        throw new Error("sem endereços livres");
      },
    });
    await expect(migrateMailNetworks(d.value)).rejects.toThrow(/sem endereços livres/);
    expect(d.events).toEqual([]);
  });

  it("erro não-Error também vira texto no aviso", async () => {
    const d = deps({
      joinProject: async () => {
        throw "texto solto";
      },
    });
    await migrateMailNetworks(d.value);
    expect(d.logs[0]).toContain("texto solto");
  });
});

describe("migrateMailNetworks — rede de e-mail por projeto", () => {
  /** Simula o Docker: quem está em cada rede. */
  function mundo(opts: { failJoin?: string[]; failSweep?: boolean; stalwartErrors?: string[] } = {}) {
    const redes: Record<string, Set<string>> = {
      "paas-mail": new Set(["paas-stalwart", "paas-webmail", "a-web", "a-php", "b-web", "orfao"]),
      "paas-net": new Set(["paas-stalwart", "a-web", "b-web"]),
    };
    const containers: Record<string, string[]> = { "projeto-a": ["a-web", "a-php"], "projeto-b": ["b-web"] };
    const logs: string[] = [];
    const on = (rede: string) => (redes[rede] ??= new Set());
    const value = {
      mail: {
        joinMailNetworks: async () => {
          for (const r of ["paas-mail-admin", "paas-mail", "paas-mailweb", ...Object.keys(redes).filter((n) => n.startsWith("paas-mail-"))]) on(r).add("paas-stalwart");
          return opts.stalwartErrors ?? [];
        },
        emailProjectIds: async () => ["projeto-a", "projeto-b"],
        leaveProjectNetwork: async () => void on("paas-net").delete("paas-stalwart"),
      },
      joinProject: async (id: string) => {
        if (opts.failJoin?.includes(id)) throw new Error("daemon ocupado");
        const rede = `paas-mail-${id}`;
        on(rede).add("paas-stalwart");
        for (const c of containers[id]!) on(rede).add(c);
        for (const c of containers[id]!) on("paas-mail").delete(c);
        return containers[id]!.length;
      },
      syncWebmail: async () => {
        on("paas-mailweb").add("paas-webmail");
        if (on("paas-mailweb").has("paas-stalwart")) on("paas-mail").delete("paas-webmail");
      },
      sweepShared: async (skip: string[]) => {
        if (opts.failSweep) throw new Error("daemon fora");
        const keep = new Set(["paas-stalwart", "paas-webmail", ...skip.flatMap((id) => containers[id]!)]);
        let n = 0;
        for (const c of [...on("paas-mail")]) if (!keep.has(c)) (on("paas-mail").delete(c), n++);
        return n;
      },
      log: (m: string) => void logs.push(m),
    };
    return { redes, value, logs };
  }

  it("estado antigo → novo: cada projeto na rede dele (com o Stalwart), webmail na dele, paas-mail só com o Stalwart", async () => {
    const w = mundo();
    await expect(migrateMailNetworks(w.value)).resolves.toEqual({ failed: [], incomplete: false });
    expect([...w.redes["paas-mail"]!]).toEqual(["paas-stalwart"]);
    expect([...w.redes["paas-mail-projeto-a"]!].sort()).toEqual(["a-php", "a-web", "paas-stalwart"]);
    expect([...w.redes["paas-mail-projeto-b"]!].sort()).toEqual(["b-web", "paas-stalwart"]);
    expect([...w.redes["paas-mailweb"]!].sort()).toEqual(["paas-stalwart", "paas-webmail"]);
    // nenhum container de um projeto na rede do outro
    expect(w.redes["paas-mail-projeto-a"]!.has("b-web")).toBe(false);
    expect(w.redes["paas-mail-projeto-b"]!.has("a-web")).toBe(false);
    expect(w.redes["paas-net"]!.has("paas-stalwart")).toBe(false);
  });

  it("idempotente: rodar de novo não muda nada", async () => {
    const w = mundo();
    await migrateMailNetworks(w.value);
    const antes = JSON.stringify(Object.fromEntries(Object.entries(w.redes).map(([k, v]) => [k, [...v].sort()])));
    await expect(migrateMailNetworks(w.value)).resolves.toEqual({ failed: [], incomplete: false });
    expect(JSON.stringify(Object.fromEntries(Object.entries(w.redes).map(([k, v]) => [k, [...v].sort()])))).toBe(antes);
  });

  it("falha no meio (um projeto não passou): ele fica na paas-mail com o SMTP de sempre; os outros seguem; a próxima rodada conclui", async () => {
    const w = mundo({ failJoin: ["projeto-a"] });
    const r = await migrateMailNetworks(w.value);
    expect(r).toEqual({ failed: ["projeto-a"], incomplete: false });
    expect([...w.redes["paas-mail"]!].sort()).toEqual(["a-php", "a-web", "paas-stalwart"]);
    expect(w.logs.join("\n")).toMatch(/não consegui passar o projeto projeto-a para a rede de e-mail dele \(daemon ocupado\); ele segue como está/);

    const ok = mundo();
    ok.redes["paas-mail"] = w.redes["paas-mail"]!;
    await expect(migrateMailNetworks(ok.value)).resolves.toEqual({ failed: [], incomplete: false });
    expect([...ok.redes["paas-mail"]!]).toEqual(["paas-stalwart"]);
  });

  it("Stalwart fora de alguma rede de projeto ou limpeza da paas-mail que falhou: registra e marca para refazer", async () => {
    const a = mundo({ stalwartErrors: ["rede paas-mail-projeto-c sumiu"] });
    await expect(migrateMailNetworks(a.value)).resolves.toEqual({ failed: [], incomplete: true });
    expect(a.logs.join("\n")).toMatch(/não entrou numa rede de projeto agora \(rede paas-mail-projeto-c sumiu\)/);

    const b = mundo({ failSweep: true });
    await expect(migrateMailNetworks(b.value)).resolves.toEqual({ failed: [], incomplete: true });
    expect(b.logs.join("\n")).toMatch(/não consegui esvaziar a rede de e-mail antiga agora \(daemon fora\)/);
  });

  it("webmail que falhou também marca para refazer", async () => {
    const w = mundo();
    w.value.syncWebmail = async () => {
      throw new Error("docker ocupado");
    };
    await expect(migrateMailNetworks(w.value)).resolves.toEqual({ failed: [], incomplete: true });
    // o webmail continua na paas-mail (a limpeza nunca o tira)
    expect(w.redes["paas-mail"]!.has("paas-webmail")).toBe(true);
  });

  it("a limpeza da paas-mail roda por último, depois de o Stalwart sair da paas-net", async () => {
    const order: string[] = [];
    const w = mundo();
    const leave = w.value.mail.leaveProjectNetwork;
    w.value.mail.leaveProjectNetwork = async () => (order.push("leave"), leave());
    const sweep = w.value.sweepShared;
    w.value.sweepShared = async (skip: string[]) => (order.push("sweep"), sweep(skip));
    await migrateMailNetworks(w.value);
    expect(order).toEqual(["leave", "sweep"]);
  });
});
