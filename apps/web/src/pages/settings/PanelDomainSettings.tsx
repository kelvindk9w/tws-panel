import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { CertificateItem, PanelDomainDnsCheck, PanelDomainStatus, PanelDomainVerifyResponse } from "@paas/core";
import { apiFetch, ApiRequestError } from "@/lib/api";
import { pageLocation } from "@/lib/page-location";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { CopyButton } from "@/components/mail/CopyButton";
import { CertificateCard } from "@/pages/CertificatesPage";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Globe,
  Loader2,
  Lock,
  RefreshCw,
  RotateCcw,
  ShieldOff,
  Terminal,
  Trash2,
} from "lucide-react";

const PATH = "/api/settings/panel-domain";
const SWITCH_TO_HTTPS = "cd /opt/tws-panel && sudo ./scripts/install.sh --acesso=https";

function errorText(err: unknown, fallback: string): string {
  return err instanceof ApiRequestError ? err.message : fallback;
}

function certificateValid(item: CertificateItem | null): boolean {
  return item !== null && (item.state === "valid" || item.state === "expiring");
}

/** Comando de terminal com botão de copiar (quebra a linha no celular). */
function Command({ text, testId }: { text: string; testId?: string }) {
  return (
    <div className="flex items-start gap-1 rounded-md border bg-muted/40 px-3 py-2" data-testid={testId}>
      <code className="min-w-0 flex-1 break-all font-mono text-xs">{text}</code>
      <CopyButton text={text} ariaLabel="Copiar o comando" />
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="flex min-w-0 items-center gap-1">
        <code className="min-w-0 break-all font-mono text-sm">{value}</code>
        <CopyButton text={value} ariaLabel={`Copiar ${label.toLowerCase()}`} />
      </span>
    </div>
  );
}

function DnsResult({ check }: { check: PanelDomainDnsCheck }) {
  return (
    <p
      data-testid="dns-result"
      className={
        check.ok
          ? "flex items-start gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-400"
          : "flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-400"
      }
    >
      {check.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}
      <span>{check.message}</span>
    </p>
  );
}

function Section({ title, icon, description, children }: { title: string; icon: ReactNode; description?: ReactNode; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          {icon} {title}
        </CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">{children}</CardContent>
    </Card>
  );
}

/**
 * Configurações → Domínio do painel. O painel nasce em
 * https://<ip-com-hífens>.sslip.io (o endereço tem o IP da VPS no nome).
 * Aqui a pessoa usa um domínio seu: registro A → Verificar DNS → o painel
 * responde nos dois endereços e emite o certificado → abrir pelo endereço
 * novo e entrar de novo → (opcional) desativar o acesso pelo IP, com volta
 * pela tela ou por SSH.
 */
export function PanelDomainSettings() {
  const [status, setStatus] = useState<PanelDomainStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "verify" | "remove" | "disable" | "enable" | "refresh" | null>(null);
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState("");
  const [lastCheck, setLastCheck] = useState<PanelDomainDnsCheck | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [typed, setTyped] = useState("");

  const load = useCallback(async () => {
    try {
      const s = await apiFetch<PanelDomainStatus>(PATH);
      setStatus(s);
      setLastCheck(s.lastCheck);
      setLoadError(null);
    } catch {
      setLoadError("Não foi possível consultar o domínio do painel. Recarregue a página.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(kind: NonNullable<typeof busy>, fn: () => Promise<void>, fallback: string) {
    setBusy(kind);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorText(err, fallback));
    } finally {
      setBusy(null);
    }
  }

  function save(event: FormEvent) {
    event.preventDefault();
    void act(
      "save",
      async () => {
        const s = await apiFetch<PanelDomainStatus>(PATH, { method: "PUT", body: JSON.stringify({ domain: input.trim() }) });
        setStatus(s);
        setLastCheck(s.lastCheck);
        setEditing(false);
      },
      "Não foi possível salvar o domínio.",
    );
  }

  const verify = () =>
    act(
      "verify",
      async () => {
        const r = await apiFetch<PanelDomainVerifyResponse>(`${PATH}/verify`, { method: "POST" });
        setStatus(r.status);
        setLastCheck(r.check);
      },
      "Não foi possível verificar o DNS.",
    );

  const remove = () =>
    act(
      "remove",
      async () => {
        const s = await apiFetch<PanelDomainStatus>(PATH, { method: "DELETE" });
        setStatus(s);
        setLastCheck(null);
        setConfirmRemove(false);
        setInput("");
      },
      "Não foi possível remover o domínio.",
    );

  const disableIp = () =>
    act(
      "disable",
      async () => {
        const s = await apiFetch<PanelDomainStatus>(`${PATH}/disable-ip`, {
          method: "POST",
          body: JSON.stringify({ confirm: typed.trim() }),
        });
        setStatus(s);
        setConfirmDisable(false);
        setTyped("");
      },
      "Não foi possível desativar o acesso pelo IP.",
    );

  const enableIp = () =>
    act(
      "enable",
      async () => setStatus(await apiFetch<PanelDomainStatus>(`${PATH}/enable-ip`, { method: "POST" })),
      "Não foi possível reativar o acesso pelo IP.",
    );

  const refresh = () => act("refresh", load, "Não foi possível conferir de novo.");

  if (loadError) {
    return (
      <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        {loadError}
      </p>
    );
  }
  if (!status) return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;

  const errorBox = error && (
    <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      {error}
    </p>
  );

  if (status.mode === "tunnel") {
    return (
      <Section title="Domínio do painel" icon={<Globe className="h-4 w-4" />}>
        <div data-testid="tunnel-mode" className="flex flex-col gap-3">
          <p>
            Este painel foi instalado no modo <strong>túnel SSH</strong>: ele só abre pelo túnel, no seu computador, e não tem
            endereço na internet. Por isso não há domínio para configurar — e nenhum IP aparece em endereço nenhum.
          </p>
          <p>
            Para abrir o painel por um endereço na internet (com HTTPS) e depois usar um domínio seu, mude o acesso para
            HTTPS rodando na VPS, por SSH:
          </p>
          <Command text={SWITCH_TO_HTTPS} />
          <p className="text-xs text-muted-foreground">
            O instalador mantém usuários, projetos e configurações; ele só passa a publicar o painel em
            https://&lt;ip-com-hífens&gt;.sslip.io pelas portas 80 e 443. Depois disso, volte a esta tela.
          </p>
        </div>
      </Section>
    );
  }

  const domain = status.domain;
  const valid = certificateValid(status.certificate);
  // O navegador comprova que o endereço novo funciona: além do servidor, a
  // própria página precisa estar aberta nele.
  const browserOnDomain = domain !== null && pageLocation().hostname.toLowerCase() === domain;
  const canDisable = status.disableIp.allowed && browserOnDomain;
  const showForm = !domain || editing;

  return (
    <div className="flex flex-col gap-6">
      <Section
        title="Endereço do painel"
        icon={<Globe className="h-4 w-4" />}
        description="Por onde o painel abre hoje. O endereço automático tem o IP da VPS no nome: com um domínio seu, ele fica mais discreto e fácil de lembrar."
      >
        <ul data-testid="panel-addresses" className="flex flex-col gap-2">
          {status.addresses.map((a) => (
            <li key={a} className="flex flex-wrap items-center gap-2">
              <span className="break-all font-mono text-sm">https://{a}</span>
              {a === status.ipAddress ? <Badge variant="warning">pelo IP</Badge> : <Badge variant="success">seu domínio</Badge>}
              {a === status.currentHost && <Badge variant="outline">esta página</Badge>}
            </li>
          ))}
        </ul>
        {status.ipAccessDisabled && status.ipAddress && (
          <p className="text-xs text-muted-foreground">
            O endereço https://{status.ipAddress} está desativado: o painel não responde mais nele.
          </p>
        )}
      </Section>

      <Section
        title="Seu domínio"
        icon={<Lock className="h-4 w-4" />}
        description="Use um subdomínio só para o painel, como painel.exemplo.com.br."
      >
        {showForm ? (
          <form onSubmit={save} className="flex max-w-lg flex-col gap-3">
            <label htmlFor="panel-domain" className="font-medium">
              Domínio do painel
            </label>
            <Input
              id="panel-domain"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="painel.exemplo.com.br"
              autoComplete="off"
              spellCheck={false}
              inputMode="url"
            />
            {editing && status.ipAccessDisabled && (
              <p className="text-xs text-amber-400">
                Ao trocar, o acesso pelo IP volta (https://{status.ipAddress}) até o domínio novo ficar pronto. Você vai precisar
                entrar de novo lá.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={busy !== null || input.trim() === ""}>
                {busy === "save" && <Loader2 className="h-4 w-4 animate-spin" />}
                Salvar domínio
              </Button>
              {editing && (
                <Button type="button" variant="outline" onClick={() => setEditing(false)}>
                  Cancelar
                </Button>
              )}
            </div>
          </form>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="break-all font-mono">{domain}</span>
              {status.domainActive ? (
                <Badge variant="success">DNS conferido</Badge>
              ) : (
                <Badge variant="warning">aguardando o DNS</Badge>
              )}
            </div>

            {!status.domainActive && (
              <>
                <p>No seu provedor de DNS, crie este registro:</p>
                <div data-testid="dns-record" className="grid grid-cols-1 gap-3 rounded-md border px-3 py-3 sm:grid-cols-3">
                  <Field label="Tipo" value="A" />
                  <Field label="Nome" value={domain!} />
                  <Field label="Valor (IP da VPS)" value={status.serverIp ?? "IP da VPS"} />
                </div>
                <p className="text-xs text-muted-foreground">
                  No Cloudflare, deixe a nuvem cinza (“Somente DNS”): com a nuvem laranja o certificado não sai. Se houver um
                  registro AAAA com esse nome, apague. A propagação costuma levar de minutos a algumas horas.
                </p>
              </>
            )}

            {lastCheck && <DnsResult check={lastCheck} />}

            <div className="flex flex-wrap gap-2">
              {!status.domainActive && (
                <Button variant="info" disabled={busy !== null} onClick={() => void verify()}>
                  {busy === "verify" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                  Verificar DNS
                </Button>
              )}
              <Button
                variant="outline"
                disabled={busy !== null}
                onClick={() => {
                  setInput(domain ?? "");
                  setEditing(true);
                  setConfirmRemove(false);
                }}
              >
                Trocar domínio
              </Button>
              {!confirmRemove && (
                <Button variant="danger" disabled={busy !== null} onClick={() => setConfirmRemove(true)}>
                  <Trash2 className="h-4 w-4" /> Remover domínio
                </Button>
              )}
            </div>

            {confirmRemove && (
              <div data-testid="remove-confirm" className="flex flex-col gap-2 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-3">
                <p>
                  O painel deixa de responder em https://{domain} e volta a abrir só por https://{status.ipAddress}
                  {status.ipAccessDisabled ? " (o acesso pelo IP é reativado)" : ""}. Se você está nesta página pelo domínio,
                  vai precisar entrar de novo no endereço do IP.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" onClick={() => setConfirmRemove(false)} disabled={busy !== null}>
                    Cancelar
                  </Button>
                  <Button variant="danger" onClick={() => void remove()} disabled={busy !== null}>
                    {busy === "remove" && <Loader2 className="h-4 w-4 animate-spin" />}
                    Sim, remover
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
        {errorBox}
      </Section>

      {domain && status.domainActive && (
        <Section
          title="Certificado HTTPS"
          icon={<Lock className="h-4 w-4" />}
          description="Emitido sozinho pelo Let's Encrypt assim que o domínio entra no proxy. Costuma levar de segundos a 2 minutos."
        >
          {status.certificate ? (
            <ul>
              <CertificateCard
                item={status.certificate}
                onItem={(item) => setStatus((s) => (s ? { ...s, certificate: item } : s))}
                pollMs={10_000}
                pollMaxMs={120_000}
              />
            </ul>
          ) : (
            <p className="text-muted-foreground">Ainda não deu para conferir o certificado. Clique em “Conferir de novo”.</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void refresh()}>
              {busy === "refresh" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Conferir de novo
            </Button>
          </div>
          {valid && !browserOnDomain && (
            <div className="flex flex-col gap-2 rounded-md border border-sky-500/30 bg-sky-500/5 px-3 py-3">
              <Button variant="info" asChild className="h-auto min-h-9 self-start whitespace-normal py-2 text-left">
                <a href={`https://${domain}/settings/panel-domain`}>
                  <ExternalLink className="h-4 w-4" /> Abrir o painel pelo endereço novo
                </a>
              </Button>
              <p className="text-xs text-muted-foreground">
                Lá você vai precisar entrar de novo (usuário, senha e código): a sessão vale só no endereço em que você entrou.
                Este endereço continua funcionando.
              </p>
            </div>
          )}
        </Section>
      )}

      <Section
        title="Acesso pelo IP"
        icon={<ShieldOff className="h-4 w-4" />}
        description={`O endereço https://${status.ipAddress} mostra o IP da VPS. Depois que o domínio novo funcionar, você pode desativá-lo.`}
      >
        {status.ipAccessDisabled ? (
          <div className="flex flex-col gap-3">
            <p>O acesso pelo IP está desativado: o painel responde só em https://{domain}.</p>
            <Button variant="success" className="self-start" disabled={busy !== null} onClick={() => void enableIp()}>
              {busy === "enable" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
              Reativar o acesso pelo IP
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {!confirmDisable && (
              <Button
                variant="danger"
                className="self-start"
                disabled={busy !== null || !canDisable}
                onClick={() => setConfirmDisable(true)}
              >
                <ShieldOff className="h-4 w-4" /> Desativar o acesso pelo IP
              </Button>
            )}
            {!canDisable && (
              <ul data-testid="disable-ip-blockers" className="flex list-disc flex-col gap-1 pl-5 text-xs text-muted-foreground">
                {(status.disableIp.blockers.length
                  ? status.disableIp.blockers
                  : [`Abra o painel pelo endereço novo (https://${domain ?? "seu domínio"}) para liberar o botão.`]
                ).map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            )}
            {confirmDisable && (
              <div data-testid="disable-ip-confirm" className="flex flex-col gap-3 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-3">
                <p>
                  O painel vai responder <strong>só</strong> em https://{domain}. O endereço https://{status.ipAddress} deixa de
                  abrir. Se um dia o domínio parar de funcionar (DNS apagado, domínio vencido), reative pelo SSH da VPS com:
                </p>
                <Command text={status.reactivateCommand} testId="reactivate-command" />
                <label htmlFor="disable-confirm" className="font-medium">
                  Digite {domain} para confirmar
                </label>
                <Input
                  id="disable-confirm"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" onClick={() => setConfirmDisable(false)} disabled={busy !== null}>
                    Cancelar
                  </Button>
                  <Button
                    variant="danger"
                    disabled={busy !== null || typed.trim().toLowerCase() !== domain}
                    onClick={() => void disableIp()}
                  >
                    {busy === "disable" && <Loader2 className="h-4 w-4 animate-spin" />}
                    Desativar agora
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
        {!confirmDisable && (
          <div className="flex flex-col gap-2">
            <p className="flex items-center gap-2 font-medium">
              <Terminal className="h-4 w-4" /> Se perder o acesso pelo domínio
            </p>
            <p className="text-xs text-muted-foreground">Entre na VPS por SSH e rode o comando abaixo: ele reativa o endereço pelo IP.</p>
            <Command text={status.reactivateCommand} testId="reactivate-command" />
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          A escolha fica gravada em {status.configFile} e vale também depois de reiniciar o painel ou a VPS.
        </p>
      </Section>
    </div>
  );
}
