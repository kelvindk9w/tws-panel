import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { CHOOSABLE_PROJECT_TYPES, type ProjectType } from "@paas/core";
import type {
  AutoDomainSuggestion,
  DetectResponse,
  DetectResult,
  DomainCheckResponse,
  IngestMode,
  ProjectResponse,
} from "@paas/core";
import { apiFetch } from "@/lib/api";
import { apiErrorText, Trans, useI18n, type Key } from "@/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { GitAccessTest } from "@/components/GitAccessTest";
import { TokenGuide } from "@/components/TokenGuide";
import { ServerFolderBrowser } from "@/components/ServerFolderBrowser";
import { GithubRepoPicker } from "@/components/GithubRepoPicker";
import { DnsGuide } from "@/components/DnsGuide";
import { addressHasVpsIp, IpAddressWarning } from "@/components/IpInAddress";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
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
import { domainToSend } from "@/lib/dns-records";
import { ComposeEntryPicker, ComposeServicesList, validPortText } from "@/components/project/ComposeServices";
import { NextServerNotes } from "@/components/project/NextServerNotes";

const INGEST_OPTIONS: Array<{
  mode: IngestMode;
  title: Key;
  description: Key;
  icon: typeof GitBranch;
}> = [
  {
    mode: "git",
    title: "projects.new.ingest.git.title",
    description: "projects.new.ingest.git.description",
    icon: GitBranch,
  },
  {
    mode: "existing",
    title: "projects.new.ingest.existing.title",
    description: "projects.new.ingest.existing.description",
    icon: FolderSymlink,
  },
];

const STEPS: Key[] = ["projects.new.step.source", "projects.new.step.detection", "projects.new.step.domain"];

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
  const { t } = useI18n();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // passo 1 — fonte
  const [name, setName] = useState("");
  const [ingestMode, setIngestMode] = useState<IngestMode>("git");
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
  // aplicação de página única (site estático): já vem ligada quando a detecção reconhece uma
  const [spa, setSpa] = useState(false);

  // passo 3 — domínio/config
  const [domain, setDomain] = useState("");
  const [websocket, setWebsocket] = useState(false);
  // "Fazer backup": Sim segue o "Padrão dos projetos" (Configurações → Backups);
  // Não desliga e vira configuração própria. O que entra é escolhido na aba Backups.
  const [backup, setBackup] = useState(true);
  const [proxyService, setProxyService] = useState("");
  const [proxyPort, setProxyPort] = useState("");
  const [dnsCheck, setDnsCheck] = useState<DomainCheckResponse | null>(null);
  // Endereço automático (sob o domínio de aplicações, se houver; senão
  // <projeto>.<ip>.sslip.io), endereço de teste (sslip.io) ou domínio próprio
  const [autoDomain, setAutoDomain] = useState<string | null>(null);
  const [publicIp, setPublicIp] = useState<string | null>(null);
  const [appsBase, setAppsBase] = useState<string | null>(null);
  const [testAddress, setTestAddress] = useState<string | null>(null);
  const [domainMode, setDomainMode] = useState<"auto" | "test" | "own">("auto");
  const [ownDomain, setOwnDomain] = useState("");
  // par com/sem www do domínio próprio: ligado por padrão (recomendado); desligar vale ao concluir
  const [pairEnabled, setPairEnabled] = useState(true);
  const pairSentOff = useRef(false);
  // projeto em que o assistente já acrescentou o endereço temporário (a nova tentativa não duplica)
  const temporaryAdded = useRef<string | null>(null);

  function defaultDomainFor(projectName: string): string {
    const slug = projectName
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return slug ? `${slug}.localhost` : "";
  }

  /** Domínio de aplicações: guarda a base e o endereço de teste (sslip.io) que a resposta traz. */
  function applySuggestion(sug: AutoDomainSuggestion | null) {
    const apps = sug?.kind === "apps";
    setAppsBase(apps ? (sug.appsBase ?? null) : null);
    setTestAddress(apps ? (sug.testAddress ?? null) : null);
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
      let dom = domain;
      if (!dom) {
        // endereço automático: funciona na hora, com HTTPS, sem configurar DNS
        const sug = await apiFetch<AutoDomainSuggestion>(`/api/domains/suggest?name=${encodeURIComponent(name)}`).catch(() => null);
        const auto = sug?.auto ?? defaultDomainFor(name);
        // Com domínio de aplicações, o projeto NASCE com um endereço provisório único
        // (.localhost, sem certificado público nem IP): o proxy pede certificado na hora e o
        // limite do Let's Encrypt é por semana. O endereço sob a base só entra em finish(),
        // se a pessoa escolher o automático.
        dom = sug?.kind === "apps" ? (sug.provisional ?? (defaultDomainFor(name) || "projeto.localhost")) : auto;
        setAutoDomain(auto);
        setPublicIp(sug?.publicIp ?? null);
        applySuggestion(sug);
      }
      const source = sourceText;
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
      setSpa(det.detection.spaSuggested === true);
      setProxyService(det.detection.proxyService ?? "");
      setProxyPort(det.detection.proxyPort ? String(det.detection.proxyPort) : "");
      setStep(1);
    } catch (err) {
      setError(apiErrorText(err, "projects.new.createError"));
    } finally {
      setBusy(false);
    }
  }

  /** Tipo escolhido à mão (ou "" = voltar à detecção automática): o servidor confere com o código. */
  async function chooseType(value: string) {
    if (!projectId) return;
    setBusy(true);
    setError(null);
    try {
      const det = await apiFetch<DetectResponse>(`/api/projects/${projectId}/detect`, {
        method: "POST",
        body: JSON.stringify({ type: value === "" ? null : (value as ProjectType) }),
      });
      setDetection(det.detection);
      setSpa(det.detection.spaSuggested === true);
      setProxyService(det.detection.proxyService ?? "");
      setProxyPort(det.detection.proxyPort ? String(det.detection.proxyPort) : "");
    } catch (err) {
      setError(apiErrorText(err, "projects.new.detect.typeError"));
    } finally {
      setBusy(false);
    }
  }

  async function checkDns() {
    setBusy(true);
    setDnsCheck(null);
    try {
      setDnsCheck(await apiFetch<DomainCheckResponse>(`/api/domains/check?domain=${encodeURIComponent(domainToSend(ownDomain))}`));
    } catch {
      setDnsCheck(null);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Para onde ir depois de criar: o projeto, já pedindo o primeiro deploy — ou,
   * se o compose exige variáveis ainda sem valor, a seção Variáveis (o deploy
   * falharia sem elas).
   */
  async function firstDeployPath(id: string): Promise<string> {
    if (detection?.type === "compose") {
      try {
        const env = await apiFetch<{
          vars: Array<{ key: string; value: string }>;
          compose?: { variables: Array<{ name: string; required: boolean }> } | null;
        }>(`/api/projects/${id}/env`);
        const defined = new Set(env.vars.filter((v) => v.value !== "").map((v) => v.key));
        if ((env.compose?.variables ?? []).some((v) => v.required && !defined.has(v.name))) {
          return `/projects/${id}/env?deploy=pending`;
        }
      } catch {
        // sem a lista, o deploy segue e o log mostra o que faltar
      }
    }
    return `/projects/${id}?deploy=1`;
  }

  /**
   * Domínio próprio escolhido (ele vira o principal e o endereço automático sai da lista): se o DNS
   * dele ainda não aponta para a VPS, mantém um endereço temporário como adicional para o site poder
   * ser testado enquanto o DNS propaga. Best-effort: qualquer falha é ignorada (a tela do projeto
   * oferece o mesmo botão depois). Painel local ou DNS não verificável: não acrescenta nada.
   */
  async function keepTemporaryAddress(id: string, official: string) {
    // nova tentativa de finish(): o temporário já acrescentado fica; não sorteia outro
    if (temporaryAdded.current === id) return;
    try {
      const sug = await apiFetch<AutoDomainSuggestion>(`/api/domains/suggest?name=${encodeURIComponent(name)}`);
      if (sug.panelPublic !== true || sug.auto.endsWith(".localhost") || sug.auto === official) return;
      const check = await apiFetch<DomainCheckResponse>(`/api/domains/check?domain=${encodeURIComponent(official)}`);
      if (check.ok !== false) return;
      await apiFetch<ProjectResponse>(`/api/projects/${id}/domains`, { method: "POST", body: JSON.stringify({ domain: sug.auto }) });
      temporaryAdded.current = id;
    } catch {
      // sem o temporário o projeto é criado do mesmo jeito
    }
  }

  async function finish() {
    if (!projectId) return;
    setBusy(true);
    setError(null);
    try {
      let finalDomain = chosenDomain;
      if (domainMode === "auto" && appsBase !== null) {
        // A base pode ter sido removida ou trocada em outra aba: confere no servidor antes de
        // gravar o endereço sob ela. Se mudou, mostra o novo endereço e espera a pessoa confirmar
        // (o projeto continua com o provisório; clicar de novo é seguro).
        const sug = await apiFetch<AutoDomainSuggestion>(`/api/domains/suggest?name=${encodeURIComponent(name)}`);
        if (sug.kind !== "apps" || sug.appsBase !== appsBase || !chosenDomain.endsWith(`.${sug.appsBase ?? ""}`)) {
          setAutoDomain(sug.auto);
          applySuggestion(sug);
          setNotice(t("projects.new.domain.baseChanged"));
          return;
        }
        finalDomain = chosenDomain;
      }
      setNotice(null);
      await apiFetch<ProjectResponse>(`/api/projects/${projectId}`, {
        method: "PATCH",
        body: JSON.stringify({
          domain: finalDomain,
          ...(domainMode === "own" && (!pairEnabled || pairSentOff.current) ? { pair: pairEnabled } : {}),
          websocket,
          proxyService: proxyService || null,
          proxyPort: proxyPort ? Number(proxyPort) : null,
          ...(detection?.type === "static" || detection?.type === "static-node" ? { spa } : {}),
        }),
      });
      if (domainMode === "own") {
        pairSentOff.current = !pairEnabled;
        await keepTemporaryAddress(projectId, finalDomain);
      }
      if (!backup) {
        await apiFetch(`/api/backups/targets/project:${projectId}`, { method: "PUT", body: JSON.stringify({ enabled: false }) });
      }
      navigate(await firstDeployPath(projectId));
    } catch (err) {
      setError(apiErrorText(err, "projects.new.saveError"));
    } finally {
      setBusy(false);
    }
  }

  const hasSource = sourceText.trim() !== "";
  const autoAddress = autoDomain ?? domain;
  const chosenDomain =
    domainMode === "auto" ? autoAddress : domainMode === "test" ? (testAddress ?? "") : domainToSend(ownDomain);
  // O endereço mostrado agora (automático ou de teste) com o IP da VPS no nome
  const shownAddress = domainMode === "test" ? (testAddress ?? "") : autoAddress;
  const showIpWarning = domainMode !== "own" && addressHasVpsIp(shownAddress);

  // O Domínio de aplicações pode ter sido configurado em outra aba enquanto o
  // assistente está aberto: ao voltar para esta aba, o endereço automático
  // passa a ser o novo (a escolha da pessoa — teste ou domínio próprio — não muda).
  const onSslipAuto = step === 2 && projectId !== null && appsBase === null && addressHasVpsIp(autoAddress);
  useEffect(() => {
    if (!onSslipAuto) return;
    let cancelled = false;
    const refresh = () => {
      void apiFetch<AutoDomainSuggestion>(`/api/domains/suggest?name=${encodeURIComponent(name)}`)
        .then((sug) => {
          if (cancelled || sug.kind !== "apps") return;
          setAutoDomain(sug.auto);
          applySuggestion(sug);
        })
        .catch(() => undefined);
    };
    window.addEventListener("focus", refresh);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", refresh);
    };
    // applySuggestion só usa setters estáveis
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onSslipAuto, name]);
  const canNextStep0 =
    name.trim() !== "" && hasSource && (!privateRepo || ingestMode !== "git" || token.trim() !== "" || projectId !== null);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t("projects.new.title")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("projects.new.subtitle")}
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
            <span className={i === step ? "font-medium" : "text-muted-foreground"}>{t(label)}</span>
            {i < STEPS.length - 1 && <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />}
          </li>
        ))}
      </ol>

      {notice && (
        <p role="status" data-testid="new-project-notice" className="text-sm text-amber-800 dark:text-amber-300">
          {notice}
        </p>
      )}

      {error && (
        <p data-testid="new-project-error" className="whitespace-pre-line text-sm text-destructive">
          {error}
        </p>
      )}

      {step === 0 && (
        <Card>
          <CardHeader>
            <CardTitle>{t("projects.new.source.title")}</CardTitle>
            <CardDescription>{t("projects.new.source.description")}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <label className="flex flex-col gap-1.5 text-sm">
              {t("projects.new.source.name")}
              <Input
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (!domain) setDomain("");
                }}
                placeholder={t("projects.new.source.namePlaceholder")}
              />
            </label>

            <div className="grid gap-2 sm:grid-cols-2">
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
                  <span className="text-sm font-medium">{t(opt.title)}</span>
                  <span className="text-xs text-muted-foreground">{t(opt.description)}</span>
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
                  {t("projects.new.source.repoUrl")}
                  <Input
                    value={sourceText}
                    onChange={(e) => {
                      setSource(e.target.value);
                      setFromAccount(null);
                    }}
                    placeholder={t("projects.new.source.repoUrlPlaceholder")}
                  />
                </label>
                {fromAccount?.private && (
                  <p data-testid="uses-account-token" className="text-xs text-emerald-400">
                    {t("projects.new.source.accountToken")}
                  </p>
                )}
                {fromAccount?.private && (
                  <GitAccessTest source={sourceText} branch={branch} useAccount />
                )}
              </div>
            )}

            {ingestMode === "existing" && (
              <div className="flex flex-col gap-1.5 text-sm">
                <label htmlFor="np-server-path">{t("projects.new.source.folderPath")}</label>
                <div className="flex gap-2">
                  <Input
                    id="np-server-path"
                    value={sourceText}
                    onChange={(e) => setSource(e.target.value)}
                    placeholder={t("projects.new.source.folderPlaceholder")}
                    className="font-mono"
                  />
                  <Button type="button" variant="outline" onClick={() => setBrowsing(true)}>
                    {t("projects.new.source.browse")}
                  </Button>
                </div>
                <span className="text-xs text-muted-foreground">
                  {t("projects.new.source.folderHint")}
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
                {t("projects.new.source.branch")}
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
                  {t("projects.new.source.privateRepo")}
                </label>
                {privateRepo && (
                  <div className="flex flex-col gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm">
                    <p className="text-emerald-800 dark:text-emerald-300">
                      <Trans
                        k="projects.new.source.readOnly"
                        components={{ b: <strong />, em: <em />, code: <code className="font-mono text-xs" /> }}
                      />
                    </p>
                    <label htmlFor="np-token" className="font-medium">
                      {t("projects.new.source.tokenLabel")}
                    </label>
                    <PasswordInput
                      id="np-token"
                      revealLabel={t("projects.new.source.revealToken")}
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={t("projects.new.source.tokenPlaceholder")}
                    />
                    <TokenGuide url={sourceText} />
                    <span className="text-xs text-muted-foreground">
                      {t("projects.new.source.tokenHint")}
                    </span>
                    <GitAccessTest source={sourceText} branch={branch} token={token} />
                  </div>
                )}
              </div>
            )}

            <div className="flex justify-end">
              <Button disabled={!canNextStep0 || busy} onClick={() => void createAndDetect()}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
                {projectId === null ? t("projects.new.source.createDetect") : t("projects.new.source.retry")}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 1 && detection && (
        <Card>
          <CardHeader>
            <CardTitle>{t("projects.new.detect.title")}</CardTitle>
            <CardDescription>
              {t(detection.chosenType ? "projects.new.detect.chosen" : "projects.new.detect.type")}{" "}
              <Badge variant={detection.type === "unknown" ? "destructive" : "secondary"}>
                {t(TYPE_LABELS[detection.type])}
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

            <div className="flex max-w-md flex-col gap-1.5 text-sm">
              <label htmlFor="wizard-type" className="font-medium">
                {t("projects.new.detect.typeLabel")}
              </label>
              <select
                id="wizard-type"
                data-testid="wizard-type"
                value={detection.chosenType ? detection.type : ""}
                disabled={busy}
                onChange={(e) => void chooseType(e.target.value)}
                className="h-9 rounded-md border bg-background px-2 text-sm"
              >
                <option value="">{t("projects.new.detect.typeAuto")}</option>
                {CHOOSABLE_PROJECT_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {t(TYPE_LABELS[type])}
                  </option>
                ))}
              </select>
              <span className="text-xs text-muted-foreground">{t("projects.new.detect.typeHint")}</span>
            </div>

            {(detection.type === "static" || detection.type === "static-node") && (
              <div data-testid="wizard-spa" className="flex flex-col gap-1">
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={spa} onChange={(e) => setSpa(e.target.checked)} className="h-4 w-4" />
                  {t("projects.new.detect.spa")}
                </label>
                <span className="text-xs text-muted-foreground">
                  {t("projects.new.detect.spaHint")}
                  {detection.spaSuggested ? ` ${t("projects.new.detect.spaSuggested")}` : ""}
                </span>
              </div>
            )}

            {detection.type === "unknown" && (
              <div data-testid="unsupported-help" className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
                <p className="mb-1.5 font-medium text-amber-400">{t("projects.new.detect.unsupportedTitle")}</p>
                <p className="mb-1.5 text-muted-foreground">{t("projects.new.detect.unsupportedIntro")}</p>
                <ul className="flex list-disc flex-col gap-1 pl-5 text-muted-foreground">
                  <li>
                    <Trans k="projects.new.detect.unsupportedHtml" components={{ code: <code className="font-mono text-xs" /> }} />
                  </li>
                  <li>
                    <Trans k="projects.new.detect.unsupportedNode" components={{ code: <code className="font-mono text-xs" /> }} />
                  </li>
                  <li>
                    <Trans k="projects.new.detect.unsupportedDockerfile" components={{ code: <code className="font-mono text-xs" /> }} />
                  </li>
                  <li>
                    <Trans k="projects.new.detect.unsupportedCompose" components={{ code: <code className="font-mono text-xs" /> }} />
                  </li>
                </ul>
                <p className="mt-1.5 text-muted-foreground">
                  {t("projects.new.detect.unsupportedOutro")}
                </p>
              </div>
            )}

            {detection.warnings.length > 0 && (
              <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
                <p className="mb-2 text-sm font-medium text-amber-400">
                  {t("projects.new.detect.guardrails", { n: detection.warnings.length })}
                </p>
                <ul className="flex flex-col gap-1.5">
                  {detection.warnings.map((w, i) => (
                    <WarningRow key={i} warning={w} />
                  ))}
                </ul>
              </div>
            )}

            {detection.type === "compose" && detection.services && detection.services.length > 0 && (
              <div data-testid="wizard-compose-services" className="flex flex-col gap-3">
                <p className="text-sm font-medium">{t("projects.new.detect.composeServices", { n: detection.services.length })}</p>
                <ComposeServicesList
                  services={detection.services}
                  entryService={proxyService || null}
                  entryPort={validPortText(proxyPort) ? Number(proxyPort) : null}
                />
                <ComposeEntryPicker
                  services={detection.services}
                  service={proxyService}
                  port={proxyPort}
                  onServiceChange={setProxyService}
                  onPortChange={setProxyPort}
                />
              </div>
            )}

            {detection.type === "node-server" && (
              <div data-testid="wizard-next-server" className="flex flex-col gap-3">
                <p className="text-sm font-medium">{t("projects.nextServer.title")}</p>
                <NextServerNotes detection={detection} port={null} />
                <label className="flex max-w-xs flex-col gap-1.5 text-sm">
                  {t("projects.nextServer.port")}
                  <Input
                    value={proxyPort}
                    onChange={(e) => setProxyPort(e.target.value)}
                    inputMode="numeric"
                    aria-label={t("projects.nextServer.port")}
                  />
                  <span className="text-xs text-muted-foreground">{t("projects.nextServer.portHint")}</span>
                </label>
              </div>
            )}

            {detection.type === "compose" && !(detection.services && detection.services.length > 0) && (
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="flex flex-col gap-1.5 text-sm">
                  {t("projects.new.detect.proxyService")}
                  <Input value={proxyService} onChange={(e) => setProxyService(e.target.value)} />
                </label>
                <label className="flex flex-col gap-1.5 text-sm">
                  {t("projects.new.detect.proxyPort")}
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
                <ArrowLeft className="h-4 w-4" /> {t("projects.new.back")}
              </Button>
              <Button
                disabled={
                  detection.type === "unknown" ||
                  ((detection.type === "compose" || detection.type === "node-server") &&
                    proxyPort.trim() !== "" &&
                    !validPortText(proxyPort))
                }
                onClick={() => setStep(2)}
              >
                {t("projects.new.detect.continue")} <ArrowRight className="h-4 w-4" />
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 2 && (
        <Card>
          <CardHeader>
            <CardTitle>{t("projects.new.domain.title")}</CardTitle>
            <CardDescription>{t("projects.new.domain.description")}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div
              role="radiogroup"
              aria-label={t("projects.new.domain.groupAria")}
              className={cn("grid gap-2", testAddress ? "sm:grid-cols-3" : "sm:grid-cols-2")}
            >
              <button
                type="button"
                role="radio"
                aria-checked={domainMode === "auto"}
                aria-label={t("projects.new.domain.autoTitle")}
                onClick={() => setDomainMode("auto")}
                className={cn(
                  "flex flex-col gap-1 rounded-lg border p-3 text-left text-sm",
                  domainMode === "auto" ? "border-primary bg-primary/10" : "hover:border-foreground/30",
                )}
              >
                <span className="font-medium">{t("projects.new.domain.autoTitle")}</span>
                <span className="text-xs text-muted-foreground">
                  {appsBase ? t("projects.new.domain.autoHintApps", { base: appsBase }) : t("projects.new.domain.autoHint")}
                </span>
              </button>
              {testAddress && (
                <button
                  type="button"
                  role="radio"
                  aria-checked={domainMode === "test"}
                  aria-label={t("projects.new.domain.testTitle")}
                  onClick={() => setDomainMode("test")}
                  className={cn(
                    "flex flex-col gap-1 rounded-lg border p-3 text-left text-sm",
                    domainMode === "test" ? "border-primary bg-primary/10" : "hover:border-foreground/30",
                  )}
                >
                  <span className="font-medium">{t("projects.new.domain.testTitle")}</span>
                  <span className="text-xs text-muted-foreground">{t("projects.new.domain.testHint")}</span>
                </button>
              )}
              <button
                type="button"
                role="radio"
                aria-checked={domainMode === "own"}
                aria-label={t("projects.new.domain.ownTitle")}
                onClick={() => setDomainMode("own")}
                className={cn(
                  "flex flex-col gap-1 rounded-lg border p-3 text-left text-sm",
                  domainMode === "own" ? "border-primary bg-primary/10" : "hover:border-foreground/30",
                )}
              >
                <span className="font-medium">{t("projects.new.domain.ownTitle")}</span>
                <span className="text-xs text-muted-foreground">
                  {t("projects.new.domain.ownHint")}
                </span>
              </button>
            </div>

            {domainMode !== "own" && (
              <p data-testid="auto-domain" className="rounded-md border bg-secondary/30 px-3 py-2 font-mono text-sm">
                {shownAddress.endsWith(".localhost") ? "http://" : "https://"}
                {shownAddress}
              </p>
            )}

            {showIpWarning && <IpAddressWarning onUseOwn={() => setDomainMode("own")} hasAppsDomain={appsBase !== null} />}

            {domainMode === "own" && (
              <div className="flex flex-col gap-3">
                <label htmlFor="np-own-domain" className="flex flex-col gap-1.5 text-sm">
                  {t("projects.new.domain.yourDomain")}
                  <div className="flex gap-2">
                    <Input
                      id="np-own-domain"
                      value={ownDomain}
                      onChange={(e) => {
                        setOwnDomain(e.target.value);
                        setDnsCheck(null);
                      }}
                      placeholder={t("projects.new.domain.ownPlaceholder")}
                    />
                    <Button variant="outline" disabled={busy || !ownDomain.trim()} onClick={() => void checkDns()}>
                      <Globe className="h-4 w-4" /> {t("projects.new.domain.verifyDns")}
                    </Button>
                  </div>
                </label>
                <DnsGuide domain={ownDomain} publicIp={publicIp} check={dnsCheck} pairEnabled={pairEnabled} onPairEnabledChange={setPairEnabled} />
                {dnsCheck && dnsCheck.state === undefined && (
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
                <p className="text-xs text-muted-foreground">
                  {t("projects.new.domain.propagationHint")}
                </p>
              </div>
            )}

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={websocket}
                onChange={(e) => setWebsocket(e.target.checked)}
                className="h-4 w-4"
              />
              {t("projects.new.domain.websocket")}
            </label>

            <fieldset className="flex flex-col gap-1.5 text-sm" data-testid="backup-choice">
              <legend className="mb-1 font-medium">{t("projects.new.domain.backup")}</legend>
              <div className="flex flex-wrap gap-4">
                <label className="flex items-center gap-2">
                  <input type="radio" name="backup" className="h-4 w-4" checked={backup} onChange={() => setBackup(true)} />
                  {t("projects.new.domain.backupYes")}
                </label>
                <label className="flex items-center gap-2">
                  <input type="radio" name="backup" className="h-4 w-4" checked={!backup} onChange={() => setBackup(false)} />
                  {t("projects.new.domain.backupNo")}
                </label>
              </div>
              <span className="text-xs text-muted-foreground">
                {t("projects.new.domain.backupHint")}
              </span>
            </fieldset>

            <div className="flex justify-between">
              <Button variant="outline" onClick={() => setStep(1)}>
                <ArrowLeft className="h-4 w-4" /> {t("projects.new.back")}
              </Button>
              <Button disabled={!chosenDomain || busy} onClick={() => void finish()}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
                {t("projects.new.domain.create")}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
