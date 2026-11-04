/**
 * phase01-user.ts — o ÚNICO usuário que a fase 01 do hardening pode criar com chave SSH quando há sessão aberta e
 * a instalação não tem usuário de administração configurado (PAAS_TERMINAL_USER). Depois do primeiro, ele vira o
 * "administrador" para a regra: outros nomes são recusados até a instalação ser refeita com PAAS_TERMINAL_USER.
 * Guardado em arquivo (sobrevive a reinício); sem pasta de dados, só em memória.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isValidSshUsername } from "@paas/core";

export class Phase01UserStore {
  private cached: string | null | undefined;

  constructor(private readonly dataDir: string | undefined) {}

  private get file(): string | null {
    return this.dataDir ? path.join(this.dataDir, "phase01-user") : null;
  }

  async get(): Promise<string | null> {
    if (this.cached !== undefined) return this.cached;
    let value: string | null = null;
    if (this.file) {
      try {
        const text = (await readFile(this.file, "utf8")).trim();
        value = isValidSshUsername(text) ? text : null;
      } catch {
        value = null;
      }
    }
    this.cached = value;
    return value;
  }

  async set(user: string): Promise<void> {
    this.cached = user;
    if (!this.file) return;
    try {
      await mkdir(path.dirname(this.file), { recursive: true });
      await writeFile(this.file, `${user}\n`, { mode: 0o600 });
    } catch {
      // melhor esforço: a regra continua valendo em memória até reiniciar
    }
  }
}
