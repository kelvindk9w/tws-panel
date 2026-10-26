/**
 * mcp-settings.ts — liga/desliga do MCP (data/mcp-settings.json). DESLIGADO por padrão: arquivo ausente,
 * ilegível ou com formato estranho = desligado. A leitura fica em memória (`enabled()` é síncrono: o plugin de
 * autenticação consulta em toda requisição ao /mcp); `set()` grava no disco e só então muda a memória.
 */
import path from "node:path";
import { JsonFile } from "./json-file.js";

export class McpSettings {
  private readonly file: JsonFile<{ enabled: boolean }>;
  private cached = false;

  constructor(dataDir: string) {
    this.file = new JsonFile<{ enabled: boolean }>(path.join(dataDir, "mcp-settings.json"), {
      empty: () => ({ enabled: false }),
      parse: (raw) => {
        const enabled = (raw as { enabled?: unknown } | null)?.enabled;
        return typeof enabled === "boolean" ? { enabled } : null;
      },
      serialize: (value) => JSON.stringify(value, null, 2) + "\n",
    });
  }

  /** Lê do disco para a memória. Erro de disco mantém o último valor conhecido (desligado, na primeira vez). */
  async load(): Promise<boolean> {
    try {
      this.cached = (await this.file.read()).enabled;
    } catch {
      // disco ilegível: segue com o último valor conhecido
    }
    return this.cached;
  }

  enabled(): boolean {
    return this.cached;
  }

  /** Grava e muda. Falha de disco lança e a memória NÃO muda (nada fica ligado sem estar gravado). */
  async set(enabled: boolean): Promise<boolean> {
    await this.file.update(() => ({ enabled }));
    this.cached = enabled;
    return enabled;
  }
}
