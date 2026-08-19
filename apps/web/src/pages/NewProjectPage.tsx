import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type {
  DetectResponse,
  DetectResult,
  DomainCheckResponse,
  IngestMode,
  ProjectResponse,
} from "@paas/core";
import { apiFetch } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  FolderInput,
  FolderSymlink,
  GitBranch,
  Globe,
  Info,
  Loader2,
  Rocket,
  XCircle,
} from "lucide-react";
import { TYPE_LABELS } from "@/pages/DashboardPage";
import { cn } from "@/lib/utils";

const INGEST_OPTIONS: Array<{
  mode: IngestMode;
  title: string;
  description: string;
  icon: typeof GitBranch;
}> = [
  {
    mode: "git",
    title: "Repositório Git",
    description: "Clona uma URL git com branch configurável.",
    icon: GitBranch,
  },
  {
    mode: "upload",
    title: "Diretório local (upload)",
    description: "Copia uma pasta desta máquina para o painel.",
    icon: FolderInput,
  },
  {
    mode: "existing",
    title: "Caminho existente",
    description: "Usa o código diretamente de onde ele já está (dev local).",
    icon: FolderSymlink,
  },
];

const STEPS = ["Fonte do código", "Detecção automática", "Domínio e criação"];

function WarningRow({ warning }: { warning: DetectResult["warnings"][number] }) {
  const Icon =
    warning.severity === "critical"
      ? XCircle
      : warning.severity === "warning"
        ? AlertTriangle
        : Info;
  const color =
    warning.severity === "critical"
      ? "text-red-400"
      : warning.severity === "warning"
        ? "text-amber-400"
        : "text-muted-foreground";
  return (
    <li className="flex items-start gap-2 text-sm">
      <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", color)} />
      <span>
        {warning.service && <code className="mr-1 text-xs">[{warning.service}]</code>}
        {warning.message}
      </span>
    </li>
  );
}

export function NewProjectPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // passo 1 — fonte
  const [name, setName] = useState("");
  const [ingestMode, setIngestMode] = useState<IngestMode>("upload");
  const [source, setSource] = useState("");
  const [branch, setBranch] = useState("main");

  // passo 2 — detecção
  const [projectId, setProjectId] = useState<string | null>(null);
  const [detection, setDetection] = useState<DetectResult | null>(null);

  // passo 3 — domínio/config
  const [domain, setDomain] = useState("");
  const [websocket, setWebsocket] = useState(false);
  const [proxyService, setProxyService] = useState("");
  const [proxyPort, setProxyPort] = useState("");
  const [dnsCheck, setDnsCheck] = useState<DomainCheckResponse | null>(null);

  function defaultDomainFor(projectName: string): string {
    const slug = projectName
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return slug ? `${slug}.localhost` : "";
  }

  async function createAndDetect() {
    setBusy(true);
    setError(null);
    try {
      const dom = domain || defaultDomainFor(name);
      const created = await apiFetch<ProjectResponse>("/api/projects", {
        method: "POST",
        body: JSON.stringify({
          name,
          ingestMode,
          source,
          branch: ingestMode === "git" ? branch : undefined,
          domain: dom,
        }),
      });
      setProjectId(created.project.id);
      setDomain(created.project.domain);
      const det = await apiFetch<DetectResponse>(`/api/projects/${created.project.id}/detect`, {
        method: "POST",
      });
      setDetection(det.detection);
      setProxyService(det.detection.proxyService ?? "");
      setProxyPort(det.detection.proxyPort ? String(det.detection.proxyPort) : "");
      setStep(1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao criar o projeto.");
    } finally {
      setBusy(false);
    }
  }

  async function checkDns() {
    setBusy(true);
    setDnsCheck(null);
    try {
      setDnsCheck(await apiFetch<DomainCheckResponse>(`/api/domains/check?domain=${domain}`));
    } catch {
      setDnsCheck(null);
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    if (!projectId) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch<ProjectResponse>(`/api/projects/${projectId}`, {
        method: "PATCH",
        body: JSON.stringify({
          domain,
          websocket,
          proxyService: proxyService || null,
          proxyPort: proxyPort ? Number(proxyPort) : null,
        }),
      });
      navigate(`/projects/${projectId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao salvar o projeto.");
    } finally {
      setBusy(false);
    }
  }

  const canNextStep0 = name.trim() !== "" && source.trim() !== "";

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Novo Projeto</h1>
        <p className="text-sm text-muted-foreground">
          Assistente de 3 passos: fonte → detecção → domínio.
        </p>
      </div>

      <ol className="flex items-center gap-2 text-sm">
        {STEPS.map((label, i) => (
          <li key={label} className="flex items-center gap-2">
            <span
              className={cn(
                "flex h-6 w-6 items-center justify-center rounded-full border text-xs",
                i === step
                  ? "border-primary bg-primary text-primary-foreground"
                  : i < step
                    ? "border-emerald-500/50 text-emerald-400"
                    : "text-muted-foreground",
              )}
            >
              {i + 1}
            </span>
            <span className={i === step ? "font-medium" : "text-muted-foreground"}>{label}</span>
            {i < STEPS.length - 1 && <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />}
          </li>
        ))}
      </ol>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {step === 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Fonte do código</CardTitle>
            <CardDescription>De onde vem o código deste projeto?</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <label className="flex flex-col gap-1.5 text-sm">
              Nome do projeto
              <Input
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (!domain) setDomain("");
                }}
                placeholder="minha-app"
              />
            </label>

            <div className="grid gap-2 sm:grid-cols-3">
              {INGEST_OPTIONS.map((opt) => (
                <button
                  key={opt.mode}
                  type="button"
                  onClick={() => setIngestMode(opt.mode)}
                  className={cn(
                    "flex flex-col gap-1 rounded-lg border p-3 text-left transition-colors",
                    ingestMode === opt.mode
                      ? "border-primary bg-primary/10"
                      : "hover:border-foreground/30",
                  )}
                >
                  <opt.icon className="h-5 w-5" />
                  <span className="text-sm font-medium">{opt.title}</span>
                  <span className="text-xs text-muted-foreground">{opt.description}</span>
                </button>
              ))}
            </div>

            <label className="flex flex-col gap-1.5 text-sm">
              {ingestMode === "git" ? "URL do repositório" : "Caminho local do diretório"}
              <Input
                value={source}
                onChange={(e) => setSource(e.target.value)}
                placeholder={
                  ingestMode === "git"
                    ? "https://github.com/usuario/repo.git"
                    : "/home/kelvin/projects/minha-app"
                }
              />
            </label>

            {ingestMode === "git" && (
              <label className="flex flex-col gap-1.5 text-sm">
                Branch
                <Input value={branch} onChange={(e) => setBranch(e.target.value)} />
              </label>
            )}

            <div className="flex justify-end">
              <Button disabled={!canNextStep0 || busy} onClick={() => void createAndDetect()}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
                Criar e detectar
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 1 && detection && (
        <Card>
          <CardHeader>
            <CardTitle>Detecção automática</CardTitle>
            <CardDescription>
              Tipo detectado:{" "}
              <Badge variant={detection.type === "unknown" ? "destructive" : "secondary"}>
                {TYPE_LABELS[detection.type]}
              </Badge>
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <ul className="flex flex-col gap-1.5 text-sm text-muted-foreground">
              {detection.details.map((d, i) => (
                <li key={i} className="flex items-start gap-2">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                  {d}
                </li>
              ))}
            </ul>

            {detection.warnings.length > 0 && (
              <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
                <p className="mb-2 text-sm font-medium text-amber-400">
                  Guardrails de segurança ({detection.warnings.length})
                </p>
                <ul className="flex flex-col gap-1.5">
                  {detection.warnings.map((w, i) => (
                    <WarningRow key={i} warning={w} />
                  ))}
                </ul>
              </div>
            )}

            {detection.type === "compose" && (
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="flex flex-col gap-1.5 text-sm">
                  Serviço web (upstream do proxy)
                  <Input value={proxyService} onChange={(e) => setProxyService(e.target.value)} />
                </label>
                <label className="flex flex-col gap-1.5 text-sm">
                  Porta do serviço
                  <Input
                    value={proxyPort}
                    onChange={(e) => setProxyPort(e.target.value)}
                    inputMode="numeric"
                  />
                </label>
              </div>
            )}

            <div className="flex justify-between">
              <Button variant="outline" onClick={() => setStep(0)}>
                <ArrowLeft className="h-4 w-4" /> Voltar
              </Button>
              <Button disabled={detection.type === "unknown"} onClick={() => setStep(2)}>
                Continuar <ArrowRight className="h-4 w-4" />
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 2 && (
        <Card>
          <CardHeader>
            <CardTitle>Domínio e criação</CardTitle>
            <CardDescription>
              Em desenvolvimento local, use <code>.localhost</code> — o Caddy central resolve
              automaticamente, sem DNS nem certificado.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <label className="flex flex-col gap-1.5 text-sm">
              Domínio
              <div className="flex gap-2">
                <Input value={domain} onChange={(e) => setDomain(e.target.value)} />
                <Button variant="outline" disabled={busy || !domain} onClick={() => void checkDns()}>
                  <Globe className="h-4 w-4" /> Verificar DNS
                </Button>
              </div>
            </label>

            {dnsCheck && (
              <p
                className={cn(
                  "flex items-start gap-2 text-sm",
                  dnsCheck.ok ? "text-emerald-400" : "text-amber-400",
                )}
              >
                {dnsCheck.ok ? (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                ) : (
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                )}
                {dnsCheck.message}
              </p>
            )}

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={websocket}
                onChange={(e) => setWebsocket(e.target.checked)}
                className="h-4 w-4"
              />
              Projeto usa WebSocket / conexões longas (ex.: Colyseus, SSE)
            </label>

            <div className="flex justify-between">
              <Button variant="outline" onClick={() => setStep(1)}>
                <ArrowLeft className="h-4 w-4" /> Voltar
              </Button>
              <Button disabled={!domain || busy} onClick={() => void finish()}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
                Criar projeto
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
