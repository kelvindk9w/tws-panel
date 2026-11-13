import type { Key, TFunction } from "@/i18n";
import { agentPromptGuideUrl, composeRulesGuideUrl, docsUrl, prepareProjectGuideUrl } from "@/lib/links";

/** Seções do texto, na ordem em que vão para a área de transferência. */
const SECTIONS = [
  "agent.text.intro",
  "agent.text.panel",
  "agent.text.limits",
  "agent.text.detect",
  "agent.text.rules",
  "agent.text.deliver",
  "agent.text.links",
] as const satisfies readonly Key[];

/**
 * Texto pronto para colar na conversa com um agente de IA que vai preparar um
 * repositório para o painel: o que é o painel, como ele detecta o projeto, as
 * regras do compose, o que entregar e os links da documentação — tudo no
 * idioma da interface. Os endereços vêm sempre de lib/links.ts (o domínio do
 * site pode mudar) e o texto não leva nada da instalação: nem domínio, nem IP,
 * nem nome de projeto.
 */
export function buildAgentInstructions(t: TFunction, locale: string): string {
  const urls = {
    prepareUrl: prepareProjectGuideUrl(locale),
    composeRulesUrl: composeRulesGuideUrl(locale),
    agentPromptUrl: agentPromptGuideUrl(locale),
    docsUrl: docsUrl(locale),
  };
  return `${SECTIONS.map((key) => t(key, urls)).join("\n\n")}\n`;
}
