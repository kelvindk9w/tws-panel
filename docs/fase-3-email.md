# Fase 3 — E-mail: notas de implementação e produção

> Complementa `docs/email-deliverability.md` (spec de DNS/deliverability) com as
> decisões de implementação do módulo `@paas/mailer`.

## 1. Como o Stalwart foi integrado

- **Imagem**: `stalwartlabs/mail-server:v0.11.8` (constante `STALWART_IMAGE` em
  `packages/mailer/src/server.ts`, sobrescrevível via código). **Desvio do plano**:
  a imagem pedida (`stalwartlabs/stalwart`) só publica a linha v0.16+, que
  **removeu a API REST** de gerenciamento (substituída por métodos JMAP `x:`),
  mudou a config para `config.json` e introduziu um **wizard de setup interativo**
  (bootstrap mode) — inviável para provisionamento determinístico headless pelo
  painel. A v0.11.8 é a última linha com API REST (`/api/principal`, `/api/dkim`)
  + bootstrap 100% via `config.toml` montado. Suporte à linha 0.16 (JMAP `x:`)
  fica como roadmap.
- **API, não CLI**: todo o provisionamento usa a API REST do Stalwart com Basic
  Auth (`admin:<secret>` — secret forte gerado na 1ª inicialização e persistido
  em `data/mail/mail.json`, modo 0600). Não há fallback para CLI porque a imagem
  não inclui `stalwart-cli`.
- **Container**: `paas-stalwart` na rede `paas-net` (alias `paas-stalwart`),
  volume `paas_stalwart_data` → `/opt/stalwart-mail/data`, config renderizada em
  `data/mail/stalwart/config.toml` → `/opt/stalwart-mail/etc` (read-only).
- **Bootstrap**: o painel renderiza o TOML completo (hostname, listeners
  25/587/465/143/993/8080, fallback-admin, RocksDB) — sem wizard. TLS: sem seção
  `[certificate.*]` o Stalwart gera um certificado **autoassinado** (rcgen) —
  suficiente para dev; em produção, configurar ACME ou certificado real.
- **Caixas**: principals `individual` com `roles: ["user"]` — **obrigatório**:
  sem o papel, o Stalwart autentica mas nega SMTP/IMAP
  ("Your account is not authorized to use this service"). Descoberto empiricamente.
- **DKIM**: `POST /api/dkim {"algorithm":"Rsa","selector":"paas"}` gera o par
  **RSA 2048** no servidor; a chave pública (base64 do `p=`) vem de
  `GET /api/dkim/rsa-<domínio>`.

## 2. Checklist DNS (por domínio)

| Registro | Nome | Valor esperado |
|---|---|---|
| A | `mail.<domínio>` | IPv4 da VPS (`PAAS_PUBLIC_IP` ou 1ª interface) |
| AAAA | `mail.<domínio>` | IPv6 (só se `PAAS_PUBLIC_IPV6` definido) |
| MX | `<domínio>` | `10 mail.<domínio>` |
| SPF | `<domínio>` | `v=spf1 ip4:<IP> ~all` (estágio inicial) → `-all` (endurecido) |
| DKIM | `paas._domainkey.<domínio>` | `v=DKIM1; k=rsa; p=<chave 2048>` |
| DMARC | `_dmarc.<domínio>` | `v=DMARC1; p=none; rua=mailto:dmarc@<domínio>` → progressivo |
| PTR | reverse do IP | `mail.<domínio>` — fora do nosso controle; ausência → `action_required` + texto de chamado pronto |

Verificação (`POST .../verify`): resolver público 1.1.1.1/8.8.8.8 via
`node:dns/promises`; cada registro → ✅ found / ❌ missing / ⚠️ mismatch.
O resolvedor é injetável (`DnsResolverLike`) para testes com mock.
Ao adicionar um domínio, `postmaster@` (com alias `abuse@`) é criado
automaticamente (exigência das boas práticas).

## 3. Injeção SMTP em projetos

`POST /api/projects/:id/email {domain}` cria a caixa técnica `<slug>@<domínio>`
(se necessário) e registra o vínculo. No próximo deploy, o engine injeta
`SMTP_HOST=paas-stalwart`, `SMTP_PORT=587`, `SMTP_USER`, `SMTP_PASS`,
`MAIL_FROM` — no override compose (**todos os serviços**) ou via `-e` no
pipeline Dockerfile. Estáticos não recebem (sem runtime). `DELETE` no mesmo
endpoint desativa. Senhas são base64url (YAML/env-safe).

## 4. O que muda em produção

| Item | Dev (WSL) | Produção (VPS) |
|---|---|---|
| Portas publicadas | altas (ex.: 10125/10587/10465/10143/10993/18081) | padrão 25/587/465/143/993/8080 (defaults do config) |
| `PAAS_PUBLIC_IP` | qualquer IP de teste | IP público real da VPS (checklist A/SPF/PTR) |
| TLS | certificado autoassinado (rcgen) — clientes usam `rejectUnauthorized:false` | configurar ACME no Stalwart (`[acme.*]`) ou montar cert real em `[certificate.default]` |
| DNS | domínios `.invalid`/exemplo → verify retorna missing | registros criados no provedor; verify deve fechar ✅ |
| PTR | sempre `action_required` | abrir chamado no provedor da VPS (texto gerado pelo painel) |
| SMTP interno dos projetos | `paas-stalwart:587` STARTTLS com cert autoassinado | mesmo endereço, cert válido — verificação estrita OK |
| Porta 25 | bloqueada/indisponível em dev | liberar no provedor (muitos bloqueiam por padrão) + UFW |

⚠️ **Atenção (descoberto nos testes)**: a porta **10080 está na lista de
"bad ports" do fetch (WHATWG)** — o Node (undici) recusa conexão. Para a API de
admin em dev, usar outra porta alta (ex.: 18081).

## 5. Persistência

`data/mail/mail.json` (0600): secret do admin Stalwart, domínios (+ chave
pública DKIM e estágio DMARC), caixas (com senha — necessária para credenciais
e injeção) e vínculos projeto↔caixa técnica.

## 6. Testes

`pnpm test:mail` (`scripts/test-mail.mts`): sobe a API em ambiente isolado,
provisiona o Stalwart em portas altas e valida 18 verificações — bootstrap,
DKIM 2048, checklist, verify (missing/mismatch/found via mock), envio SMTP +
leitura IMAP end-to-end, credenciais, injeção SMTP em deploy real do
`examples/compose-app` e limpeza completa de containers/volumes.
