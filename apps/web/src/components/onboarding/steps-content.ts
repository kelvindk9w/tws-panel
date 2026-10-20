/**
 * Conteúdo de cada passo do roteiro "Deixe o painel pronto": o "Como fazer"
 * (o que é, por que importa, passo a passo) e o botão que leva à tela certa.
 * Os textos ficam em `locales/<idioma>/onboarding.ts`; aqui só as chaves, e a
 * tradução acontece na renderização.
 * O STATUS vem do servidor (GET /api/onboarding), calculado do estado real.
 *
 * Passo "em breve" (funcionalidade que ainda não existe): sem `action`. Quando
 * a funcionalidade chegar, basta trocar o passo a passo e pôr a `action` —
 * o servidor passa a devolver o status real e o resto do roteiro não muda.
 */
import type { OnboardingStepId } from "@paas/core";
import type { Key } from "@/i18n";
import { Bell, DatabaseBackup, Globe, KeyRound, Mail, ShieldCheck, type LucideIcon } from "lucide-react";

export interface OnboardingStepContent {
  title: Key;
  icon: LucideIcon;
  whatIs: Key;
  why: Key;
  howTo: Key[];
  /** Observação destacada no "Como fazer" (ex.: quando marcar "Não vou usar"). */
  note?: Key;
  /** Botão que leva direto à tela certa; ausente nos passos "em breve". */
  action?: { label: Key; to: string };
}

export const ONBOARDING_CONTENT: Record<OnboardingStepId, OnboardingStepContent> = {
  hardening: {
    title: "onboarding.steps.hardening.title",
    icon: ShieldCheck,
    whatIs: "onboarding.steps.hardening.whatIs",
    why: "onboarding.steps.hardening.why",
    howTo: [
      "onboarding.steps.hardening.howTo.1",
      "onboarding.steps.hardening.howTo.2",
      "onboarding.steps.hardening.howTo.3",
      "onboarding.steps.hardening.howTo.4",
    ],
    action: { label: "onboarding.steps.hardening.action", to: "/security/hardening" },
  },
  "two-factor": {
    title: "onboarding.steps.twoFactor.title",
    icon: KeyRound,
    whatIs: "onboarding.steps.twoFactor.whatIs",
    why: "onboarding.steps.twoFactor.why",
    howTo: [
      "onboarding.steps.twoFactor.howTo.1",
      "onboarding.steps.twoFactor.howTo.2",
      "onboarding.steps.twoFactor.howTo.3",
      "onboarding.steps.twoFactor.howTo.4",
    ],
    action: { label: "onboarding.steps.twoFactor.action", to: "/settings/security#two-factor" },
  },
  "panel-domain": {
    title: "onboarding.steps.panelDomain.title",
    icon: Globe,
    whatIs: "onboarding.steps.panelDomain.whatIs",
    why: "onboarding.steps.panelDomain.why",
    howTo: [
      "onboarding.steps.panelDomain.howTo.1",
      "onboarding.steps.panelDomain.howTo.2",
      "onboarding.steps.panelDomain.howTo.3",
      "onboarding.steps.panelDomain.howTo.4",
      "onboarding.steps.panelDomain.howTo.5",
    ],
    note: "onboarding.steps.panelDomain.note",
    action: { label: "onboarding.steps.panelDomain.action", to: "/settings/panel-domain" },
  },
  email: {
    title: "onboarding.steps.email.title",
    icon: Mail,
    whatIs: "onboarding.steps.email.whatIs",
    why: "onboarding.steps.email.why",
    howTo: [
      "onboarding.steps.email.howTo.1",
      "onboarding.steps.email.howTo.2",
      "onboarding.steps.email.howTo.3",
      "onboarding.steps.email.howTo.4",
    ],
    note: "onboarding.steps.email.note",
    action: { label: "onboarding.steps.email.action", to: "/mail" },
  },
  notifications: {
    title: "onboarding.steps.notifications.title",
    icon: Bell,
    whatIs: "onboarding.steps.notifications.whatIs",
    why: "onboarding.steps.notifications.why",
    howTo: [
      "onboarding.steps.notifications.howTo.1",
      "onboarding.steps.notifications.howTo.2",
      "onboarding.steps.notifications.howTo.3",
      "onboarding.steps.notifications.howTo.4",
      "onboarding.steps.notifications.howTo.5",
      "onboarding.steps.notifications.howTo.6",
    ],
    note: "onboarding.steps.notifications.note",
    action: { label: "onboarding.steps.notifications.action", to: "/settings/notifications" },
  },
  backups: {
    title: "onboarding.steps.backups.title",
    icon: DatabaseBackup,
    whatIs: "onboarding.steps.backups.whatIs",
    why: "onboarding.steps.backups.why",
    howTo: [
      "onboarding.steps.backups.howTo.1",
      "onboarding.steps.backups.howTo.2",
      "onboarding.steps.backups.howTo.3",
      "onboarding.steps.backups.howTo.4",
      "onboarding.steps.backups.howTo.5",
      "onboarding.steps.backups.howTo.6",
      "onboarding.steps.backups.howTo.7",
      "onboarding.steps.backups.howTo.8",
    ],
    note: "onboarding.steps.backups.note",
    action: { label: "onboarding.steps.backups.action", to: "/settings/backups" },
  },
};
