/**
 * Texto de cada passo do roteiro "Deixe o painel pronto": o "Como fazer"
 * (o que é, por que importa, passo a passo) e o botão que leva à tela certa.
 * O STATUS vem do servidor (GET /api/onboarding), calculado do estado real.
 *
 * Passo "em breve" (funcionalidade que ainda não existe): sem `action`. Quando
 * a funcionalidade chegar, basta trocar o passo a passo e pôr a `action` —
 * o servidor passa a devolver o status real e o resto do roteiro não muda.
 */
import type { OnboardingStepId } from "@paas/core";
import { Bell, Globe, KeyRound, Mail, ShieldCheck, type LucideIcon } from "lucide-react";

export interface OnboardingStepContent {
  title: string;
  icon: LucideIcon;
  whatIs: string;
  why: string;
  howTo: string[];
  /** Observação destacada no "Como fazer" (ex.: quando marcar "Não vou usar"). */
  note?: string;
  /** Botão que leva direto à tela certa; ausente nos passos "em breve". */
  action?: { label: string; to: string };
}

export const ONBOARDING_CONTENT: Record<OnboardingStepId, OnboardingStepContent> = {
  hardening: {
    title: "Proteções da VPS",
    icon: ShieldCheck,
    whatIs:
      "Ajustes de segurança no sistema da VPS, em fases: atualizações automáticas, acesso SSH só com chave, firewall, bloqueio de quem tenta adivinhar senha e auditoria.",
    why: "A VPS fica na internet o tempo todo e recebe tentativas automáticas de invasão desde o primeiro minuto. Cada fase fecha uma porta de entrada comum.",
    howTo: [
      "Abra Segurança → Proteções e rode a varredura para ver o que falta.",
      "Simule as fases pendentes: nada muda na VPS durante a simulação.",
      "Se a simulação estiver certa, aplique de verdade.",
      "Nas fases de SSH e firewall, teste o acesso numa janela nova antes de confirmar — se não confirmar em 5 minutos, a fase se desfaz sozinha.",
    ],
    action: { label: "Abrir Proteções", to: "/security/hardening" },
  },
  "two-factor": {
    title: "Verificação em duas etapas",
    icon: KeyRound,
    whatIs:
      "Além da senha, entrar no painel passa a pedir um código de 6 dígitos que muda a cada 30 segundos, gerado por um app no seu celular.",
    why: "O painel está na internet. Se a sua senha vazar, ninguém entra sem o seu celular.",
    howTo: [
      "Instale no celular um app autenticador (Google Authenticator, Microsoft Authenticator, 2FAS ou parecido).",
      "Em Configurações → Segurança, clique para ativar e leia o QR code com o app.",
      "Digite a sua senha e o código que o app mostrar.",
      "Guarde os códigos de recuperação num lugar seguro: são a saída se você perder o celular.",
    ],
    action: { label: "Ativar a verificação", to: "/settings/security#two-factor" },
  },
  "panel-domain": {
    title: "Domínio do painel",
    icon: Globe,
    whatIs:
      "Um endereço seu para abrir o painel, como painel.exemplo.com.br, no lugar do endereço automático criado na instalação.",
    why: "O endereço atual tem o IP da VPS no nome: entrega onde o seu servidor está e é difícil de lembrar. Um domínio seu é mais discreto e fácil de guardar.",
    howTo: [
      "Escolha um subdomínio para o painel (ex.: painel.exemplo.com.br) e informe em Configurações → Domínio do painel.",
      "No seu provedor de DNS, crie o registro do tipo A que a tela mostrar, apontando para o IP da VPS. No Cloudflare, deixe a nuvem cinza (“Somente DNS”).",
      "Clique em Verificar DNS. Com o DNS certo, o painel passa a responder nos dois endereços e emite o certificado HTTPS sozinho (costuma levar de segundos a 2 minutos).",
      "Com o certificado válido, clique em “Abrir o painel pelo endereço novo” e entre de novo: a sessão vale só no endereço em que você entrou.",
      "Opcional, já no endereço novo: Desativar o acesso pelo IP. Antes, anote o comando de SSH que a tela mostra para reativar, caso o domínio pare de abrir.",
    ],
    note: "No acesso por túnel SSH o painel não tem endereço na internet: este passo já conta como feito e a tela explica como mudar para HTTPS.",
    action: { label: "Abrir Domínio do painel", to: "/settings/panel-domain" },
  },
  email: {
    title: "E-mail do servidor",
    icon: Mail,
    whatIs:
      "Um servidor de e-mail na própria VPS para os seus projetos enviarem mensagens (recuperação de senha, avisos, formulários de contato).",
    why: "Sem ele, cada projeto precisa de um serviço externo de envio. Com ele, o painel cria a caixa e entrega os dados de envio ao projeto sozinho.",
    howTo: [
      "Escolha um subdomínio só para envio, como envio.exemplo.com.br. Não use o domínio principal: apontar o MX dele para a VPS desviaria o e-mail que a empresa já recebe em outro lugar.",
      "Abra E-mail e inicie o servidor.",
      "Adicione o domínio de envio.",
      "Crie no seu provedor de DNS os registros que o painel mostrar e clique em Verificar DNS.",
    ],
    note: "Opcional: se os seus projetos usam um serviço externo de envio (Amazon SES, Resend, SendGrid…), marque “Não vou usar”.",
    action: { label: "Abrir E-mail", to: "/mail" },
  },
  notifications: {
    title: "Notificações",
    icon: Bell,
    whatIs:
      "Avisos fora do painel quando algo precisa da sua atenção: alerta de segurança, deploy que falhou, certificado perto de vencer.",
    why: "Hoje os alertas só aparecem dentro do painel. Com ele fechado, um problema pode passar dias sem ninguém ver.",
    howTo: [
      "Esta opção ainda não existe no painel — está em preparação.",
      "Primeiro virá o Telegram: você conversa com um robô do painel e passa a receber os avisos por lá.",
      "Depois, o e-mail (usando o e-mail do servidor do passo anterior).",
      "Você vai poder escolher um, outro ou os dois.",
    ],
  },
};
