/**
 * database-settings.ts — Configurações → Banco de dados (data/database-settings.json): quanto dura a liberação da
 * edição do banco e se cada comando a renova. Arquivo ausente, ilegível ou com valor estranho = padrão (30 min,
 * renovando com o uso). A leitura fica em memória (`current()` é síncrono: cada comando de escrita consulta);
 * `set()` grava no disco e só então muda a memória.
 */
import path from "node:path";
import { DATABASE_SETTINGS_DEFAULT, isDatabaseUnlockDuration, type DatabaseSettings } from "@paas/core";
import { JsonFile } from "./json-file.js";

function parseSettings(raw: unknown): DatabaseSettings | null {
  const r = raw as { unlockDuration?: unknown; renewOnUse?: unknown } | null;
  if (!r || !isDatabaseUnlockDuration(r.unlockDuration) || typeof r.renewOnUse !== "boolean") return null;
  return { unlockDuration: r.unlockDuration, renewOnUse: r.renewOnUse };
}

export class DatabaseSettingsStore {
  private readonly file: JsonFile<DatabaseSettings>;
  private cached: DatabaseSettings = { ...DATABASE_SETTINGS_DEFAULT };

  constructor(dataDir: string) {
    this.file = new JsonFile<DatabaseSettings>(path.join(dataDir, "database-settings.json"), {
      empty: () => ({ ...DATABASE_SETTINGS_DEFAULT }),
      parse: parseSettings,
      serialize: (value) => JSON.stringify(value, null, 2) + "\n",
    });
  }

  /** Lê do disco para a memória. Erro de disco mantém o último valor conhecido (o padrão, na primeira vez). */
  async load(): Promise<DatabaseSettings> {
    try {
      this.cached = await this.file.read();
    } catch {
      // disco ilegível: segue com o último valor conhecido
    }
    return this.current();
  }

  current(): DatabaseSettings {
    return { ...this.cached };
  }

  /** Grava (já validado por quem chama). Falha de disco lança e a memória NÃO muda. */
  async set(value: DatabaseSettings): Promise<DatabaseSettings> {
    const next: DatabaseSettings = { unlockDuration: value.unlockDuration, renewOnUse: value.renewOnUse };
    await this.file.update(() => next);
    this.cached = next;
    return this.current();
  }
}
