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
