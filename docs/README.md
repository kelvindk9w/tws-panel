# Documentação do paas

Índice de toda a documentação do projeto.

## Guias

| Doc | Resumo |
|---|---|
| [production.md](production.md) | Guia completo "do dev à VPS real": portas de e-mail, IP público, ACME, PTR, UFW e ordem recomendada de setup. |
| [troubleshooting.md](troubleshooting.md) | Problemas prováveis e soluções: porta 25 bloqueada, e-mail em spam, certificado não emitido, wizard inacessível. |

## Specs e pesquisas (base das fases)

| Doc | Resumo |
|---|---|
| [security-research.md](security-research.md) | Spec de hardening de VPS Ubuntu (fontes: CIS, Lynis, guias 2025/2026) — base da Fase 1. |
| [email-deliverability.md](email-deliverability.md) | Spec de DNS/entregabilidade (SPF, DKIM, DMARC, PTR, requisitos Gmail/Yahoo/Microsoft) — base da Fase 3. |
| [projects-analysis.md](projects-analysis.md) | Requisitos extraídos de 3 projetos reais que definiram os modos de ingestão e pipelines — base da Fase 2. |

## Notas de implementação por fase

| Doc | Resumo |
|---|---|
| [fase-3-email.md](fase-3-email.md) | Integração do Stalwart (imagem, API REST, bootstrap), checklist DNS, injeção SMTP e o que muda em produção. |
| [fase-4-guardrails-monitoramento.md](fase-4-guardrails-monitoramento.md) | Regras de guardrail, baseline + diff, blacklist DNSBL, central de alertas e auditoria. |

## Evidências

| Pasta | Resumo |
|---|---|
| [phase1-evidence/](phase1-evidence/) | Prints e JSONs do scan de segurança antes/depois do hardening (Fase 1). |

## Documentos de comunidade (raiz do repositório)

| Doc | Resumo |
|---|---|
| [../README.md](../README.md) | Visão geral, features, quickstart e arquitetura. |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | Setup local, padrões e como estender o painel (checks, guardrails, pipelines). |
| [../SECURITY.md](../SECURITY.md) | Como reportar vulnerabilidades e práticas de segurança do projeto. |
| [../CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md) | Código de conduta (Contributor Covenant). |
