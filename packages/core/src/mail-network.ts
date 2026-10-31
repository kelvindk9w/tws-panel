/**
 * Quais serviços de um projeto entram na rede de e-mail (paas-mail ou a da caixa de teste) e recebem o SMTP_*.
 *
 * A paas-mail é compartilhada por todos os projetos com e-mail, pelo Stalwart e pelo webmail. Banco e cache não
 * enviam e-mail: ligá-los a ela deixaria o banco de um projeto alcançável pelos containers de outro. Por isso ficam
 * de fora os serviços de imagem de banco/cache reconhecida (ou cujo Dockerfile parte de uma).
 *
 * Saída de emergência, por serviço, com a label `tws.mail` (no compose: `labels: ["tws.mail=true"]`):
 *  - `true`: entra mesmo sendo de imagem de banco (um serviço que de fato envia e-mail);
 *  - `false`: nunca entra, mesmo não sendo de banco.
 */
import { isDatabaseImage } from "./timezone";

export const TWS_LABEL_MAIL = "tws.mail";
/**
 * Carimbo que o painel grava (pelo override) em cada serviço de um projeto com e-mail: `in` = ligado à rede de e-mail,
 * `out` = deixado de fora. É o que decide o que fazer com o container já rodando, sem recalcular a regra.
 */
export const TWS_LABEL_MAIL_DECIDED = "tws.mail.decided";

/** Valor reconhecido da label `tws.mail` (true/false, sem diferenciar maiúsculas); null = outro valor. */
export function mailLabelValue(label: string | null | undefined): "true" | "false" | null {
  const v = label?.trim().toLowerCase();
  return v === "true" || v === "false" ? v : null;
}

export type MailExclusionReason = "database-image" | "database-build" | "label" | "shared-network";

export interface MailServiceDecision {
  include: boolean;
  /** Presente só quando excluído. */
  reason?: MailExclusionReason;
  /** A label `tws.mail=true` incluiu um serviço que seria excluído. */
  forced?: boolean;
  /** Imagem (ou imagem-base do Dockerfile) que causou a exclusão. */
  image?: string;
}

export interface MailServiceInput {
  image?: string | null;
  /** Imagem do estágio final do Dockerfile do serviço (serviço com `build:`). */
  buildBase?: string | null;
  /** Valor da label `tws.mail`. */
  label?: string | null;
}

export function mailServiceDecision(input: MailServiceInput): MailServiceDecision {
  const label = mailLabelValue(input.label);
  if (label === "false") return { include: false, reason: "label" };
  const isDb = isDatabaseImage(input.image);
  const isDbBuild = !isDb && isDatabaseImage(input.buildBase);
  if (!isDb && !isDbBuild) return { include: true };
  if (label === "true") return { include: true, forced: true };
  return isDb
    ? { include: false, reason: "database-image", image: input.image!.trim() }
    : { include: false, reason: "database-build", image: input.buildBase!.trim() };
}

/** Texto do motivo para o log de deploy. */
export function mailExclusionText(d: MailServiceDecision): string {
  if (d.reason === "label") return `label ${TWS_LABEL_MAIL}=false`;
  if (d.reason === "shared-network") return `usa a rede de ${d.image} (network_mode), que fica fora da rede de e-mail; ponha ${TWS_LABEL_MAIL}=true em ${d.image} para ligar os dois`;
  if (d.reason === "database-build") return `Dockerfile parte da imagem de banco/cache ${d.image}`;
  return `imagem de banco/cache ${d.image}`;
}
