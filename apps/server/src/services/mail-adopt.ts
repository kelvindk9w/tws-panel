/**
 * mail-adopt.ts — o que o painel cadastra a partir do que o Stalwart tem.
 *
 * O painel lista domínios e caixas do SEU cadastro (data/mail/mail.json), não
 * do Stalwart. Depois de restaurar o backup do e-mail, o Stalwart volta com os
 * domínios e caixas de antes e o cadastro não os conhece. Esta regra decide,
 * sem rede e sem disco, o que falta cadastrar. Nunca recebe senhas: a entrada
 * já vem sem `secrets` (ver StalwartClient.listPrincipals).
 */
import type { StalwartPrincipalSummary } from "@paas/mailer";

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const LOCAL_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export interface PlannedMailbox {
  id: string;
  localPart: string;
  domain: string;
  /** postmaster@ é do sistema (protegida); a de um projeto vem com `projectId`. */
  kind: "user" | "project" | "system";
  projectId?: string;
}

export interface AdoptionPlan {
  /** Domínios do Stalwart que o painel não conhecia. */
  domains: string[];
  /** Caixas do Stalwart que o painel não conhecia (alias não conta como caixa). */
  mailboxes: PlannedMailbox[];
  /** Nomes que o Stalwart tem e o painel não consegue cadastrar (só nomes, nunca dados da conta). */
  skipped: string[];
}

export function planAdoption(input: {
  domains: readonly string[];
  mailboxes: readonly StalwartPrincipalSummary[];
  knownDomains: ReadonlySet<string>;
  knownMailboxes: ReadonlySet<string>;
  projects: ReadonlyArray<{ id: string; slug: string }>;
}): AdoptionPlan {
  const skipped: string[] = [];
  const domains: string[] = [];
  const available = new Set(input.knownDomains);
  for (const raw of input.domains) {
    const name = raw.trim().toLowerCase();
    if (input.knownDomains.has(name) || domains.includes(name)) continue;
    if (!DOMAIN_RE.test(name)) {
      skipped.push(name);
      continue;
    }
    domains.push(name);
    available.add(name);
  }

  // endereço → quem é o dono dele (postmaster@ tem abuse@ e dmarc@ como endereços, não como caixas)
  const aliasOwner = new Map<string, string>();
  for (const p of input.mailboxes) for (const e of p.emails) if (e !== p.name) aliasOwner.set(e, p.name);
  const projectBySlug = new Map(input.projects.map((p) => [p.slug, p.id]));

  const mailboxes: PlannedMailbox[] = [];
  const seen = new Set<string>();
  for (const principal of input.mailboxes) {
    const id = principal.name.trim().toLowerCase();
    if (input.knownMailboxes.has(id) || seen.has(id)) continue;
    if (aliasOwner.has(id)) continue;
    const parts = id.split("@");
    const local = parts[0] ?? "";
    const domain = parts[1] ?? "";
    if (parts.length !== 2 || !LOCAL_RE.test(local) || local.includes("..") || !available.has(domain)) {
      skipped.push(id);
      continue;
    }
    seen.add(id);
    const projectId = projectBySlug.get(local);
    if (local === "postmaster") mailboxes.push({ id, localPart: local, domain, kind: "system" });
    else if (projectId !== undefined) mailboxes.push({ id, localPart: local, domain, kind: "project", projectId });
    else mailboxes.push({ id, localPart: local, domain, kind: "user" });
  }
  return { domains, mailboxes, skipped };
}
