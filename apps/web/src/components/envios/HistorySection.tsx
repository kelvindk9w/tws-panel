import { useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import type { MailDeliveryState, MailHistoryResponse } from "@paas/core";
import { ApiRequestError, apiFetch } from "@/lib/api";
import { formatDateTime, HISTORY_STATE_LABELS, rejectionHint, senderLabel, stateVariant } from "@/lib/envios";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

const PAGE = 100;
const selectClass =
  "h-9 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

interface Filters {
  days: string;
  state: "" | MailDeliveryState;
  projectId: string;
  mailbox: string;
  domain: string;
  q: string;
}

function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}

/** Histórico: entregues, recusadas e adiadas, com o motivo devolvido pelo destino. */
export function HistorySection() {
  const [filters, setFilters] = useState<Filters>({ days: "7", state: "", projectId: "", mailbox: "", domain: "", q: "" });
  const [search, setSearch] = useState("");
  const [data, setData] = useState<MailHistoryResponse | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const first = useRef(true);

  // Busca digitada: espera a pessoa parar de digitar.
  useEffect(() => {
    const t = setTimeout(() => setFilters((f) => (f.q === search ? f : { ...f, q: search })), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    let cancelled = false;
    const qs = new URLSearchParams({ days: filters.days, limit: String(limit) });
    for (const key of ["state", "projectId", "mailbox", "domain", "q"] as const) {
      if (filters[key]) qs.set(key, filters[key]);
    }
    // Na primeira vez e no "Atualizar", o servidor lê o registro antes.
    if (first.current || reloadKey > 0) qs.set("refresh", "1");
    first.current = false;
    setLoading(true);
    setError(null);
    apiFetch<MailHistoryResponse>(`/api/mail/envios/history?${qs.toString()}`)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiRequestError ? err.message : "Não deu para ler o histórico.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filters, limit, reloadKey]);

  const set = (key: keyof Filters) => (e: React.ChangeEvent<HTMLSelectElement>) => {
    setLimit(PAGE);
    setFilters((f) => ({ ...f, [key]: e.target.value }));
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Histórico</CardTitle>
        <CardDescription>
          O resultado de cada entrega, com a resposta do servidor do destinatário. Guardamos só o envelope (remetente, destino e
          resposta), nunca o conteúdo, por {data?.retentionDays ?? 30} dias.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <Field id="h-days" label="Período">
            <select id="h-days" className={selectClass} value={filters.days} onChange={set("days")}>
              <option value="1">Últimas 24 horas</option>
              <option value="7">Últimos 7 dias</option>
              <option value="14">Últimos 14 dias</option>
              <option value="30">Últimos 30 dias</option>
            </select>
          </Field>
          <Field id="h-state" label="Estado">
            <select id="h-state" className={selectClass} value={filters.state} onChange={set("state")}>
              <option value="">Todos</option>
              {(Object.keys(HISTORY_STATE_LABELS) as MailDeliveryState[]).map((s) => (
                <option key={s} value={s}>
                  {HISTORY_STATE_LABELS[s]}
                </option>
              ))}
            </select>
          </Field>
          <Field id="h-project" label="Projeto">
            <select id="h-project" className={selectClass} value={filters.projectId} onChange={set("projectId")}>
              <option value="">Todos</option>
              {data?.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
              <option value="none">Sem projeto</option>
            </select>
          </Field>
          <Field id="h-mailbox" label="Caixa">
            <select id="h-mailbox" className={selectClass} value={filters.mailbox} onChange={set("mailbox")}>
              <option value="">Todas</option>
              {data?.mailboxes.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </Field>
          <Field id="h-domain" label="Domínio de destino">
            <select id="h-domain" className={selectClass} value={filters.domain} onChange={set("domain")}>
              <option value="">Todos</option>
              {data?.domains.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </Field>
          <Field id="h-q" label="Buscar">
            <Input id="h-q" value={search} placeholder="endereço ou motivo" maxLength={100} onChange={(e) => setSearch(e.target.value)} />
          </Field>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" disabled={loading} onClick={() => setReloadKey((k) => k + 1)}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Atualizar
          </Button>
          {data?.collectedAt && <span className="text-xs text-muted-foreground">Registro lido em {formatDateTime(data.collectedAt)}</span>}
        </div>
        {data?.collectError && (
          <p className="break-words rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
            Não deu para ler o registro do servidor de e-mail: {data.collectError}
          </p>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
        {data && data.items.length === 0 && <p className="text-sm text-muted-foreground">Nenhum envio encontrado com esses filtros.</p>}
        {data && data.items.length > 0 && (
          <>
            <p className="text-xs text-muted-foreground">
              Mostrando {data.items.length} de {data.total}.
            </p>
            <ul className="flex flex-col gap-2">
              {data.items.map((i, idx) => {
                const hint = i.state === "delivered" ? null : rejectionHint(i.detail);
                return (
                  <li key={`${i.queueId}-${i.to}-${i.at}-${idx}`} data-testid={`history-${i.queueId}-${i.to}`} className="flex flex-col gap-1 rounded-lg border p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={stateVariant(i.state)}>{HISTORY_STATE_LABELS[i.state]}</Badge>
                      <span className="break-all font-medium">{i.to}</span>
                      <span className="text-xs text-muted-foreground">{formatDateTime(i.at)}</span>
                    </div>
                    <p className="break-words text-xs text-muted-foreground">De: {senderLabel(i.sender)}</p>
                    {i.detail && (
                      <p className="break-words text-xs">
                        {i.remoteHost ? `${i.remoteHost} respondeu: ` : "Motivo: "}
                        {i.detail}
                      </p>
                    )}
                    {i.state === "deferred" && i.nextRetryAt && (
                      <p className="text-xs text-muted-foreground">Nova tentativa marcada para {formatDateTime(i.nextRetryAt)}.</p>
                    )}
                    {hint && <p className="text-xs text-amber-300">{hint}</p>}
                  </li>
                );
              })}
            </ul>
            {data.total > data.items.length && (
              <div>
                <Button size="sm" variant="outline" disabled={loading} onClick={() => setLimit((l) => l + PAGE)}>
                  Carregar mais
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
