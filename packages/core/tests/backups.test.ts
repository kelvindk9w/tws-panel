import { describe, expect, it } from "vitest";
import {
  BACKUP_FREQUENCIES,
  BACKUP_ROOT_FOLDER,
  DEFAULT_BACKUP_HOUR,
  DEFAULT_LOCAL_KEEP,
  DEFAULT_REMOTE_KEEP,
  MIN_BACKUP_PASSWORD_LENGTH,
  backupCoverageHours,
  backupFileStamp,
  backupFolderFor,
  backupPasswordStrength,
  buildRecoveryKit,
  formatBackupCoverage,
  isValidBackupFileName,
  parseBackupFileStamp,
} from "../src/index";

describe("backups: padrões", () => {
  it("frequências, horário e retenção combinados com o dono", () => {
    expect(BACKUP_FREQUENCIES).toEqual([24, 12, 6]);
    expect(DEFAULT_BACKUP_HOUR).toBe(3);
    expect(DEFAULT_LOCAL_KEEP).toBe(2);
    expect(DEFAULT_REMOTE_KEEP).toBe(5);
    expect(MIN_BACKUP_PASSWORD_LENGTH).toBeGreaterThanOrEqual(12);
    expect(BACKUP_ROOT_FOLDER).toBe("TWS Panel Backups");
  });
});

describe("backups: cobertura (frequência × retenção)", () => {
  it("calcula as horas cobertas", () => {
    expect(backupCoverageHours(24, 5)).toBe(120);
    expect(backupCoverageHours(6, 2)).toBe(12);
    expect(backupCoverageHours(24, 0)).toBe(0);
  });

  it("escreve em horas ou dias", () => {
    expect(formatBackupCoverage(12)).toBe("as últimas 12 horas");
    expect(formatBackupCoverage(24)).toBe("as últimas 24 horas");
    expect(formatBackupCoverage(120)).toBe("os últimos 5 dias");
    expect(formatBackupCoverage(60)).toBe("os últimos 2 dias e 12 horas");
    expect(formatBackupCoverage(1)).toBe("a última 1 hora");
    expect(formatBackupCoverage(36)).toBe("as últimas 36 horas");
    expect(formatBackupCoverage(0)).toBe("nenhum período");
  });
});

describe("backups: nome do arquivo", () => {
  it("data primeiro, para a ordem alfabética ser a cronológica", () => {
    const d = new Date(2026, 9, 4, 3, 7);
    expect(backupFileStamp(d)).toBe("2026-10-04_03-07");
    expect(parseBackupFileStamp("2026-10-04_03-07.7z")?.getTime()).toBe(d.getTime());
    expect(parseBackupFileStamp("2026-10-04_03-07-2.7z")?.getTime()).toBe(d.getTime());
    expect(parseBackupFileStamp("qualquer.7z")).toBeNull();
  });

  it("só aceita nomes gerados pelo painel", () => {
    expect(isValidBackupFileName("2026-10-04_03-07.7z")).toBe(true);
    expect(isValidBackupFileName("2026-10-04_03-07-3.7z")).toBe(true);
    expect(isValidBackupFileName("../2026-10-04_03-07.7z")).toBe(false);
    expect(isValidBackupFileName("2026-10-04_03-07.zip")).toBe(false);
  });

  it("pasta por item", () => {
    expect(backupFolderFor({ kind: "panel" })).toBe("_painel");
    expect(backupFolderFor({ kind: "email" })).toBe("_email");
    expect(backupFolderFor({ kind: "project", slug: "loja" })).toBe("loja");
  });
});

describe("backups: força da senha", () => {
  it("curta demais nunca vale", () => {
    const s = backupPasswordStrength("Ab1!Ab1!");
    expect(s.ok).toBe(false);
    expect(s.label).toBe("Curta demais");
    expect(backupPasswordStrength("").score).toBe(0);
  });

  it("repetição e sequência contam pouco", () => {
    expect(backupPasswordStrength("aaaaaaaaaaaaaaaa").ok).toBe(false);
    expect(backupPasswordStrength("123456789012").ok).toBe(false);
  });

  it("frase longa é forte", () => {
    const s = backupPasswordStrength("cavalo-azul-janela-trigo-mesa-41");
    expect(s.ok).toBe(true);
    expect(s.score).toBe(4);
    expect(s.label).toBe("Forte");
  });

  it("12 caracteres variados é aceitável", () => {
    const s = backupPasswordStrength("Tr0ca#Senha9");
    expect(s.ok).toBe(true);
    expect(s.score).toBeGreaterThanOrEqual(2);
    expect(["Razoável", "Boa", "Forte"]).toContain(s.label);
  });

  it("sem letras minúsculas também conta a variedade", () => {
    expect(backupPasswordStrength("TROCA#SENHA9X").ok).toBe(true);
  });

  it("12 letras minúsculas só é razoável", () => {
    const s = backupPasswordStrength("abobrinhasxz");
    expect(s.ok).toBe(true);
    expect(s.label).toBe("Razoável");
  });
});

describe("backups: kit de recuperação", () => {
  const base = {
    password: "cavalo-azul-janela-trigo-mesa-41",
    generatedAt: new Date("2026-10-14T12:00:00Z"),
    destination: { provider: "r2" as const, endpoint: "https://abc.r2.cloudflarestorage.com", bucket: "meus-backups" },
    localPath: "/var/lib/docker/volumes/paas_data/_data/backups",
  };

  it("traz a senha, onde ficam e como restaurar com e sem o painel", () => {
    const kit = buildRecoveryKit(base);
    expect(kit).toContain("cavalo-azul-janela-trigo-mesa-41");
    expect(kit).toContain("meus-backups");
    expect(kit).toContain("Cloudflare R2");
    expect(kit).toContain("TWS Panel Backups/_painel/");
    expect(kit).toContain("7-Zip");
    expect(kit).toContain("Keka");
    expect(kit).toContain("psql");
    expect(kit).toContain("mysql");
    expect(kit).toContain("mongorestore");
    expect(kit).toContain("Restaurar de outro servidor");
    expect(kit).toContain(base.localPath);
  });

  it("diz sem ambiguidade que as chaves de acesso do armazenamento NÃO estão no kit e precisam ser guardadas à parte", () => {
    const kit = buildRecoveryKit(base);
    expect(kit).toContain("O QUE ESTE KIT NÃO TEM");
    expect(kit).toContain("Access Key ID");
    expect(kit).toContain("Secret Access Key");
    expect(kit).toMatch(/NÃO estão neste arquivo/);
    expect(kit).toMatch(/guarde-as à parte/i);
    // o passo da VPS nova não sugere que as chaves estejam aqui
    expect(kit).toMatch(/chaves de acesso[^\n]*(não estão neste kit|à parte)/i);
    expect(kit).not.toContain("endpoint, bucket e chaves");
    expect(kit).not.toContain("o painel publica o código do GitHub");
    expect(kit).toMatch(/upload e de pasta do servidor/);
    // e nenhum segredo do armazenamento entra no texto
    expect(buildRecoveryKit({ ...base, destination: { ...base.destination, secretAccessKey: "segredo-nunca-no-kit" } as typeof base.destination })).not.toContain("segredo-nunca-no-kit");
  });

  it("outro provedor compatível com S3", () => {
    const kit = buildRecoveryKit({ ...base, destination: { provider: "s3", endpoint: "https://s3.exemplo.com", bucket: "b" } });
    expect(kit).toContain("armazenamento compatível com S3");
    expect(kit).not.toContain("Cloudflare R2 —");
  });

  it("sem destino conectado ainda", () => {
    const kit = buildRecoveryKit({ ...base, destination: null });
    expect(kit).toContain("ainda não conectado");
  });
});
