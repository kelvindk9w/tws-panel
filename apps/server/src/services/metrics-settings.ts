/**
 * metrics-settings.ts — retenção escolhida em Configurações (data/metrics-settings.json).
 * Arquivo ausente, ilegível ou fora dos limites = padrão (48 h / 90 dias / 2 anos);
 * nunca derruba o coletor. A leitura é guardada em memória: `current()` é síncrono
 * (o coletor e a poda consultam a cada minuto) e `set()` atualiza memória e disco.
 */
import path from "node:path";
import { METRICS_RETENTION_DEFAULT, validateMetricsRetention, type MetricsRetention } from "@paas/core";
import { JsonFile } from "./json-file.js";

export class MetricsSettings {
  private readonly file: JsonFile<MetricsRetention>;
  private cached: MetricsRetention = { ...METRICS_RETENTION_DEFAULT };

  constructor(dataDir: string) {
    this.file = new JsonFile<MetricsRetention>(path.join(dataDir, "metrics-settings.json"), {
      empty: () => ({ ...METRICS_RETENTION_DEFAULT }),
      parse: (raw) => {
        const r = validateMetricsRetention((raw as { retention?: unknown } | null)?.retention);
        return r.ok ? r.value : null;
      },
      serialize: (value) => JSON.stringify({ retention: value }, null, 2) + "\n",
    });
  }

  /** Lê do disco para a memória. Erro de disco mantém o que já havia (padrão, na primeira vez). */
  async load(): Promise<MetricsRetention> {
    try {
      this.cached = await this.file.read();
    } catch {
      // disco ilegível: segue com o último valor conhecido
    }
    return this.current();
  }

  current(): MetricsRetention {
    return { ...this.cached };
  }

  /** Grava a retenção (já validada por quem chama). Falha de disco lança e a memória não muda. */
  async set(value: MetricsRetention): Promise<MetricsRetention> {
    const next = { minuteHours: value.minuteHours, hourDays: value.hourDays, dayDays: value.dayDays };
    await this.file.update(() => next);
    this.cached = next;
    return this.current();
  }
}
