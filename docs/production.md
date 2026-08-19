# Do dev à VPS real — guia de produção

Este guia cobre tudo o que muda entre rodar o paas localmente (`pnpm dev`, domínios
`.localhost`, portas altas) e rodar em uma VPS Ubuntu 22.04/24.04 exposta na internet.

> Leia também: [troubleshooting.md](troubleshooting.md) para os problemas mais comuns.

---

## 1. O que muda em produção

### 1.1 Portas de e-mail

Em dev o Stalwart sobe em portas altas (ex.: 10125/10587/…); em produção ele usa as portas
padrão — que precisam estar **abertas no provedor e no UFW**:

| Porta | Serviço | Uso |
|---|---|---|
| **25** | SMTP | recebimento de e-mail de outros servidores |
| **587** | Submission | envio autenticado (clientes de e-mail e seus projetos) |
| **465** | Submissions | envio autenticado via TLS implícito |
| **143** | IMAP | leitura (STARTTLS) |
| **993** | IMAPS | leitura via TLS implícito |

⚠️ **A porta 25 é bloqueada por padrão em muitos provedores** (contas novas de Hetzner, AWS,
OCI, etc.). Abra um chamado pedindo a liberação antes de configurar e-mail — sem ela, você não
recebe mensagens de outros servidores.

### 1.2 `PAAS_PUBLIC_IP`

Defina o IP público real da VPS no ambiente do servidor:

```bash
PAAS_PUBLIC_IP=203.0.113.10
# opcional, só se a VPS tiver IPv6 público:
PAAS_PUBLIC_IPV6=2001:db8::10
```

O checklist DNS usa esse valor para gerar os registros A/SPF esperados e para a verificação.
Sem ele, o painel tenta adivinhar pela primeira interface — em VPS atrás de NAT isso pode dar
errado.

### 1.3 TLS/ACME real

- **Sites dos projetos**: o Caddy central emite certificados automaticamente via ACME assim que
  o DNS do domínio aponta para a VPS. Domínios `.localhost` são servidos em HTTP puro (só dev).
- **E-mail (Stalwart)**: em dev usa certificado autoassinado; em produção configure ACME na
  seção `[acme.*]` do `config.toml` do Stalwart ou monte um certificado real em
  `[certificate.default]`. Detalhes em [fase-3-email.md](fase-3-email.md) §4.

### 1.4 PTR (rDNS)

O registro PTR (IP reverso → `mail.seudominio.com`) **só o provedor da VPS pode configurar**
(painel do provedor ou chamado). O painel detecta a ausência e gera o texto pronto para abrir
o chamado. Sem PTR correto, Gmail e Outlook rebaixam ou rejeitam suas mensagens.

### 1.5 Domínios reais vs `.localhost`

| | Dev | Produção |
|---|---|---|
| Domínios | `meuapp.localhost` (HTTP puro) | domínio real com registro A → IP da VPS |
| SSL | nenhum | automático (Caddy ACME) |
| Verificação de DNS | desativada/modo teste | confirme o apontamento antes de emitir o cert |

### 1.6 UFW em produção

O hardening do wizard configura o UFW em modo default-deny. Após instalar o módulo de e-mail,
garanta as portas:

```bash
sudo ufw allow 25,587,465/tcp    # SMTP + submission
sudo ufw allow 143,993/tcp       # IMAP
sudo ufw allow 80,443/tcp        # sites + painel (Caddy)
sudo ufw status verbose
```

---

## 2. Ordem recomendada de setup

Siga esta sequência em uma VPS nova — cada passo depende do anterior:

```
1. HARDENING          → rode o wizard e conclua o scan + hardening primeiro.
                        Nada sobe na internet antes disso. Confirme o acesso SSH
                        para cancelar o rollback automático.
2. PAINEL             → conclua o wizard (conta admin) e garanta que o painel
                        responde na porta 9000.
3. DOMÍNIO DO PAINEL  → aponte painel.seudominio.com para a VPS e acesse o painel
                        via HTTPS atrás do Caddy.
4. PROJETOS           → cadastre e faça deploy dos projetos; para cada domínio,
                        use o botão "verificar DNS" antes de emitir o certificado.
5. E-MAIL             → libere a porta 25 no provedor → inicie o servidor Stalwart
                        pelo painel → adicione o domínio de e-mail.
6. VERIFICAR DNS      → crie os registros do checklist (A, MX, SPF, DKIM, DMARC)
                        no seu provedor de DNS e clique em "verificar" até fechar ✅.
                        Abra o chamado de PTR em paralelo (pode demorar).
7. MONITORAMENTO      → crie o baseline de segurança (POST /api/security/baseline
                        ou pela UI em Segurança) e confirme o scan recorrente ativo.
                        Só monitore depois que tudo estiver configurado — assim o
                        baseline reflete o estado "bom".
```

---

## 3. Checklist final de produção

- [ ] Hardening concluído e acesso SSH confirmado (rollback cancelado)
- [ ] Score Lynis verificado em **Segurança** (antes vs depois)
- [ ] Painel acessível apenas via HTTPS no domínio próprio
- [ ] Porta 9000 fechada para a internet (apenas localhost/VPN), se aplicável
- [ ] Porta 25 liberada pelo provedor + UFW
- [ ] PTR configurado pelo provedor (chamado aberto/confirmado)
- [ ] Checklist DNS de e-mail 100% ✅ (A, MX, SPF, DKIM, DMARC)
- [ ] Teste de envio: [mail-tester](https://www.mail-tester.com) ≥ 9/10
- [ ] DMARC em `p=none` coletando relatórios → endurecer para `quarantine`/`reject` depois
- [ ] Baseline de segurança criado + monitoramento recorrente ativo
- [ ] Blacklist verificada em **E-mail → Blacklist** (tudo clean)
- [ ] Nenhum alerta crítico aberto em **Alertas**
