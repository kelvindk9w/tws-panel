import { useEffect, useState } from "react";
import type { HealthCheck, HealthScanResult } from "@paas/core";
import { apiFetch, ApiRequestError } from "@/lib/api";
import { formatBytes, formatUptime } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ArrowRight,
  CheckCircle2,
  AlertTriangle,
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
}

function CheckBadge({ check }: { check: HealthCheck }) {
  return check.level === "ok" ? (
    <Badge variant="success" className="gap-1">
      <CheckCircle2 className="h-3 w-3" /> OK
    </Badge>
  ) : (
    <Badge variant="warning" className="gap-1">
      <AlertTriangle className="h-3 w-3" /> Atenção
    </Badge>
  );
}

export function HealthStep({ onNext }: HealthStepProps) {
  const [scan, setScan] = useState<HealthScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function runScan() {
    setLoading(true);
    setError(null);
    try {
      setScan(await apiFetch<HealthScanResult>("/api/health/scan"));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Falha ao executar a varredura.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void runScan();
  }, []);

  const hasWarnings =
    scan !== null &&
    Object.values(scan.checks).some((c) => c.level !== "ok");

  return (
    <div className="flex animate-fade-in flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold">Saúde da máquina</h2>
          <p className="text-sm text-muted-foreground">
            Diagnóstico do servidor antes da instalação. Nada é alterado — esta etapa é somente
            leitura.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void runScan()} disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Revarrer
        </Button>
      </div>

      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      {loading && !scan && (
        <div className="flex items-center justify-center gap-2 py-16 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" /> Analisando o servidor…
        </div>
      )}

      {scan && (
        <>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="flex items-center gap-2 text-sm font-medium">
                  <Monitor className="h-4 w-4 text-muted-foreground" /> Sistema operacional
                </CardTitle>
                <CheckBadge check={scan.checks.os} />
              </CardHeader>
              <CardContent className="space-y-1 text-sm">
                <p className="font-medium">{scan.os.prettyName}</p>
                <p className="text-muted-foreground">
                  Kernel {scan.os.kernel} · {scan.os.arch}
                </p>
                <p className="text-muted-foreground">Host: {scan.os.hostname}</p>
                {scan.checks.os.level !== "ok" && (
                  <p className="pt-1 text-amber-400">{scan.checks.os.message}</p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="flex items-center gap-2 text-sm font-medium">
                  <Cpu className="h-4 w-4 text-muted-foreground" /> CPU
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-1 text-sm">
                <p className="font-medium">{scan.cpu.model}</p>
                <p className="text-muted-foreground">{scan.cpu.cores} núcleos</p>
                <p className="text-muted-foreground">
                  Carga (1/5/15 min):{" "}
                  {scan.cpu.loadAvg.map((l) => l.toFixed(2)).join(" / ")}
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="flex items-center gap-2 text-sm font-medium">
                  <MemoryStick className="h-4 w-4 text-muted-foreground" /> Memória
                </CardTitle>
                <CheckBadge check={scan.checks.memory} />
              </CardHeader>
              <CardContent className="space-y-1 text-sm">
                <p className="font-medium">{formatBytes(scan.memory.totalBytes)} totais</p>
                <p className="text-muted-foreground">
                  {formatBytes(scan.memory.freeBytes)} livres · {formatBytes(scan.memory.usedBytes)} em uso
                </p>
                {scan.checks.memory.level !== "ok" && (
                  <p className="pt-1 text-amber-400">{scan.checks.memory.message}</p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="flex items-center gap-2 text-sm font-medium">
                  <HardDrive className="h-4 w-4 text-muted-foreground" /> Disco (/)
                </CardTitle>
                <CheckBadge check={scan.checks.disk} />
              </CardHeader>
              <CardContent className="space-y-1 text-sm">
                <p className="font-medium">{formatBytes(scan.disk.totalBytes)} totais</p>
                <p className="text-muted-foreground">
                  {formatBytes(scan.disk.freeBytes)} livres · {formatBytes(scan.disk.usedBytes)} em uso
                </p>
                {scan.checks.disk.level !== "ok" && (
                  <p className="pt-1 text-amber-400">{scan.checks.disk.message}</p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="flex items-center gap-2 text-sm font-medium">
                  <Network className="h-4 w-4 text-muted-foreground" /> Rede
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-1 text-sm">
                <p className="font-medium">
                  IP público: {scan.network.publicIp ?? "não detectado"}
                </p>
                {scan.network.interfaces.map((iface) => (
                  <p key={iface.name} className="text-muted-foreground">
                    {iface.name}: {iface.addresses.join(", ")}
                  </p>
                ))}
                <p className="text-muted-foreground">Virtualização: {scan.virtualization}</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="flex items-center gap-2 text-sm font-medium">
                  <Clock className="h-4 w-4 text-muted-foreground" /> Uptime
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-1 text-sm">
                <p className="font-medium">{formatUptime(scan.uptimeSeconds)}</p>
                <p className="text-muted-foreground">
                  Varredura em {new Date(scan.scannedAt).toLocaleString("pt-BR")}
                </p>
              </CardContent>
            </Card>
          </div>

          {hasWarnings && (
            <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-400">
              ⚠️ Há pontos de atenção acima. Você pode continuar, mas recomendamos resolvê-los antes
              de hospedar projetos em produção.
            </p>
          )}

          <div className="flex justify-end">
            <Button onClick={onNext}>
              Continuar <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
