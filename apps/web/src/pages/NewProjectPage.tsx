import { useState } from "react";
import { useNavigate } from "react-router";
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
import { PasswordInput } from "@/components/ui/password-input";
import { TokenGuide } from "@/components/TokenGuide";
import { FolderUpload, uploadFolder, type PickedFolder } from "@/components/FolderUpload";
import { ServerFolderBrowser } from "@/components/ServerFolderBrowser";
import { GithubRepoPicker } from "@/components/GithubRepoPicker";
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
    title: "Enviar do meu computador",
    description: "Escolha a pasta do projeto numa janela; os arquivos são enviados ao painel.",
    icon: FolderInput,
  },
  {
    mode: "existing",
    title: "Pasta que já está no servidor",
    description: "Usa o código de uma pasta da pasta de projetos do servidor, sem copiar.",
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
  const [ingestMode, setIngestMode] = useState<IngestMode>("git");
  // "Enviar do meu computador": pasta escolhida na janela do navegador
  const [folder, setFolder] = useState<PickedFolder | null>(null);
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(null);
  const [browsing, setBrowsing] = useState(false);
  // Repositório escolhido na lista da conta do GitHub conectada: se for
  // privado, o clone usa o token da conta — não pede outro.
  const [fromAccount, setFromAccount] = useState<{ fullName: string; private: boolean } | null>(null);
  const [sourceText, setSource] = useState("");
  const [branch, setBranch] = useState("main");
  // repositório privado: token de LEITURA, entregue à credencial do projeto
  // (cifrada no servidor) antes de o código ser baixado. Some da memória do
  // componente assim que é enviado.
  const [privateRepo, setPrivateRepo] = useState(false);
  const [token, setToken] = useState("");

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

  /**
   * Cria o projeto (ou, numa nova tentativa, atualiza o MESMO projeto — antes
   * cada tentativa criava outro), cadastra o token de leitura se o repositório
   * for privado e pede a detecção, que no modo git baixa o código primeiro.
   */
  async function createAndDetect() {
    setBusy(true);
    setError(null);
    try {
      let id = projectId;
      const dom = domain || defaultDomainFor(name);
      // Envio da pasta: os arquivos sobem antes; a pasta do servidor que os
      // recebeu vira a origem do projeto.
      let source = sourceText;
      if (ingestMode === "upload") {
        if (!folder) throw new Error("Escolha a pasta do projeto.");
        source = await uploadFolder(folder, (done, total) => setUploadProgress({ done, total }));
        setUploadProgress(null);
      }
      if (id === null) {
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
        id = created.project.id;
        setProjectId(id);
        setDomain(created.project.domain);
      } else {
        await apiFetch<ProjectResponse>(`/api/projects/${id}`, {
          method: "PATCH",
          body: JSON.stringify({ name, source, ...(ingestMode === "git" ? { branch } : {}) }),
        });
      }
      if (ingestMode === "git" && privateRepo && token.trim() !== "") {
        await apiFetch(`/api/projects/${id}/credential`, {
          method: "PUT",
          body: JSON.stringify({ token: token.trim() }),
        });
        setToken("");
      }
      const det = await apiFetch<DetectResponse>(`/api/projects/${id}/detect`, {
        method: "POST",
      });
      setDetection(det.detection);
      setProxyService(det.detection.proxyService ?? "");
      setProxyPort(det.detection.proxyPort ? String(det.detection.proxyPort) : "");
      setStep(1);
    } catch (err) {
      setUploadProgress(null);
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

  const hasSource = ingestMode === "upload" ? folder !== null && folder.files.length > 0 : sourceText.trim() !== "";
  const canNextStep0 =
    name.trim() !== "" && hasSource && (!privateRepo || ingestMode !== "git" || token.trim() !== "" || projectId !== null);

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

      {error && (
        <p data-testid="new-project-error" className="whitespace-pre-line text-sm text-destructive">
          {error}
        </p>
      )}

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
                  // o tipo de fonte não muda depois que o projeto foi criado
                  disabled={projectId !== null && opt.mode !== ingestMode}
                  onClick={() => {
                    // cada origem tem o seu campo: a URL do git não vira caminho de pasta
                    if (opt.mode !== ingestMode) setSource("");
                    setIngestMode(opt.mode);
                  }}
                  className={cn(
                    "flex flex-col gap-1 rounded-lg border p-3 text-left transition-colors",
                    ingestMode === opt.mode
                      ? "border-primary bg-primary/10"
                      : "hover:border-foreground/30 disabled:cursor-not-allowed disabled:opacity-50",
                  )}
                >
                  <opt.icon className="h-5 w-5" />
                  <span className="text-sm font-medium">{opt.title}</span>
                  <span className="text-xs text-muted-foreground">{opt.description}</span>
                </button>
              ))}
            </div>

            {ingestMode === "git" && (
              <div className="flex flex-col gap-2">
                <GithubRepoPicker
                  onPick={(repo) => {
                    setSource(repo.cloneUrl);
                    setBranch(repo.defaultBranch);
                    setPrivateRepo(false);
                    setFromAccount({ fullName: repo.fullName, private: repo.private });
                    if (!name.trim()) setName(repo.fullName.split("/")[1] ?? "");
                  }}
                />
                <label className="flex flex-col gap-1.5 text-sm">
                  URL do repositório
                  <Input
                    value={sourceText}
                    onChange={(e) => {
                      setSource(e.target.value);
                      setFromAccount(null);
                    }}
                    placeholder="https://github.com/usuario/repo.git"
                  />
                </label>
                {fromAccount?.private && (
                  <p data-testid="uses-account-token" className="text-xs text-emerald-400">
                    Repositório privado: o painel usa o token da conta do GitHub conectada (somente leitura) — não
                    precisa de outro.
                  </p>
                )}
              </div>
            )}

            {ingestMode === "upload" && (
              <FolderUpload folder={folder} onPick={setFolder} progress={uploadProgress} />
            )}

            {ingestMode === "existing" && (
              <div className="flex flex-col gap-1.5 text-sm">
                <label htmlFor="np-server-path">Caminho da pasta no servidor</label>
                <div className="flex gap-2">
                  <Input
                    id="np-server-path"
                    value={sourceText}
                    onChange={(e) => setSource(e.target.value)}
                    placeholder="/opt/tws-projects/meu-site"
                    className="font-mono"
                  />
                  <Button type="button" variant="outline" onClick={() => setBrowsing(true)}>
                    Procurar…
                  </Button>
                </div>
                <span className="text-xs text-muted-foreground">
                  Só pastas dentro da pasta de projetos do servidor. O código é usado de onde está, sem cópia.
                </span>
                {browsing && (
                  <ServerFolderBrowser
                    onChoose={(p) => {
                      setSource(p);
                      setBrowsing(false);
                    }}
                    onClose={() => setBrowsing(false)}
                  />
                )}
              </div>
            )}

            {ingestMode === "git" && (
              <label className="flex flex-col gap-1.5 text-sm">
                Branch
                <Input value={branch} onChange={(e) => setBranch(e.target.value)} />
              </label>
            )}

            {ingestMode === "git" && (
              <div className="flex flex-col gap-2">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={privateRepo}
                    onChange={(e) => setPrivateRepo(e.target.checked)}
                    className="h-4 w-4"
                  />
                  Repositório privado
                </label>
                {privateRepo && (
                  <div className="flex flex-col gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm">
                    <p className="text-emerald-800 dark:text-emerald-300">
                      <strong>Acesso somente leitura.</strong> O painel só baixa o código — nunca escreve,
                      commita nem faz push. No GitHub, crie um <em>fine-grained personal access token</em>{" "}
                      com a permissão <code className="font-mono text-xs">Contents: Read</code> só para este
                      repositório.
                    </p>
                    <label htmlFor="np-token" className="font-medium">
                      Token de leitura
                    </label>
                    <PasswordInput
                      id="np-token"
                      revealLabel="token"
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="cole o token aqui"
                    />
                    <TokenGuide url={sourceText} />
                    <span className="text-xs text-muted-foreground">
                      Guardado cifrado no servidor. Depois de salvo, só a dica dos últimos caracteres
                      volta a aparecer (na página do projeto, onde também dá para trocar ou remover).
                    </span>
                  </div>
                )}
              </div>
            )}

            <div className="flex justify-end">
              <Button disabled={!canNextStep0 || busy} onClick={() => void createAndDetect()}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
                {projectId === null ? "Criar e detectar" : "Tentar de novo"}
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
                  {detection.type === "unknown" ? (
                    <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                  ) : (
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                  )}
                  {d}
                </li>
              ))}
            </ul>

            {detection.type === "unknown" && (
              <div data-testid="unsupported-help" className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
                <p className="mb-1.5 font-medium text-amber-400">O painel ainda não sabe publicar este código.</p>
                <p className="mb-1.5 text-muted-foreground">Ele publica projetos que tenham, na pasta principal:</p>
                <ul className="flex list-disc flex-col gap-1 pl-5 text-muted-foreground">
                  <li>
                    um <code className="font-mono text-xs">index.html</code> — site em HTML puro, publicado como está;
                  </li>
                  <li>
                    um <code className="font-mono text-xs">package.json</code> com o script{" "}
                    <code className="font-mono text-xs">build</code> (<code className="font-mono text-xs">npm run build</code>)
                    que gera um site (Vite, Next.js export…);
                  </li>
                  <li>
                    um <code className="font-mono text-xs">Dockerfile</code> — qualquer linguagem;
                  </li>
                  <li>
                    um arquivo <code className="font-mono text-xs">docker-compose.yml</code> (ou compose.yml) — vários
                    serviços, como app + banco.
                  </li>
                </ul>
                <p className="mt-1.5 text-muted-foreground">
                  Um servidor Node/PHP/Python sem Dockerfile precisa de um Dockerfile para ser publicado.
                </p>
              </div>
            )}

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
