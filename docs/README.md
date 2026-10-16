# Documentação do TWS Panel

Índice de toda a documentação do projeto. Comece pelo [README](../README.md) para a visão geral.

## Usar o painel

| Doc | Conteúdo |
|---|---|
| [instalacao.md](instalacao.md) | Instalação passo a passo numa VPS limpa (Passos 1 a 8): SSH, usuário, chave, instalador, acesso por túnel, wizard. |
| [wizard-seguranca.md](wizard-seguranca.md) | Como conduzir a etapa Segurança do wizard: as 8 fases, a confirmação de acesso e o rollback automático. |
| [funcionalidades.md](funcionalidades.md) | O que o painel faz, módulo por módulo: deploy, portas, certificados, domínio do painel, e-mail, notificações, backups, segurança, terminal e roteiro. |
| [operacao.md](operacao.md) | Atualizar o painel, scripts de emergência, comandos úteis, pasta dos projetos, trocar o usuário do terminal ou a porta. |
| [recuperar-acesso.md](recuperar-acesso.md) | Perdi o acesso: senha do painel, celular da verificação em duas etapas, senha do Linux, chave SSH, domínio do painel. |
| [seguranca.md](seguranca.md) | Modelo de segurança: o que o painel protege, o que ele exige (terminal e socket do Docker) e como funciona o login. |
| [production.md](production.md) | Do dev à VPS real: portas de e-mail, IP público, ACME, PTR, UFW e ordem recomendada de configuração. |
| [troubleshooting.md](troubleshooting.md) | Problemas comuns: porta 25 bloqueada, e-mail em spam, certificado não emitido, painel que não abre. |

## Desenvolver

| Doc | Conteúdo |
|---|---|
| [desenvolvimento.md](desenvolvimento.md) | Modo dev local e arquitetura do monorepo. |
| [host-bridge.md](host-bridge.md) | Como o scan e o hardening rodam na VPS real a partir do container do painel. |
| [github-security.md](github-security.md) | Endurecimento do repositório no GitHub (rulesets, cadeia de suprimentos). |
| [../comoFuncionaSistema/](../comoFuncionaSistema/) | Documentação legível por máquina: um JSON por endpoint, com parâmetros, erros, efeitos colaterais e testes. Escrita para agentes de IA — comece por `index.json`. |
| [threat-model.json](../comoFuncionaSistema/global/threat-model.json) | O que o painel protege, o que não protege, quais privilégios exige e por quê. |

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

## Evidências e imagens

| Pasta | Resumo |
|---|---|
| [phase1-evidence/](phase1-evidence/) | Prints e JSONs do scan de segurança antes/depois do hardening (Fase 1). |
| [imagens/](imagens/) | Prints das telas usados no README (dados fictícios). |

## Documentos de comunidade (raiz do repositório)

| Doc | Resumo |
|---|---|
| [../README.md](../README.md) | Visão geral, funcionalidades, instalação rápida e roadmap. |
| [../CHANGELOG.md](../CHANGELOG.md) | O que mudou em cada versão. |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | Setup local, padrões e como estender o painel (checks, guardrails, pipelines). |
| [../SECURITY.md](../SECURITY.md) | Como reportar vulnerabilidades e práticas de segurança do projeto. |
| [../CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md) | Código de conduta (Contributor Covenant). |
