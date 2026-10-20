# docs/

The user and developer guides are **not** in this folder: they live in
[`site/src/content/docs/`](../site/src/content/docs/), one folder per language (`en`, `pt-br`),
and are published as the documentation website. This folder keeps what is not part of the website.

| Folder | Content |
|---|---|
| [`assets/`](assets/) | Screenshots used by the README (fictional data). To regenerate them: [`assets/regenerar/COMO-REGENERAR.md`](assets/regenerar/COMO-REGENERAR.md) (Portuguese). |
| [`community/pt-BR/`](community/pt-BR/) | Portuguese (Brazil) versions of [CONTRIBUTING](community/pt-BR/CONTRIBUTING.md), [SECURITY](community/pt-BR/SECURITY.md) and [CODE_OF_CONDUCT](community/pt-BR/CODE_OF_CONDUCT.md). The English originals are in the repository root. |
| [`internal/`](internal/) | Design specs and research notes behind each development phase. **Portuguese only**, kept as a historical record. |

## Internal specs and research (Portuguese)

| Doc | Summary |
|---|---|
| [security-research.md](internal/security-research.md) | VPS hardening spec (CIS, Lynis, 2025/2026 guides); the basis of the hardening phases. |
| [email-deliverability.md](internal/email-deliverability.md) | DNS and deliverability spec (SPF, DKIM, DMARC, PTR, Gmail/Yahoo/Microsoft requirements). |
| [projects-analysis.md](internal/projects-analysis.md) | Requirements taken from three real projects that defined the ingestion modes and pipelines. |
| [fase-3-email.md](internal/fase-3-email.md) | Stalwart integration (image, REST API, bootstrap), DNS checklist, SMTP injection. |
| [fase-4-guardrails-monitoramento.md](internal/fase-4-guardrails-monitoramento.md) | Guardrail rules, baseline + diff, DNSBL, alert center and audit. |
| [allowed-origins.md](internal/allowed-origins.md) | Running the panel behind another reverse proxy: the `ALLOWED_ORIGINS` variable and `403 forbidden_origin`. |
| [github-security.md](internal/github-security.md) | Hardening the GitHub repository itself (rulesets, supply chain). |
| [phase1-evidence/](internal/phase1-evidence/) | Screenshots and JSON of the security scan before and after hardening (phase 1). |

## Machine-readable documentation

[`comoFuncionaSistema/`](../comoFuncionaSistema/) holds one JSON file per endpoint (parameters,
errors, side effects and tests), written for AI agents. Start with `index.json`. The panel's threat
model is in [`threat-model.json`](../comoFuncionaSistema/global/threat-model.json).
