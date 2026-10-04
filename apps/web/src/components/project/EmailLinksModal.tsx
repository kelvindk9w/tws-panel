/**
 * "Ligar às variáveis do projeto": o app do projeto usa outros nomes
 * (SMTP_SENHA, EMAIL_DE…). Para cada valor que o e-mail do projeto fornece,
 * a pessoa escolhe — numa lista com busca — qual variável do projeto o
 * recebe. O painel guarda só essa ligação, nunca uma cópia do valor: no
 * deploy, entrega o valor atual também com o nome escolhido (a senha
 * trocada chega sozinha no deploy seguinte).
 */
import { useEffect, useMemo, useState } from "react";
import {
  PROJECT_EMAIL_VALUE_KEYS,
  envLinkNameProblem,
  type ComposeVariable,
  type EnvExampleVariable,
  type ProjectEmailConfig,
  type ProjectEmailResponse,
  type ProjectEmailValueKey,
} from "@paas/core";
import { ApiRequestError, apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { Link2, Loader2, X } from "lucide-react";

const DESCRIPTION: Record<ProjectEmailValueKey, string> = {
  SMTP_HOST: "servidor de envio",
  SMTP_PORT: "porta",
  SMTP_USER: "usuário (a caixa do projeto)",
  SMTP_PASS: "senha da caixa (nunca aparece)",
  MAIL_FROM: "endereço de envio",
  MAIL_FROM_NAME: "nome de exibição",
};

interface EnvListResponse {
  vars: { key: string; value: string }[];
  compose?: { variables: ComposeVariable[] } | null;
  /** Nomes do .env.example (e variações) do código — o app pode lê-los por env_file. */
  example?: { files: string[]; variables: EnvExampleVariable[] } | null;
}

const PANEL_HINT = "o painel já entrega com este nome";

/**
 * Opções do seletor: as variáveis do compose, do .env.example e das
 * Variáveis, com a origem como dica. Nomes que o painel já entrega e nomes
 * reservados aparecem DESABILITADOS com o motivo (sumir confundia: "digitei
 * MAIL_FROM_NAME e não achou"). Escolhíveis primeiro, em ordem alfabética.
 */
function linkOptions(env: EnvListResponse | null, delivered: readonly string[]): ComboboxOption[] {
  const hints = new Map<string, string[]>();
  const add = (name: string, hint: string) => {
    const list = hints.get(name) ?? [];
    if (!list.includes(hint)) hints.set(name, [...list, hint]);
  };
  for (const v of env?.compose?.variables ?? []) add(v.name, "do compose");
  for (const v of env?.example?.variables ?? []) add(v.name, `do ${v.file}`);
  for (const v of env?.vars ?? []) add(v.key, "nas Variáveis");
  for (const name of delivered) if (!hints.has(name)) hints.set(name, []);
  const enabled: ComboboxOption[] = [];
  const disabled: ComboboxOption[] = [];
  for (const [name, h] of [...hints.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const problem = envLinkNameProblem(name);
    if (problem === null) {
      enabled.push({ value: name, label: name, hint: h.join(" · ") });
    } else if ((PROJECT_EMAIL_VALUE_KEYS as readonly string[]).includes(name.toUpperCase())) {
      disabled.push({ value: name, label: name, hint: [...h, PANEL_HINT].join(" · "), disabled: true });
    } else if (/reservado/.test(problem)) {
      disabled.push({ value: name, label: name, hint: "nome reservado (compose, Docker ou sistema)", disabled: true });
    }
    // nome fora do padrão (não deveria vir de nenhuma fonte): não entra
  }
  return [{ value: "", label: "mesmo nome (padrão)" }, ...enabled, ...disabled];
}

/** Valor do e-mail → variável escolhida ("" = só o nome padrão). */
function initialRows(links: Record<string, ProjectEmailValueKey> | undefined): Record<string, string> {
  const rows: Record<string, string> = {};
  for (const [target, source] of Object.entries(links ?? {})) rows[source] ??= target;
  return rows;
}

export function EmailLinksModal({
  projectId,
  email,
  onClose,
  onSaved,
}: {
  projectId: string;
  email: ProjectEmailConfig;
  onClose: () => void;
  onSaved: (email: ProjectEmailConfig) => void;
}) {
  const [rows, setRows] = useState<Record<string, string>>(() => initialRows(email.envLinks));
  const [env, setEnv] = useState<EnvListResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<EnvListResponse>(`/api/projects/${projectId}/env`)
      .then(setEnv)
      .catch(() => setLoadError("Não foi possível carregar as variáveis do projeto. Você ainda pode digitar o nome."));
  }, [projectId]);

  useEffect(() => {
    // o Esc de uma lista aberta só fecha a lista (ela marca o evento)
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !e.defaultPrevented && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const keys = PROJECT_EMAIL_VALUE_KEYS.filter((k) => email.env[k] !== undefined);

  const delivered = keys.join(",");
  const options: ComboboxOption[] = useMemo(() => linkOptions(env, delivered.split(",")), [env, delivered]);

  // Já salvas em Variáveis (com valor ou vazias): com a ligação, o deploy ignora o valor de lá
  const saved = new Set((env?.vars ?? []).map((v) => v.key));
  const counts = new Map<string, number>();
  for (const k of keys) {
    const t = rows[k];
    if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const problems: Record<string, string | null> = {};
  for (const k of keys) {
    const t = rows[k];
    problems[k] = !t ? null : envLinkNameProblem(t) ?? ((counts.get(t) ?? 0) > 1 ? `${t} escolhida em mais de uma linha.` : null);
  }
  const blocked = Object.values(problems).some((p) => p !== null);

  async function save() {
    const links: Record<string, ProjectEmailValueKey> = {};
    for (const k of keys) if (rows[k]) links[rows[k]!] = k;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<ProjectEmailResponse>(`/api/projects/${projectId}/email/links`, {
        method: "PUT",
        body: JSON.stringify({ links }),
      });
      onSaved(res.email);
      onClose();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Não foi possível salvar as ligações.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Ligar às variáveis do projeto"
        className="max-h-[90vh] w-full max-w-2xl overflow-auto rounded-lg border bg-background p-4 shadow-lg sm:p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-2">
          <h2 className="flex min-w-0 items-center gap-2 text-lg font-semibold">
            <Link2 className="h-4 w-4 shrink-0" /> Ligar às variáveis do projeto
          </h2>
          <Button variant="ghost" size="icon" aria-label="Fechar" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <p className="mb-4 text-sm text-muted-foreground">
          Seu app usa outros nomes? Escolha qual variável do projeto recebe cada valor. O painel não copia nada para as
          Variáveis: no deploy, ele entrega o valor atual com o nome escolhido (e continua entregando o nome padrão).
          Trocou a senha? O app recebe a nova no próximo deploy.
        </p>
        {loadError && <p className="mb-3 text-sm text-amber-300">{loadError}</p>}
        {!env && !loadError && <Loader2 className="mb-3 h-4 w-4 animate-spin text-muted-foreground" />}
        <ul className="flex flex-col gap-3">
          {keys.map((k) => {
            const target = rows[k] ?? "";
            return (
              <li key={k} className="flex flex-col gap-1 sm:grid sm:grid-cols-[11rem_1fr] sm:items-start sm:gap-3">
                <div className="min-w-0 pt-1.5">
                  <p className="font-mono text-sm text-emerald-300">{k}</p>
                  <p className="text-xs text-muted-foreground">{DESCRIPTION[k]}</p>
                </div>
                <div className="flex min-w-0 flex-col gap-1">
                  <Combobox
                    aria-label={`Variável que recebe ${k}`}
                    options={options}
                    value={target}
                    onChange={(v) => setRows((prev) => ({ ...prev, [k]: v }))}
                    allowCreate
                    createLabel={(q) => `Usar o nome novo ${q}`}
                    placeholder="mesmo nome (padrão)"
                  />
                  {problems[k] && <p className="text-xs text-red-300">{problems[k]}</p>}
                  {!problems[k] && target && saved.has(target) && (
                    <p className="text-xs text-amber-300">
                      {target} também está salva em Variáveis: com a ligação, o deploy usa o valor do e-mail e ignora o
                      de lá. Se quiser, apague-a lá.
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="success" size="sm" disabled={busy || blocked} onClick={() => void save()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
            Salvar ligações
          </Button>
        </div>
      </div>
    </div>
  );
}
