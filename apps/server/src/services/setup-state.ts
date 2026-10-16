import { readFile } from "node:fs/promises";
import path from "node:path";
import type { SetupState, SetupStepInfo } from "@paas/core";
import { withFileLock, writeFileAtomic } from "./json-file.js";

/** Passos do wizard na Fase 0 (fases futuras adicionam os demais). */
export const SETUP_STEPS: SetupStepInfo[] = [
  { id: 0, key: "welcome", title: "Boas-vindas e token", available: true },
  { id: 1, key: "health", title: "Saúde da máquina", available: true },
  { id: 2, key: "security", title: "Segurança", available: true },
  { id: 3, key: "admin", title: "Conta de administrador", available: true },
];

const DEFAULT_STATE: SetupState = {
  currentStep: 0,
  completed: false,
  updatedAt: new Date(0).toISOString(),
};

export class SetupStateStore {
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "setup-state.json");
  }

  async load(): Promise<SetupState> {
    try {
      const raw = await readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as Partial<SetupState>;
      return {
        currentStep: Number(parsed.currentStep ?? 0),
        completed: Boolean(parsed.completed ?? false),
        updatedAt: String(parsed.updatedAt ?? DEFAULT_STATE.updatedAt),
      };
    } catch {
      return { ...DEFAULT_STATE, updatedAt: new Date().toISOString() };
    }
  }

  /** Substitui o estado inteiro (na fila do arquivo, como as demais alterações). */
  async save(state: SetupState): Promise<void> {
    await withFileLock(this.file, () => this.write(state));
  }

  /** Gravação atômica (services/json-file.ts). */
  private async write(state: SetupState): Promise<SetupState> {
    const toWrite: SetupState = { ...state, updatedAt: new Date().toISOString() };
    await writeFileAtomic(this.file, JSON.stringify(toWrite, null, 2) + "\n");
    return toWrite;
  }

  /**
   * Lê, altera e grava na fila do arquivo: "avançar o passo" e "concluir"
   * chegando juntos nunca desfazem um ao outro (ex.: setup concluído que
   * voltava a "não concluído").
   */
  private change(fn: (state: SetupState) => SetupState): Promise<SetupState> {
    return withFileLock(this.file, async () => this.write(fn(await this.load())));
  }

  /** Volta ao passo 0, não concluído ("Recomeçar do zero"). */
  async reset(): Promise<void> {
    await this.change(() => ({ ...DEFAULT_STATE }));
  }

  /** Avança o passo atual (usado pelos endpoints do wizard). */
  async setStep(step: number): Promise<SetupState> {
    return this.change((state) => ({ ...state, currentStep: step }));
  }

  /** Marca o setup como concluído (chamado ao criar a conta admin). */
  async complete(): Promise<SetupState> {
    return this.change((state) => ({ ...state, completed: true }));
  }
}
