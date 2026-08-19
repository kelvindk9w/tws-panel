/**
 * @paas/core — tipos compartilhados, schemas e constantes do painel PaaS.
 */

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

export const SETUP_PORT = 9000;
export const SETUP_TOKEN_HEADER = "x-setup-token";
export const SETUP_TOKEN_QUERY = "token";

/** Caminho padrão do arquivo de token de setup (produção, via install.sh). */
export const SETUP_TOKEN_FILE = "/etc/paas/setup-token";

/** Limites para alertas de saúde da máquina. */
export const HEALTH_LIMITS = {
  minRamBytes: 1 * 1024 ** 3, // 1 GiB
  minFreeDiskBytes: 10 * 1024 ** 3, // 10 GiB
  supportedDistroIds: ["ubuntu"],
  supportedVersionIds: ["22.04", "24.04"],
} as const;

// ---------------------------------------------------------------------------
// Wizard de setup
// ---------------------------------------------------------------------------

export interface SetupState {
  /** Passo atual do wizard (0 = boas-vindas/token). */
  currentStep: number;
  /** Setup concluído (fases futuras marcarão true). */
  completed: boolean;
  updatedAt: string;
}

export interface SetupStepInfo {
  id: number;
  key: string;
  title: string;
  available: boolean;
}

export interface SetupStatusResponse {
  state: SetupState;
  /** Passos conhecidos do wizard na fase atual. */
  steps: SetupStepInfo[];
}

export interface VerifyTokenRequest {
  token: string;
}

export interface VerifyTokenResponse {
  valid: boolean;
}

// ---------------------------------------------------------------------------
// Saúde da máquina (GET /api/health/scan)
// ---------------------------------------------------------------------------

export type HealthLevel = "ok" | "warning" | "critical";

export interface HealthCheck {
  level: HealthLevel;
  message: string;
}

export interface OsInfo {
  prettyName: string;
  id: string;
  versionId: string;
  kernel: string;
  arch: string;
  hostname: string;
}

export interface CpuInfo {
  model: string;
  cores: number;
  loadAvg: [number, number, number];
}

export interface MemoryInfo {
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
}

export interface DiskInfo {
  mount: string;
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
}

export interface NetworkInterfaceInfo {
  name: string;
  addresses: string[];
}

export interface NetworkInfo {
  publicIp: string | null;
  interfaces: NetworkInterfaceInfo[];
}

export interface HealthScanResult {
  scannedAt: string;
  os: OsInfo;
  cpu: CpuInfo;
  memory: MemoryInfo;
  disk: DiskInfo;
  network: NetworkInfo;
  virtualization: string;
  uptimeSeconds: number;
  checks: {
    os: HealthCheck;
    memory: HealthCheck;
    disk: HealthCheck;
  };
}

// ---------------------------------------------------------------------------
// Erros da API
// ---------------------------------------------------------------------------

export interface ApiError {
  error: string;
  message: string;
}

export * from "./security";
export * from "./deploy";
export * from "./mail";
export * from "./monitoring";
