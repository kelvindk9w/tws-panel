# Entregabilidade de E-mail — Especificação Consolidada

> Consolidação da pesquisa de DNS/e-mail que orienta o módulo `@paas/mailer` (Fase 3).
> Objetivo: um domínio hospedado no painel deve atingir **mail-tester ≥ 9/10** e passar nos
> requisitos de Gmail, Yahoo e Microsoft (2024–2025) para remetentes transacionais.

---

## 1. Registros essenciais (obrigatórios)

| Registro | Valor esperado | Por quê |
|---|---|---|
| **A** (ex.: `mail.dominio.com`) | IP da VPS | Hostname do servidor SMTP precisa resolver |
| **AAAA** | IPv6 da VPS (se houver) | Gmail verifica IPv6 quando presente — se existir, precisa estar correto |
| **MX** | `mail.dominio.com` (prioridade 10) | Recebimento; apontar para hostname, nunca IP |
| **PTR (rDNS)** | IP → `mail.dominio.com` | **FCrDNS obrigatório**: PTR resolve para o hostname e o A confirma o IP. Só o provedor da VPS configura → painel gera texto pronto para chamado |
| **SPF** | `v=spf1 ip4:<IP> -all` | Uma única entrada; `-all` (fail) após validação, `~all` durante testes |
| **DKIM** | TXT `mail._domainkey.dominio.com`, **RSA 2048 bits** | Assinatura de toda mensagem enviada; gerado pelo Stalwart |
| **DMARC** | `_dmarc.dominio.com` → progressivo: `p=none` → `p=quarantine` → `p=reject` | Começar com `p=none; rua=mailto:dmarc@dominio.com` para observar relatórios, endurecer depois |
| **TLS** | Certificado válido no SMTP (porta 25/465/587) | Stalwart + Caddy/ACME cuidam; sem TLS válido, grande parte dos receivers rebaixa/rejeita |

**Alinhamento (DMARC)**: SPF *ou* DKIM precisam alinhar com o domínio do `From:` — o DKIM com
`d=dominio.com` é o caminho principal.

## 2. Diferenciais (roadmap do módulo)

| Recurso | O que é | Ganho |
|---|---|---|
| **MTA-STS** | Policy HTTPS (`mta-sts.dominio.com`) + TXT `_mta-sts` | Impede downgrade/STARTTLS stripping |
| **TLS-RPT** | TXT `_smtp._tls` com `rua=` | Relatórios de falhas de TLS |
| **BIMI** | Logo verificado no Gmail (requer DMARC `quarantine`/`reject` + VMC) | Confiança visual |
| **Monitoramento de blacklist** | Checagem recorrente em RBLs (Spamhaus, Barracuda, etc.) | Alerta antes de virar crise |
| **Warm-up de IP** | Volume crescente nas primeiras 2–4 semanas (começar com dezenas/dia) | IP novo sem reputação é suspeito por padrão |
| **Feedback loops** | Yahoo CFL, Microsoft JMRP/SNDS | Visibilidade de reclamações de spam |

## 3. Requisitos dos grandes provedores (2024–2025)

Desde **fevereiro/2024** (Gmail/Yahoo) e reforços da Microsoft em **2025**:

### Gmail / Yahoo
- SPF **e** DKIM **e** DMARC configurados (DMARC pelo menos `p=none`).
- **FCrDNS** no IP de envio (PTR ↔ A).
- Taxa de spam reportada **< 0,3%** (Postmaster Tools); ideal < 0,1%.
- Bulk senders (> 5 mil/dia): **one-click unsubscribe** (RFC 8058) no header `List-Unsubscribe`.
- TLS obrigatório na transmissão.

### Microsoft (Outlook/Hotmail — exigências 2025)
- SPF/DKIM/DMARC obrigatórios para bulk senders (rejeição progressiva a partir de maio/2025).
- From: válido e alinhado; sem open relay; HELO/EHLO coerente com o hostname.
- Recomendado cadastro no **SNDS/JMRP** para monitorar reputação do IP.

### Boas práticas transversais
- Hostname do servidor (HELO) = FQDN com A/PTR consistentes.
- Não misturar transacional com marketing no mesmo IP/domínio.
- Caixas `postmaster@` e `abuse@` funcionais.
- Testar cada domínio novo com **mail-tester** e **Google Admin Toolbox checkmx** antes do uso real.

## 4. Mapeamento para o painel (Fase 3)

1. **Adicionar domínio** → Stalwart provisiona domínio + gera par **DKIM 2048**.
2. **Tela de checklist DNS** — A/AAAA, MX, SPF, DKIM, DMARC com botão "verificar" (consulta DNS
   real, marca ✅/❌). PTR: painel detecta ausência e gera texto de chamado para o provedor.
3. **DMARC progressivo** — painel sugere o próximo valor conforme relatórios/tempo.
4. **Caixas de e-mail** — credenciais IMAP/SMTP prontas para Outlook/Gmail/Thunderbird.
5. **Injeção de SMTP nos projetos** — env vars `SMTP_HOST/PORT/USER/PASS/MAIL_FROM` no deploy.
6. **Roadmap** — MTA-STS/TLS-RPT, BIMI, blacklist monitoring, warm-up guiado.
