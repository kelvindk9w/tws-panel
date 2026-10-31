/**
 * mail-services.ts — quais serviços do compose entram na rede de e-mail e recebem o SMTP_*.
 * Banco e cache ficam de fora (ver @paas/core mail-network.ts): a regra é a mesma para a rede, para o env injetado e
 * para os containers que já rodam.
 */
import path from "node:path";
import { mailLabelValue, mailServiceDecision, TWS_LABEL_MAIL, type MailServiceDecision } from "@paas/core";
import { composeServiceDefs, networkOwner } from "./compose-override.js";
import { dockerfileFinalBaseImage, DOCKERFILE_MAX_BYTES } from "./dockerfile.js";
import { readRegularFileLimited } from "./safe-fs.js";

export interface MailServiceSelection {
  included: string[];
  excluded: Array<{ service: string; decision: MailServiceDecision }>;
  /** Incluídos só por causa da label `tws.mail=true`. */
  forced: string[];
  /** Serviços com a label `tws.mail` em valor que o painel não entende (nem true nem false). */
  badLabels: Array<{ service: string; value: string }>;
}

/** Valor da label `tws.mail` de um serviço (labels em mapa ou em lista `chave=valor`). */
export function serviceMailLabel(def: Record<string, unknown> | undefined): string | null {
  const labels = def?.labels;
  if (Array.isArray(labels)) {
    for (const item of labels) {
      if (typeof item !== "string") continue;
      if (item === TWS_LABEL_MAIL) return "";
      if (item.startsWith(`${TWS_LABEL_MAIL}=`)) return item.slice(TWS_LABEL_MAIL.length + 1);
    }
    return null;
  }
  if (labels && typeof labels === "object" && TWS_LABEL_MAIL in labels) {
    const v = (labels as Record<string, unknown>)[TWS_LABEL_MAIL];
    return v === null || v === undefined ? "" : String(v);
  }
  return null;
}

/** Arquivo (absoluto, dentro de `root`) do Dockerfile de um serviço com `build:`; null = sem build ou fora da pasta. */
function buildDockerfilePath(def: Record<string, unknown>, root: string): string | null {
  const b = def.build;
  let context: string;
  let file = "Dockerfile";
  if (typeof b === "string") context = b;
  else if (b && typeof b === "object") {
    const o = b as { context?: unknown; dockerfile?: unknown; dockerfile_inline?: unknown };
    if (o.dockerfile_inline !== undefined) return null;
    context = typeof o.context === "string" ? o.context : ".";
    if (typeof o.dockerfile === "string") file = o.dockerfile;
  } else return null;
  const abs = path.resolve(root, context, file);
  return abs.startsWith(root + path.sep) ? abs : null;
}

/**
 * Imagem-base do estágio final do Dockerfile de cada serviço com `build:` (só os que não têm `image:` de banco).
 * Leitura segura: só arquivo comum, sem seguir link, com teto de tamanho.
 */
export async function composeBuildBaseImages(compose: string, resolved: unknown, root: string): Promise<Record<string, string>> {
  const base = path.resolve(root);
  const out: Record<string, string> = {};
  for (const [name, def] of Object.entries(composeServiceDefs(compose, resolved))) {
    const file = buildDockerfilePath(def, base);
    if (file === null) continue;
    const text = await readRegularFileLimited(file, DOCKERFILE_MAX_BYTES);
    const target = (def.build as { target?: unknown }).target;
    const from = text === undefined ? null : dockerfileFinalBaseImage(text, typeof target === "string" ? target : null);
    if (from !== null) out[name] = from;
  }
  return out;
}

/** Separa os serviços pedidos entre os que entram na rede de e-mail e os excluídos (banco/cache, label). */
export function selectMailServices(
  compose: string,
  requested: readonly string[],
  resolved: unknown,
  buildBases: Record<string, string> = {},
): MailServiceSelection {
  const defs = composeServiceDefs(compose, resolved);
  const result: MailServiceSelection = { included: [], excluded: [], forced: [], badLabels: [] };
  const decisions = new Map<string, MailServiceDecision>();
  for (const service of requested) {
    const def = defs[service];
    const label = serviceMailLabel(def);
    if (label !== null && mailLabelValue(label) === null) result.badLabels.push({ service, value: label });
    decisions.set(
      service,
      mailServiceDecision({
        image: typeof def?.image === "string" ? def.image : null,
        buildBase: buildBases[service] ?? null,
        label,
      }),
    );
  }
  for (const service of requested) {
    let decision = decisions.get(service)!;
    // quem usa a rede de um serviço de fora (network_mode: service:<banco>) não tem rede de e-mail própria nem como
    // alcançá-la: fica de fora junto com o dono, e o log diz para marcar o dono
    const owner = networkOwner(defs, service);
    if (decision.include && owner.kind === "owner" && decisions.get(owner.name)?.include === false) {
      decision = { include: false, reason: "shared-network", image: owner.name };
    }
    if (decision.include) {
      result.included.push(service);
      if (decision.forced) result.forced.push(service);
    } else result.excluded.push({ service, decision });
  }
  return result;
}
