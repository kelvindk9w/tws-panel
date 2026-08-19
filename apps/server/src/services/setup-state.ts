import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SetupState, SetupStepInfo } from "@paas/core";

/** Passos do wizard na Fase 0 (fases futuras adicionam os demais). */
export const SETUP_STEPS: SetupStepInfo[] = [
  { id: 0, key: "welcome", title: "Boas-vindas e token", available: true },
  { id: 1, key: "health", title: "Saúde da máquina", available: true },
  { id: 2, key: "security", title: "Segurança", available: true },
  { id: 3, key: "admin", title: "Conta de administrador", available: false },
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

  async save(state: SetupState): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const toWrite: SetupState = { ...state, updatedAt: new Date().toISOString() };
    await writeFile(this.file, JSON.stringify(toWrite, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  /** Avança o passo atual (usado pelos endpoints do wizard). */
  async setStep(step: number): Promise<SetupState> {
    const state = await this.load();
    const next: SetupState = { ...state, currentStep: step };
    await this.save(next);
    return next;
  }
}
