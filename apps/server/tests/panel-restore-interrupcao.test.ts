/**
 * panel-restore-interrupcao.test.ts — a troca do estado do painel na subida
 * é retomável e reversível (achado 2 da revisão).
 *
 * Antes da correção, uma subida que encontrava a troca pela metade apagava a
 * cópia de segurança (antes-da-restauracao) e levava para lá os arquivos do
 * backup já aplicados, que não estavam mais na pasta extraída: sumiam o
 * users.json ativo e a chave original. E uma falha no meio da troca só ia
 * para o log: o painel subia com metade dos arquivos trocada.
 *
 * Tudo com arquivos de verdade numa pasta temporária. A "queda" do processo
 * é simulada parando a função para sempre num ponto (uma promessa que nunca
 * resolve: nada depois daquele ponto roda, como num kill -9) e chamando a
 * função de novo, como faria a subida seguinte.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PANEL_RESTORE_PROGRESS,
  applyPendingPanelRestore,
  restorePanelAtBoot,
  type PanelRestoreOptions,
} from "../src/services/panel-restore.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-panel-restore-int-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function put(rel: string, content: string): Promise<void> {
  await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
  await writeFile(path.join(dir, rel), content);
}

const ORIGINAL: Record<string, string> = {
  "users.json": "atual",
  "secret.key": "original",
  "mail/config.json": "atual",
  "audit.json": JSON.stringify({ entries: [] }),
};
const DO_BACKUP: Record<string, string> = {
  "users.json": "do-backup",
  "secrets.json": "do-backup",
  "mail/config.json": "do-backup",
  "backups-history.json": JSON.stringify({ entries: [] }),
};
const MARKER = { requestedAt: "2026-10-14T12:00:00.000Z", fileName: "2026-10-14_03-00.7z", actor: "admin" };
const SAFETY = "backups/_painel/antes-da-restauracao";
const STAGED = "backups/.restaurar-painel";

async function cenario(): Promise<void> {
  for (const [rel, c] of Object.entries(ORIGINAL)) await put(rel, c);
  await put("setup-token", "token-desta-vps");
  await put("backups/loja/2026-10-14_03-00.7z", "copia");
  for (const [rel, c] of Object.entries(DO_BACKUP)) await put(`${STAGED}/${rel}`, c);
  await put(`${STAGED}/LEIA-ME.txt`, "leia");
  await put(`${STAGED}/manifesto.json`, "{}");
  await put("backups/.restaurar-painel.json", JSON.stringify(MARKER));
}

async function ler(rel: string): Promise<string | null> {
  try {
    return await readFile(path.join(dir, rel), "utf8");
  } catch {
    return null;
  }
}

/** Arquivos (com conteúdo) de uma pasta, recursivo; pasta ausente = vazio. */
async function arvore(rel: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const base = path.join(dir, rel);
  if (!existsSync(base)) return out;
  const walk = async (sub: string) => {
    for (const name of await readdir(path.join(base, sub))) {
      const r = sub ? `${sub}/${name}` : name;
      if ((await stat(path.join(base, r))).isDirectory()) await walk(r);
      else out[r] = await readFile(path.join(base, r), "utf8");
    }
  };
  await walk("");
  return out;
}

/** Estado ativo (sem as pastas que a restauração não troca). */
async function ativo(): Promise<Record<string, string>> {
  const all = await arvore("");
  return Object.fromEntries(Object.entries(all).filter(([k]) => !k.startsWith("backups/") && k !== "setup-token" && k !== "backups-history.json"));
}

async function conferirAplicado(): Promise<void> {
  const a = await ativo();
  expect(a).toEqual({ "users.json": "do-backup", "secrets.json": "do-backup", "mail/config.json": "do-backup" });
  expect(await arvore(SAFETY)).toEqual(ORIGINAL);
  expect(await ler("setup-token")).toBe("token-desta-vps");
  expect(await ler("backups/loja/2026-10-14_03-00.7z")).toBe("copia");
  expect(existsSync(path.join(dir, STAGED))).toBe(false);
  expect(existsSync(path.join(dir, "backups/.restaurar-painel.json"))).toBe(false);
  expect(existsSync(path.join(dir, "backups", PANEL_RESTORE_PROGRESS))).toBe(false);
  const h = JSON.parse((await ler("backups-history.json"))!) as { entries: Array<{ operation: string; status: string }> };
  expect(h.entries.filter((e) => e.operation === "restore")).toHaveLength(1);
  expect(h.entries.at(-1)).toMatchObject({ operation: "restore", status: "success" });
}

async function conferirDesfeito(): Promise<void> {
  expect(await ativo()).toEqual(ORIGINAL);
  expect(existsSync(path.join(dir, STAGED))).toBe(false);
  expect(existsSync(path.join(dir, "backups/.restaurar-painel.json"))).toBe(false);
  expect(existsSync(path.join(dir, "backups", PANEL_RESTORE_PROGRESS))).toBe(false);
  const h = JSON.parse((await ler("backups-history.json"))!) as { entries: Array<{ operation: string; status: string; error: string | null }> };
  expect(h.entries.at(-1)).toMatchObject({ operation: "restore", status: "failed" });
  expect(h.entries.at(-1)!.error).toMatch(/voltou ao estado de antes/);
}

/** Nenhum arquivo original e nenhum do backup some em ponto nenhum. */
async function conferirNadaPerdido(): Promise<void> {
  const a = await arvore("");
  const s = await arvore(SAFETY);
  const st = await arvore(STAGED);
  for (const [rel, c] of Object.entries(ORIGINAL)) expect(a[rel] === c || s[rel] === c, `original ${rel}`).toBe(true);
  for (const [rel, c] of Object.entries(DO_BACKUP)) {
    // o histórico do backup ganha o registro da própria restauração no fim
    const igual = (v: string | undefined) => (rel === "backups-history.json" ? v !== undefined : v === c);
    expect(igual(a[rel]) || igual(st[rel]), `do backup ${rel}`).toBe(true);
  }
}

async function passos(): Promise<string[]> {
  await cenario();
  const vistos: string[] = [];
  await applyPendingPanelRestore(dir, { onStep: (s) => void vistos.push(s) });
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir);
  return vistos;
}

/** Roda até `alvo` e "morre" ali: a promessa nunca termina. */
async function cairEm(alvo: string, extra: PanelRestoreOptions["onStep"] = undefined): Promise<void> {
  let chegou!: () => void;
  const chegada = new Promise<void>((r) => (chegou = r));
  void applyPendingPanelRestore(dir, {
    onStep: async (s) => {
      await extra?.(s);
      if (s === alvo) {
        chegou();
        await new Promise(() => undefined);
      }
    },
  });
  await chegada;
}

describe("restauração do painel interrompida", () => {
  it("estado deixado por uma versão antiga interrompida no meio: nada é apagado", async () => {
    // Exatamente o que a reavaliação reproduziu: originais já na cópia de
    // segurança, users.json do backup já ativo, secrets.json ainda extraído.
    await put(`${SAFETY}/users.json`, "atual");
    await put(`${SAFETY}/secret.key`, "original");
    await put("users.json", "do-backup");
    await put(`${STAGED}/secrets.json`, "do-backup");
    await put("backups/.restaurar-painel.json", JSON.stringify(MARKER));
    await applyPendingPanelRestore(dir);
    const tudo = Object.entries(await arvore("backups/_painel")).map(([k, v]) => `${path.basename(k)}=${v}`);
    expect(tudo).toEqual(expect.arrayContaining(["users.json=atual", "secret.key=original"]));
    const ativoOuSeguranca = { ...(await arvore("backups/_painel")), ...(await ativo()) };
    expect(Object.values(ativoOuSeguranca)).toContain("do-backup");
  });

  it("queda em cada etapa: a subida seguinte termina a troca sem perder nada", async () => {
    const todos = await passos();
    expect(todos.length).toBeGreaterThan(8);
    for (const alvo of todos) {
      await cenario();
      await cairEm(alvo);
      await conferirNadaPerdido();
      const r = await applyPendingPanelRestore(dir);
      expect(r?.outcome, alvo).toBe("applied");
      await conferirAplicado();
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir);
    }
  });

  it("duas quedas seguidas na mesma etapa e retomada: continua certo", async () => {
    const todos = (await passos()).filter((s) => s.startsWith("aplicando:"));
    await cenario();
    await cairEm(todos[1]!);
    await cairEm(todos[1]!); // a retomada também cai, no mesmo ponto
    await conferirNadaPerdido();
    expect((await applyPendingPanelRestore(dir))?.outcome).toBe("applied");
    await conferirAplicado();
  });

  it("falha (erro) em qualquer etapa da troca: desfaz e o painel volta ao estado de antes", async () => {
    const troca = (await passos()).filter((s) => /^(preparar|salvando:|fase:aplicando|aplicando:)/.test(s));
    expect(troca.length).toBeGreaterThan(4);
    for (const alvo of troca) {
      await cenario();
      const r = await applyPendingPanelRestore(dir, {
        onStep: (s) => {
          if (s === alvo) throw new Error("disco sem espaço (simulado)");
        },
      });
      expect(r?.outcome, alvo).toBe("undone");
      expect(r?.error).toMatch(/disco sem espaço/);
      await conferirDesfeito();
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir);
    }
  });

  it("queda no meio do desfazer: a subida seguinte termina de desfazer", async () => {
    const aplicar = (await passos()).filter((s) => s.startsWith("aplicando:"));
    await cenario();
    let desfazendo: string[] = [];
    // descobre os passos do desfazer
    await applyPendingPanelRestore(dir, {
      onStep: (s) => {
        if (s === aplicar[1]) throw new Error("falha simulada");
        if (s.startsWith("desfazendo")) desfazendo.push(s);
      },
    });
    expect(desfazendo.length).toBeGreaterThan(2);
    const passosDesfazer = desfazendo;
    for (const alvo of passosDesfazer) {
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir);
      await cenario();
      desfazendo = [];
      await cairEm(alvo, (s) => {
        if (s === aplicar[1]) throw new Error("falha simulada");
      });
      const r = await applyPendingPanelRestore(dir);
      expect(r?.outcome, alvo).toBe("undone");
      await conferirDesfeito();
    }
  });

  it("falha também ao desfazer: lança (o painel não sobe) e a próxima subida termina de desfazer", async () => {
    await cenario();
    await expect(
      applyPendingPanelRestore(dir, {
        onStep: (s) => {
          if (s.startsWith("aplicando:")) throw new Error("falha na troca");
          if (s.startsWith("desfazendo-devolvendo:")) throw new Error("falha ao desfazer");
        },
      }),
    ).rejects.toThrow(/falha ao desfazer/);
    expect(existsSync(path.join(dir, "backups", PANEL_RESTORE_PROGRESS))).toBe(true);
    await conferirNadaPerdido();
    expect((await applyPendingPanelRestore(dir))?.outcome).toBe("undone");
    await conferirDesfeito();
  });

  it("cópia de segurança de uma restauração anterior não é apagada: vira antes-da-restauracao.anterior", async () => {
    await cenario();
    await put(`${SAFETY}/users.json`, "de-uma-restauracao-antiga");
    expect((await applyPendingPanelRestore(dir))?.outcome).toBe("applied");
    expect(await ler("backups/_painel/antes-da-restauracao.anterior/users.json")).toBe("de-uma-restauracao-antiga");
    expect(await ler(`${SAFETY}/users.json`)).toBe("atual");
  });

  it("cópia de segurança vazia (de uma restauração desfeita) não empurra a anterior para fora", async () => {
    await cenario();
    await mkdir(path.join(dir, SAFETY), { recursive: true });
    await put("backups/_painel/antes-da-restauracao.anterior/users.json", "guardado");
    expect((await applyPendingPanelRestore(dir))?.outcome).toBe("applied");
    expect(await ler("backups/_painel/antes-da-restauracao.anterior/users.json")).toBe("guardado");
  });

  it("arquivo de progresso ilegível ou que não dá para ler: não adivinha, lança", async () => {
    await cenario();
    await put(`backups/${PANEL_RESTORE_PROGRESS}`, "{ estragado");
    await expect(applyPendingPanelRestore(dir)).rejects.toThrow(/ilegível/);
    await put(`backups/${PANEL_RESTORE_PROGRESS}`, JSON.stringify({ phase: "outra", marker: MARKER, startedAt: "x" }));
    await expect(applyPendingPanelRestore(dir)).rejects.toThrow(/ilegível/);
    await rm(path.join(dir, "backups", PANEL_RESTORE_PROGRESS));
    await mkdir(path.join(dir, "backups", PANEL_RESTORE_PROGRESS));
    await expect(applyPendingPanelRestore(dir)).rejects.toThrow();
    // nada foi mexido
    expect(await ativo()).toEqual(ORIGINAL);
  });

  it("progresso gravado sem o motivo do erro (fase de desfazer): desfaz com motivo genérico", async () => {
    await cenario();
    await mkdir(path.join(dir, SAFETY), { recursive: true });
    await put(`backups/${PANEL_RESTORE_PROGRESS}`, JSON.stringify({ phase: "desfazendo-devolvendo", marker: MARKER, startedAt: "x" }));
    const r = await applyPendingPanelRestore(dir);
    expect(r).toMatchObject({ outcome: "undone", error: "motivo não registrado" });
  });

  it("histórico já com o registro desta restauração (queda depois de gravá-lo): não duplica", async () => {
    const todos = await passos();
    const depoisDoHistorico = todos[todos.indexOf("concluindo:historico") + 1]!;
    await cenario();
    await cairEm(depoisDoHistorico);
    await applyPendingPanelRestore(dir);
    await conferirAplicado();
  });
});

describe("restorePanelAtBoot (index.ts)", () => {
  function logs() {
    const linhas: string[] = [];
    return { linhas, log: { warn: (m: string) => void linhas.push(`warn ${m}`), error: (m: string) => void linhas.push(`error ${m}`) } };
  }

  it("sem restauração pendente: segue a subida sem log", async () => {
    const l = logs();
    expect(await restorePanelAtBoot(dir, l.log)).toBe(true);
    expect(l.linhas).toEqual([]);
  });

  it("aplicada: avisa no log e registra na auditoria (a do backup)", async () => {
    await cenario();
    const l = logs();
    expect(await restorePanelAtBoot(dir, l.log)).toBe(true);
    expect(l.linhas.join("\n")).toMatch(/Painel restaurado do backup 2026-10-14_03-00\.7z/);
    const audit = JSON.parse((await ler("audit.json"))!) as { entries: Array<{ action: string; actor: string }> };
    expect(audit.entries.at(-1)).toMatchObject({ action: "backups.panel_restored", actor: "admin" });
  });

  it("desfeita: erro claro no log e na auditoria, e a subida segue com o estado de antes", async () => {
    await cenario();
    const l = logs();
    const ok = await restorePanelAtBoot(dir, l.log, {
      onStep: (s) => {
        if (s.startsWith("aplicando:")) throw new Error("falha simulada");
      },
    });
    expect(ok).toBe(true);
    expect(l.linhas.join("\n")).toMatch(/error .*desfeita.*falha simulada/);
    const audit = JSON.parse((await ler("audit.json"))!) as { entries: Array<{ action: string; detail: string }> };
    expect(audit.entries.at(-1)).toMatchObject({ action: "backups.panel_restore_undone" });
    expect(await ativo()).toEqual({ ...ORIGINAL, "audit.json": expect.any(String) });
  });

  describe("reconciliação do que o painel antigo tinha ativo (restaurar-painel.sh)", () => {
    const comActor = (actor: string) => put("backups/.restaurar-painel.json", JSON.stringify({ ...MARKER, actor }));

    it("restauração por SSH (script): chama a conferência com o estado já restaurado, sem bloquear a subida", async () => {
      await cenario();
      await comActor("ssh");
      const chamadas: string[] = [];
      const l = logs();
      const ok = await restorePanelAtBoot(dir, l.log, {
        afterApplied: async (dataDir) => void chamadas.push(`${dataDir}:${(await ler("users.json")) ?? ""}`),
      });
      expect(ok).toBe(true);
      // chamada DEPOIS da troca: já enxerga o users.json do backup
      expect(chamadas).toEqual([`${dir}:do-backup`]);
    });

    it("com arquivos reais: backup com webmail ativo e nenhum container aqui — a pendência fica gravada e a flag passa a dizer a verdade", async () => {
      await cenario();
      await comActor("ssh");
      await put(`${STAGED}/mail/webmail.json`, JSON.stringify({ enabled: true, desKey: "k".repeat(24) }));
      const { RestoreReconciliation } = await import("../src/services/restore-reconciliation.js");
      await restorePanelAtBoot(dir, logs().log, {
        afterApplied: async (dataDir) => {
          await new RestoreReconciliation({
            dataDir,
            containers: { stalwart: "paas-stalwart", webmail: "paas-webmail" },
            probes: { container: async () => "missing" },
          }).planStaged(dataDir);
        },
      });
      expect(JSON.parse((await ler("mail/webmail.json"))!)).toMatchObject({ enabled: false });
      expect(JSON.parse((await ler("restore-reconciliation.json"))!).items).toMatchObject([{ id: "webmail", state: "open" }]);
    });

    it("restauração pela tela: o painel já conferiu antes do reinício, então não confere de novo", async () => {
      await cenario();
      const chamadas: string[] = [];
      await restorePanelAtBoot(dir, logs().log, { afterApplied: async () => void chamadas.push("x") });
      expect(chamadas).toEqual([]);
    });

    it("restauração desfeita: nada a conferir", async () => {
      await cenario();
      await comActor("ssh");
      const chamadas: string[] = [];
      await restorePanelAtBoot(dir, logs().log, {
        onStep: (s) => {
          if (s.startsWith("aplicando:")) throw new Error("falha simulada");
        },
        afterApplied: async () => void chamadas.push("x"),
      });
      expect(chamadas).toEqual([]);
    });

    it("a conferência quebrar não impede a subida (só vai para o log)", async () => {
      await cenario();
      await comActor("ssh");
      const l = logs();
      const ok = await restorePanelAtBoot(dir, l.log, { afterApplied: async () => Promise.reject(new Error("docker fora do ar")) });
      expect(ok).toBe(true);
      expect(l.linhas.join("\n")).toMatch(/warn .*conferir o que o painel antigo tinha ativo.*docker fora do ar/);
    });
  });

  it("nem trocar nem desfazer: devolve false (o painel não sobe) e diz o que fazer", async () => {
    await cenario();
    const l = logs();
    const ok = await restorePanelAtBoot(dir, l.log, {
      onStep: (s) => {
        if (s.startsWith("aplicando:") || s.startsWith("desfazendo")) throw new Error("disco somente leitura");
      },
    });
    expect(ok).toBe(false);
    expect(l.linhas.join("\n")).toMatch(/não vai subir/);
  });
});
