// Gerado a partir da lista de namespaces; as chaves vêm do idioma de origem (pt-BR).
import type common from "@/locales/pt-BR/common";
import type shell from "@/locales/pt-BR/shell";
import type auth from "@/locales/pt-BR/auth";
import type errors from "@/locales/pt-BR/errors";
import type certificates from "@/locales/pt-BR/certificates";
import type monitoring from "@/locales/pt-BR/monitoring";
import type hardening from "@/locales/pt-BR/hardening";
import type security from "@/locales/pt-BR/security";
import type setup from "@/locales/pt-BR/setup";
import type terminal from "@/locales/pt-BR/terminal";
import type projects from "@/locales/pt-BR/projects";
import type dashboard from "@/locales/pt-BR/dashboard";
import type env from "@/locales/pt-BR/env";
import type compose from "@/locales/pt-BR/compose";
import type ports from "@/locales/pt-BR/ports";
import type mail from "@/locales/pt-BR/mail";
import type envios from "@/locales/pt-BR/envios";
import type mailHealth from "@/locales/pt-BR/mailHealth";
import type backups from "@/locales/pt-BR/backups";
import type settings from "@/locales/pt-BR/settings";
import type notifications from "@/locales/pt-BR/notifications";
import type panelDomain from "@/locales/pt-BR/panelDomain";
import type onboarding from "@/locales/pt-BR/onboarding";
import type timezone from "@/locales/pt-BR/timezone";
import type metrics from "@/locales/pt-BR/metrics";
import type cloudflare from "@/locales/pt-BR/cloudflare";
import type access from "@/locales/pt-BR/access";

interface Catalog {
  common: typeof common;
  shell: typeof shell;
  auth: typeof auth;
  errors: typeof errors;
  certificates: typeof certificates;
  monitoring: typeof monitoring;
  hardening: typeof hardening;
  security: typeof security;
  setup: typeof setup;
  terminal: typeof terminal;
  projects: typeof projects;
  dashboard: typeof dashboard;
  env: typeof env;
  compose: typeof compose;
  ports: typeof ports;
  mail: typeof mail;
  envios: typeof envios;
  mailHealth: typeof mailHealth;
  backups: typeof backups;
  settings: typeof settings;
  notifications: typeof notifications;
  panelDomain: typeof panelDomain;
  onboarding: typeof onboarding;
  timezone: typeof timezone;
  metrics: typeof metrics;
  cloudflare: typeof cloudflare;
  access: typeof access;
}

type PluralSuffix = "zero" | "one" | "two" | "few" | "many" | "other";
/** Chave-base: `items_one` e `items_other` valem como `items`. */
type Base<K extends string> = K extends `${infer B}_${PluralSuffix}` ? B : K;

/** União de todas as chaves públicas: `namespace.chave`. */
export type Key = {
  [N in keyof Catalog]: `${N & string}.${Base<keyof Catalog[N] & string>}`;
}[keyof Catalog];

export const NAMESPACES = ["common","shell","auth","errors","certificates","monitoring","hardening","security","setup","terminal","projects","dashboard","env","compose","ports","mail","envios","mailHealth","backups","settings","notifications","panelDomain","onboarding","timezone","metrics","cloudflare","access"] as const;
