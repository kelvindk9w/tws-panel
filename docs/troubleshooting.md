# Troubleshooting

Problemas prováveis ao rodar o paas em uma VPS real e como resolver cada um.

---

## 📧 E-mail

### Porta 25 bloqueada pelo provedor

**Sintomas:** você envia e recebe e-mails internamente, mas nenhuma mensagem de fora chega;
testes de conexão na porta 25 falham (`telnet SEU-IP 25` trava).

**Causa:** muitos provedores (Hetzner, AWS, OCI, contas novas em geral) bloqueiam a porta 25
de saída/entrada por padrão como medida anti-spam.

**Solução:**
1. Abra um chamado no provedor pedindo a liberação da porta 25 (alguns têm opção no painel);
2. Confirme o UFW: `sudo ufw allow 25/tcp`;
3. Verifique do lado de fora: `nc -zv SEU-IP 25`.

### E-mail caindo em spam

**Sintomas:** mensagens enviadas chegam, mas vão direto para a pasta de spam (especialmente
Gmail e Outlook).

**Diagnóstico (nesta ordem):**
1. Envie para [mail-tester.com](https://www.mail-tester.com) — ele aponta exatamente o que
   está faltando. Alvo: ≥ 9/10.
2. Abra o **checklist DNS** do domínio no painel e clique em "verificar": A, MX, SPF, DKIM e
   DMARC precisam estar ✅.
3. **PTR ausente** é a causa nº 1: só o provedor da VPS configura. O painel gera o texto pronto
   do chamado — abra e aguarde.
4. Confira a **blacklist** no painel (E-mail → Blacklist). Se estiver listado, siga o link de
   remoção da DNSBL correspondente.
5. **IP novo sem reputação**: nas primeiras 2–4 semanas envie volume baixo e crescente
   (dezenas/dia, não milhares). Veja "warm-up de IP" em
   [email-deliverability.md](email-deliverability.md).
6. Mantenha o DMARC em `p=none` coletando relatórios até tudo estabilizar; endureça para
   `quarantine`/`reject` depois.

### Certificado TLS do Stalwart inválido

**Sintomas:** clientes de e-mail avisam "certificado não confiável" ao conectar.

**Causa:** sem certificado configurado, o Stalwart usa um autoassinado (padrão em dev).

**Solução:** configure ACME (`[acme.*]`) ou monte um certificado real
(`[certificate.default]`) no `config.toml` do Stalwart — ver
[fase-3-email.md](fase-3-email.md) §4. Depois disso, os clientes podem usar verificação
estrita de TLS.

---

## 🌐 Domínios e SSL

### Caddy não emite certificado ("DNS não propagado")

**Sintomas:** site no ar só em HTTP, erro de ACME nos logs do container `paas-caddy`
(`docker logs paas-caddy`).

**Causa:** o registro A do domínio ainda não aponta para a VPS (ou a propagação não terminou).

**Solução:**
1. Use o botão **"verificar DNS"** no painel antes de emitir o certificado;
2. Confira manualmente: `dig +short seudominio.com` deve retornar o IP da VPS;
3. Se acabou de criar o registro, aguarde a propagação (minutos a horas, dependendo do TTL);
4. Se houver proxy na frente (ex.: Cloudflare com nuvem laranja), desative-o para a emissão
   inicial ou use o modo DNS-01 — o Caddy central espera conexão direta nas portas 80/443;
5. Verifique se o UFW/liberação do provedor permite 80 e 443.

### Domínio `.localhost` não abre

**Sintomas:** `meuapp.localhost` não resolve no navegador.

**Solução:** `.localhost` depende do sistema operacional resolver para 127.0.0.1 — funciona
nativamente no Linux/macOS modernos e no Chrome; se falhar, adicione ao `/etc/hosts`:
`127.0.0.1 meuapp.localhost`. Em dev, lembre-se de que `.localhost` é servido em **HTTP puro**.

---

## 🛠️ Painel e wizard

### Wizard inacessível (porta 9000)

**Sintomas:** `http://IP:9000/?token=...` não abre após rodar `install.sh`.

**Checklist:**
1. O serviço está de pé? `systemctl status paas-setup` e `journalctl -u paas-setup -n 50`;
2. O UFW está liberando? `sudo ufw allow 9000/tcp` (libere **só durante o setup** e feche
   depois: `sudo ufw delete allow 9000/tcp`);
3. O provedor tem firewall externo (security group)? Libere a 9000 nele também;
4. Token correto? O token é impresso no fim da instalação e salvo em `/etc/paas/setup-token`
   (`sudo cat /etc/paas/setup-token`).

### "Token inválido" no wizard

**Causa:** token errado, copiado com espaço extra, ou o servidor foi reiniciado com outro
`SETUP_TOKEN` no ambiente.

**Solução:** o valor de `SETUP_TOKEN` no ambiente tem prioridade sobre o arquivo. Reexiba a
URL + token a qualquer momento com `./scripts/show-token.sh` (lê o volume `paas_data`, sem
reinstalar nada).

### Perdi o token / quero recomeçar o wizard do zero

- **Perdeu o token:** `./scripts/show-token.sh` — imprime o banner com a URL e o token.
- **Recomeçar o wizard:** `./scripts/reset-setup.sh` — apaga `setup-state.json` do volume
  (com confirmação interativa) e o wizard volta ao passo 0; a conta admin é mantida.
  Com `--full` apaga também `users.json` e `sessions.json` (a conta admin deixa de existir
  e todos são deslogados). Projetos, domínios, e-mail e o token NÃO são tocados.

### Perdi o acesso SSH durante o hardening

**Não entre em pânico — é para isso que existe o rollback.** O hardening agenda uma reversão
automática (via `at`) que restaura a configuração anterior em ~5 minutos **se você não
confirmar o acesso** pelo painel. Aguarde o rollback, entre novamente e revise o plano de
correções antes de reaplicar. Cada arquivo alterado tem backup em `/var/backups/paas-hardening/`.

### Deploy bloqueado por guardrail

**Sintomas:** deploy retorna `409 guardrail_blocked` e a UI abre o modal de blockers.

**Solução:** o modal lista cada violação com **evidência** (arquivo:serviço) e **sugestão de
correção**. Corrija o compose/código (recomendado) — ex.: remova a porta do banco publicada no
host, troque credenciais fracas. Se tiver certeza do risco (ex.: banco exposto só em ambiente
de homologação), marque "Entendo os riscos" e confirme o override — ele fica **auditado** em
Auditoria (`guardrail.override`).

---

## 🐳 Docker

### "Cannot connect to the Docker daemon"

**Solução:** `systemctl status docker` — se o `install.sh` acabou de instalar, pode ser
necessário `sudo systemctl enable --now docker`. O painel acessa apenas o socket local
(`/var/run/docker.sock`); nunca exponha o Docker via TCP.

---

## Não achou seu problema?

Abra uma issue no repositório com o template de bug — inclua logs (sem segredos), versão do
commit e ambiente. Veja [CONTRIBUTING.md](../CONTRIBUTING.md).
