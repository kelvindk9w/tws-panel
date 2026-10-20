---
title: "Do dev à VPS real: guia de produção"
description: "O que muda entre rodar o painel localmente e numa VPS Ubuntu exposta à internet: portas, DNS, PTR, TLS, firewall e ordem de configuração."
sidebar:
  label: "Guia de produção"
---

Este guia cobre tudo o que muda entre rodar o TWS Panel localmente (`pnpm dev`, domínios
`.localhost`, portas altas) e rodar em uma VPS Ubuntu 22.04/24.04 exposta na internet.

> [!NOTE]
> **Idioma da interface.** O painel está disponível em português e em inglês ([como escolher](../getting-started/complete-guide.md#idioma-da-interface)). Esta página cita os rótulos em português, exatamente como aparecem na tela. Algumas mensagens que vêm do servidor ainda aparecem em português mesmo com a interface em inglês (mensagens da checagem de DNS e de certificado, status do servidor de e-mail, alertas, detalhes da auditoria e muitas mensagens de erro).

> Leia também: [troubleshooting.md](troubleshooting.md) para os problemas mais comuns e
> [host-bridge.md](../reference/host-bridge.md) para entender como o scan/hardening roda na VPS real
> (e por que o container do painel é endurecido daquele jeito).

---

## 0. Requisitos do host criados pelo install.sh

O `scripts/install.sh` deixa tudo pronto; se você instala/atualiza manualmente, garanta:

- **DOCKER_GID no `.env`**: o painel roda como usuário não-root (`tws`) e acessa o
  `/var/run/docker.sock` via `group_add`. Sem o GID certo o socket nega acesso:
  ```bash
  echo "DOCKER_GID=$(stat -c %g /var/run/docker.sock)" >> .env
  docker compose up -d --build
  ```
- **Imagem do host bridge**: na primeira execução do scan/hardening com
  `PAAS_TARGET=host` o painel baixa o helper descartável do nsenter (`alpine:3`, fixado por
  digest em `packages/core/src/images.ts`). O mesmo vale para as imagens do Caddy, do Stalwart e
  dos builds de sites estáticos: a primeira instalação precisa de acesso ao registro. VPS sem
  saída para a internet? Baixe as imagens antes ou defina `PAAS_HOST_HELPER_IMAGE` com uma
  imagem local que tenha `nsenter`/`tar`/`sh`.
- O container do painel sobe com `cap_drop ALL`, `no-new-privileges` e rootfs
  read-only — só `/data` (volume) e `/tmp` (tmpfs) são graváveis. Não remova
  essas flags: o host bridge NÃO depende de capabilities do container.

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
- **E-mail (Stalwart)**: o Caddy central emite o certificado de `mail.<domínio>` (basta o
  registro A apontar para a VPS, nuvem cinza na Cloudflare) e o painel o instala e renova no
  Stalwart. Estado na página E-mail. Detalhes em [fase-3-email.md](https://github.com/kelvindk9w/tws-panel/blob/main/docs/internal/fase-3-email.md) §1.

### 1.4 PTR (rDNS)

O registro PTR (IP reverso → nome do servidor de e-mail) **só o provedor da VPS pode configurar**.
O checklist mostra o PTR em três níveis: verde (o nome reverso é o do servidor), azul (um nome
genérico do provedor que aponta de volta para o IP: funciona, mas é recomendado trocar) e amarelo
(sem nome reverso válido: Gmail, Yahoo e Microsoft podem recusar). Para Contabo, Hetzner e Vultr a
tela diz onde trocar no painel do provedor; para os demais, gera o texto pronto para abrir o
chamado. O PTR é um só para o servidor inteiro, mesmo com vários domínios.

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
                        O scan/hardening roda NA VPS REAL via host bridge
                        (nsenter — reference/host-bridge), não no container do painel.
                        Na Fase 01 cole sua CHAVE PÚBLICA SSH: o root só é travado
                        com a chave instalada, e o alerta pulsante pede para testar
                        o login em OUTRA janela SSH antes de confirmar (rollback
                        automático em 5 min se você não confirmar).
2. PAINEL             → conclua o wizard (conta admin). O painel abre em
                        https://SEU-IP-COM-HÍFENS.sslip.io, atrás do Caddy.
3. DOMÍNIO DO PAINEL  → Configurações → Domínio do painel: aponte
                        painel.seudominio.com para a VPS, verifique o DNS e
                        abra o painel pelo endereço novo.
4. PROJETOS           → cadastre e faça deploy dos projetos; para cada domínio,
                        use o botão **Verificar DNS** antes de emitir o certificado.
5. E-MAIL             → libere a porta 25 no provedor → inicie o servidor Stalwart
                        pelo painel → adicione o domínio de e-mail.
6. VERIFICAR DNS      → crie os registros do checklist (A, MX, SPF, DKIM, DMARC)
                        no seu provedor de DNS e clique em **Verificar agora** até fechar ✅.
                        Ajuste o PTR no provedor em paralelo (pode demorar).
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
- [ ] Painel escutando só em 127.0.0.1 (o padrão; quem atende de fora é o Caddy, nas portas 80/443)
- [ ] Porta 25 liberada pelo provedor + UFW
- [ ] PTR verde ou azul no checklist (de preferência, verde)
- [ ] Checklist DNS de e-mail 100% ✅ (A, MX, SPF, DKIM, DMARC)
- [ ] Teste de envio: [mail-tester](https://www.mail-tester.com) ≥ 9/10
- [ ] DMARC em `p=none` coletando relatórios → endurecer para `quarantine`/`reject` depois
- [ ] Baseline de segurança criado + monitoramento recorrente ativo
- [ ] Listas de bloqueio conferidas em **Envios → Reputação** (tudo limpo)
- [ ] Nenhum alerta crítico aberto em **Alertas**

---

## 4. Operação: token e reset do wizard

### Recuperar o setup token

O token é impresso no fim do `install.sh` e fica guardado no volume `paas_data`
(`/data/setup-token` dentro do container) até o wizard terminar. Enquanto isso, você pode
reexibi-lo a qualquer momento, sem reinstalar nada:

```bash
cd /opt/tws-panel
sudo ./scripts/show-token.sh
```

O script lê o arquivo do volume (sem fallback pela variável do container, que é a da instalação e é
ignorada quando já existe administrador), detecta o IP
público (best-effort; use `PAAS_PUBLIC_IP=<ip>` para fixar) e imprime o banner com a
URL completa `https://SEU-IP-COM-HÍFENS.sslip.io/?token=...` (no acesso por túnel, o comando
do túnel e o endereço `http://localhost:PORTA/?token=...`).

> Lembrete: depois que a conta admin é criada (passo 4 do wizard), o setup token deixa de
> valer e o arquivo é apagado, de propósito — a partir daí o acesso é pelo login normal.
> Para abrir o wizard de novo, com um token novo, use o `reset-setup.sh` abaixo.

### Resetar o setup (recomeçar o wizard do zero)

```bash
sudo ./scripts/reset-setup.sh           # volta o wizard ao passo 0 (conta admin mantida)
sudo ./scripts/reset-setup.sh --full    # + apaga usuários admin e sessões ativas
```

Ambos pedem confirmação interativa (digitar `resetar`) e reiniciam o painel ao final.
O que é apagado fica restrito ao volume `paas_data`: `setup-state.json` (sempre) e, no
modo `--full`, também `users.json` e `sessions.json`. **Projetos, domínios, e-mail,
histórico de segurança NÃO são tocados.** Em qualquer modo é gerado um setup token novo (o
antigo deixa de valer). Depois do reset, use `sudo ./scripts/show-token.sh` para pegar o link
do wizard de novo.
