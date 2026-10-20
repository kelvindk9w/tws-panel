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
import { apiErrorText, t as tGlobal, useI18n, type Key } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { Link2, Loader2, X } from "lucide-react";

const DESCRIPTION: Record<ProjectEmailValueKey, Key> = {
  SMTP_HOST: "mail.links.desc.SMTP_HOST",
  SMTP_PORT: "mail.links.desc.SMTP_PORT",
  SMTP_USER: "mail.links.desc.SMTP_USER",
  SMTP_PASS: "mail.links.desc.SMTP_PASS",
  MAIL_FROM: "mail.links.desc.MAIL_FROM",
  MAIL_FROM_NAME: "mail.links.desc.MAIL_FROM_NAME",
};

interface EnvListResponse {
  vars: { key: string; value: string }[];
  compose?: { variables: ComposeVariable[] } | null;
  /** Nomes do .env.example (e variações) do código — o app pode lê-los por env_file. */
  example?: { files: string[]; variables: EnvExampleVariable[] } | null;
}


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
  for (const v of env?.compose?.variables ?? []) add(v.name, tGlobal("mail.links.hint.compose"));
  for (const v of env?.example?.variables ?? []) add(v.name, tGlobal("mail.links.hint.file", { file: v.file }));
  for (const v of env?.vars ?? []) add(v.key, tGlobal("mail.links.hint.vars"));
  for (const name of delivered) if (!hints.has(name)) hints.set(name, []);
  const enabled: ComboboxOption[] = [];
  const disabled: ComboboxOption[] = [];
  for (const [name, h] of [...hints.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const problem = envLinkNameProblem(name);
    if (problem === null) {
      enabled.push({ value: name, label: name, hint: h.join(" · ") });
    } else if ((PROJECT_EMAIL_VALUE_KEYS as readonly string[]).includes(name.toUpperCase())) {
      disabled.push({ value: name, label: name, hint: [...h, tGlobal("mail.links.hint.panel")].join(" · "), disabled: true });
    } else if (/reservado/.test(problem)) {
      disabled.push({ value: name, label: name, hint: tGlobal("mail.links.hint.reserved"), disabled: true });
    }
    // nome fora do padrão (não deveria vir de nenhuma fonte): não entra
  }
  return [{ value: "", label: tGlobal("mail.links.sameName") }, ...enabled, ...disabled];
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
  const { t, locale } = useI18n();
  const [rows, setRows] = useState<Record<string, string>>(() => initialRows(email.envLinks));
  const [env, setEnv] = useState<EnvListResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<EnvListResponse>(`/api/projects/${projectId}/env`)
      .then(setEnv)
      .catch(() => setLoadError(t("mail.links.loadError")));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    // o Esc de uma lista aberta só fecha a lista (ela marca o evento)
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !e.defaultPrevented && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const keys = PROJECT_EMAIL_VALUE_KEYS.filter((k) => email.env[k] !== undefined);

  const delivered = keys.join(",");
  const options: ComboboxOption[] = useMemo(() => linkOptions(env, delivered.split(",")), [env, delivered, locale]);

  // Já salvas em Variáveis (com valor ou vazias): com a ligação, o deploy ignora o valor de lá
  const saved = new Set((env?.vars ?? []).map((v) => v.key));
  const counts = new Map<string, number>();
  for (const k of keys) {
    const chosen = rows[k];
    if (chosen) counts.set(chosen, (counts.get(chosen) ?? 0) + 1);
  }
  const problems: Record<string, string | null> = {};
  for (const k of keys) {
    const chosen = rows[k];
    problems[k] = !chosen
      ? null
      : envLinkNameProblem(chosen) ?? ((counts.get(chosen) ?? 0) > 1 ? t("mail.links.duplicate", { name: chosen }) : null);
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
      setError(err instanceof ApiRequestError ? apiErrorText(err, "mail.links.saveError") : t("mail.links.saveError"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("mail.links.title")}
        className="max-h-[90vh] w-full max-w-2xl overflow-auto rounded-lg border bg-background p-4 shadow-lg sm:p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-2">
          <h2 className="flex min-w-0 items-center gap-2 text-lg font-semibold">
            <Link2 className="h-4 w-4 shrink-0" /> {t("mail.links.title")}
          </h2>
          <Button variant="ghost" size="icon" aria-label={t("mail.common.close")} onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <p className="mb-4 text-sm text-muted-foreground">
          {t("mail.links.intro")}
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
                  <p className="text-xs text-muted-foreground">{t(DESCRIPTION[k])}</p>
                </div>
                <div className="flex min-w-0 flex-col gap-1">
                  <Combobox
                    aria-label={t("mail.links.selectAria", { key: k })}
                    options={options}
                    value={target}
                    onChange={(v) => setRows((prev) => ({ ...prev, [k]: v }))}
                    allowCreate
                    createLabel={(q) => t("mail.links.createLabel", { name: q })}
                    placeholder={t("mail.links.sameName")}
                  />
                  {problems[k] && <p className="text-xs text-red-300">{problems[k]}</p>}
                  {!problems[k] && target && saved.has(target) && (
                    <p className="text-xs text-amber-300">
                      {t("mail.links.alsoSaved", { name: target })}
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
            {t("mail.common.cancel")}
          </Button>
          <Button variant="success" size="sm" disabled={busy || blocked} onClick={() => void save()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
            {t("mail.links.save")}
          </Button>
        </div>
      </div>
    </div>
  );
}
