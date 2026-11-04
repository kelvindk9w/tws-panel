import { useEffect, useState } from "react";
import type { HealthCheck, HealthScanResult } from "@paas/core";
import { apiFetch, ApiRequestError } from "@/lib/api";
import { formatBytes, formatUptime } from "@/lib/utils";
import { apiErrorText, formatDateTime, useI18n } from "@/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SetupTimezoneCard } from "@/components/setup/SetupTimezoneCard";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  HelpCircle,
  Cpu,
  MemoryStick,
  HardDrive,
  Monitor,
  Network,
  Clock,
  RefreshCw,
  Loader2,
} from "lucide-react";

interface HealthStepProps {
  onNext: () => void;
  /** Navegação de volta no wizard (opcional — ex.: voltar às boas-vindas). */
  onBack?: () => void;
  /** Avisa o wizard do IP público da VPS (usado nos comandos `ssh` de teste). */
  onPublicIp?: (ip: string | null) => void;
}

/**
 * Selo de cada card. Todo card tem um: a ausência de selo parecia erro.
 * - ok: verde; warning: âmbar ("Atenção"); critical: vermelho ("Crítico" —
 *   hospedar já é inviável, não só apertado);
 * - unknown: neutro ("Não verificado") — o dado não pôde ser lido, o que
 *   não é nem aprovação nem falha.
 */
function CheckBadge({ check }: { check: HealthCheck }) {
  const { t } = useI18n();
  switch (check.level) {
    case "ok":
      return (
        <Badge variant="success" className="gap-1">
          <CheckCircle2 className="h-3 w-3" /> {t("setup.health.badge.ok")}
        </Badge>
      );
    case "warning":
      return (
        <Badge variant="warning" className="gap-1">
          <AlertTriangle className="h-3 w-3" /> {t("setup.health.badge.warning")}
        </Badge>
      );
    case "critical":
      return (
        <Badge variant="destructive" className="gap-1">
          <XCircle className="h-3 w-3" /> {t("setup.health.badge.critical")}
        </Badge>
      );
    default:
      return (
        <Badge variant="outline" className="gap-1">
          <HelpCircle className="h-3 w-3" /> {t("setup.health.badge.unknown")}
        </Badge>
      );
  }
}

const MESSAGE_CLASS: Record<HealthCheck["level"], string> = {
  ok: "text-muted-foreground",
  warning: "text-amber-400",
  critical: "text-red-400",
  unknown: "text-muted-foreground",
};

/** Mensagem do check, exibida só quando ele não está ok. */
function CheckMessage({ check }: { check: HealthCheck }) {
  if (check.level === "ok") return null;
  return <p className={`pt-1 ${MESSAGE_CLASS[check.level]}`}>{check.message}</p>;
}

export function HealthStep({ onNext, onBack, onPublicIp }: HealthStepProps) {
  const { t } = useI18n();
  const [scan, setScan] = useState<HealthScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function runScan() {
    setLoading(true);
    setError(null);
    try {
      const result = await apiFetch<HealthScanResult>("/api/health/scan");
      setScan(result);
      onPublicIp?.(result.network.publicIp);
    } catch (err) {
      setError(err instanceof ApiRequestError ? apiErrorText(err, "setup.health.scanFailed") : t("setup.health.scanFailed"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void runScan();
  }, []);

  // "Não verificado" não é ponto de atenção: só aviso e crítico contam.
  const hasWarnings =
    scan !== null &&
    Object.values(scan.checks).some((c) => c.level === "warning" || c.level === "critical");

  return (
    <div className="flex animate-fade-in flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">{t("setup.health.title")}</h2>
          <p className="text-sm text-muted-foreground">
            {t("setup.health.description")}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void runScan()} disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          {t("setup.health.rescan")}
        </Button>
      </div>

      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      {loading && !scan && (
        <div className="flex items-center justify-center gap-2 py-16 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" /> {t("setup.health.scanning")}
        </div>
      )}

      {scan && (
        <>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="flex items-center gap-2 text-sm font-medium">
                  <Monitor className="h-4 w-4 text-muted-foreground" /> {t("setup.health.os.title")}
                </CardTitle>
                <CheckBadge check={scan.checks.os} />
              </CardHeader>
              <CardContent className="space-y-1 text-sm">
                <p className="font-medium">{scan.os.prettyName}</p>
                <p className="text-muted-foreground">
                  {t("setup.health.os.kernel", { kernel: scan.os.kernel, arch: scan.os.arch })}
                </p>
                <p className="text-muted-foreground">{t("setup.health.os.host", { host: scan.os.hostname })}</p>
                <CheckMessage check={scan.checks.os} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="flex items-center gap-2 text-sm font-medium">
                  <Cpu className="h-4 w-4 text-muted-foreground" /> {t("setup.health.cpu.title")}
                </CardTitle>
                <CheckBadge check={scan.checks.cpu} />
              </CardHeader>
              <CardContent className="space-y-1 text-sm">
                <p className="font-medium">{scan.cpu.model}</p>
                <p className="text-muted-foreground">{t("setup.health.cpu.cores", { count: scan.cpu.cores })}</p>
                <p className="text-muted-foreground">
                  {t("setup.health.cpu.load", { values: scan.cpu.loadAvg.map((l) => l.toFixed(2)).join(" / ") })}
                </p>
                <CheckMessage check={scan.checks.cpu} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="flex items-center gap-2 text-sm font-medium">
                  <MemoryStick className="h-4 w-4 text-muted-foreground" /> {t("setup.health.memory.title")}
                </CardTitle>
                <CheckBadge check={scan.checks.memory} />
              </CardHeader>
              <CardContent className="space-y-1 text-sm">
                <p className="font-medium">{t("setup.health.total", { size: formatBytes(scan.memory.totalBytes) })}</p>
                <p className="text-muted-foreground">
                  {t("setup.health.freeUsed", {
                    free: formatBytes(scan.memory.freeBytes),
                    used: formatBytes(scan.memory.usedBytes),
                  })}
                </p>
                <CheckMessage check={scan.checks.memory} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="flex items-center gap-2 text-sm font-medium">
                  <HardDrive className="h-4 w-4 text-muted-foreground" /> {t("setup.health.disk.title")}
                </CardTitle>
                <CheckBadge check={scan.checks.disk} />
              </CardHeader>
              <CardContent className="space-y-1 text-sm">
                <p className="font-medium">{t("setup.health.total", { size: formatBytes(scan.disk.totalBytes) })}</p>
                <p className="text-muted-foreground">
                  {t("setup.health.freeUsed", {
                    free: formatBytes(scan.disk.freeBytes),
                    used: formatBytes(scan.disk.usedBytes),
                  })}
                </p>
                <CheckMessage check={scan.checks.disk} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="flex items-center gap-2 text-sm font-medium">
                  <Network className="h-4 w-4 text-muted-foreground" /> {t("setup.health.network.title")}
                </CardTitle>
                <CheckBadge check={scan.checks.network} />
              </CardHeader>
              <CardContent className="space-y-1 text-sm">
                <p className="font-medium">
                  {t("setup.health.network.publicIp", {
                    ip: scan.network.publicIp ?? t("setup.health.network.notDetected"),
                  })}
                </p>
                {scan.network.interfacesSource === "host" ? (
                  scan.network.interfaces.map((iface) => (
                    <p key={iface.name} className="text-muted-foreground">
                      {iface.name}: {iface.addresses.join(", ")}
                    </p>
                  ))
                ) : (
                  <p className="text-muted-foreground">
                    {t("setup.health.network.interfacesUnchecked")}
                  </p>
                )}
                <p className="text-muted-foreground">{t("setup.health.network.virtualization", { value: scan.virtualization })}</p>
                <CheckMessage check={scan.checks.network} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="flex items-center gap-2 text-sm font-medium">
                  <Clock className="h-4 w-4 text-muted-foreground" /> {t("setup.health.reboot.title")}
                </CardTitle>
                <CheckBadge check={scan.checks.reboot} />
              </CardHeader>
              <CardContent className="space-y-1 text-sm">
                <p className="font-medium">{formatUptime(scan.uptimeSeconds)}</p>
                <p className="text-muted-foreground">
                  {t("setup.health.reboot.pending", {
                    value:
                      scan.reboot.pending === null
                        ? t("setup.health.reboot.unchecked")
                        : scan.reboot.pending
                          ? t("setup.health.reboot.yes")
                          : t("setup.health.reboot.no"),
                  })}
                </p>
                {scan.reboot.pending === true && scan.reboot.packages.length > 0 && (
                  <p className="text-muted-foreground">{t("setup.health.reboot.requestedBy", { packages: scan.reboot.packages.join(", ") })}</p>
                )}
                <p className="text-muted-foreground">
                  {t("setup.health.reboot.scannedAt", { when: formatDateTime(scan.scannedAt) })}
                </p>
                <CheckMessage check={scan.checks.reboot} />
              </CardContent>
            </Card>
          </div>

          <SetupTimezoneCard />

          {hasWarnings && (
            <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-400">
              {t("setup.health.warnings")}
            </p>
          )}

          <div className="flex justify-between">
            {onBack ? (
              <Button variant="outline" onClick={onBack}>
                <ArrowLeft className="h-4 w-4" /> {t("setup.health.back")}
              </Button>
            ) : (
              <span />
            )}
            <Button onClick={onNext}>
              {t("setup.health.next")} <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
