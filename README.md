# TWS Panel

Painel open source que transforma uma VPS Ubuntu numa plataforma de hospedagem própria: protege
a máquina, publica seus projetos com HTTPS e cuida do e-mail profissional.

[![Licença: MIT](https://img.shields.io/badge/licen%C3%A7a-MIT-green.svg)](LICENSE)
[![Status: beta](https://img.shields.io/badge/status-beta-yellow)](#roadmap)
[![CI](https://github.com/kelvindk9w/tws-panel/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/kelvindk9w/tws-panel/actions/workflows/ci.yml)

![Dashboard do TWS Panel com o roteiro "Deixe o painel pronto" e três projetos rodando](docs/imagens/dashboard.png)

> [!NOTE]
> **Projeto em beta.** A interface, os comandos e os formatos ainda podem mudar entre versões.
> Veja o que mudou em cada uma no [CHANGELOG](CHANGELOG.md).

## Por que existe

A TWS dependia de um serviço de hospedagem para publicar sites de clientes. Um dia, uma mudança
simples num site ficou parada por dias, sem resposta do suporte. O problema não era o servidor:
era depender de outra empresa para configurar tudo. O TWS Panel não é uma hospedagem. É o painel
que prepara a VPS que **você** contrata, no provedor que quiser — e vai junto se você trocar.

**Princípios:** não-invasivo (usa o Docker da máquina e não mexe no que já funciona), segurança
primeiro (nada entra no ar antes do hardening), minimalista (Fastify e arquivos JSON, sem banco de
dados) e open source (licença MIT).

## O que faz

Lista curta. O detalhe de cada item está em [docs/funcionalidades.md](docs/funcionalidades.md).

### 🚀 Deploy

- Código de um repositório git (público ou privado), da sua conta do GitHub ou de uma pasta do servidor.
- Detecta HTML puro, projeto com build, `Dockerfile` e `docker-compose` (o compose é adotado, sem ser reescrito).
- Vários domínios por projeto, com endereço automático `*.sslip.io` enquanto você não tem domínio.
- Vários ambientes do mesmo repositório (produção e sandbox lado a lado).
- Variáveis de ambiente cifradas, importação de `.env` e deploy barrado quando falta uma obrigatória.
- Portas por container: trocar, publicar, remover e editar em lote, com conflitos à vista.
- Logs do deploy ao vivo e "Por que falhou" com o log do serviço que ficou doente.

### 🔒 HTTPS e domínio do painel

- Certificados automáticos (Let's Encrypt) para painel, projetos e e-mail.
- Página **Certificados** com o estado de cada um, a causa provável quando falha e "Tentar emitir agora".
- Certificado próprio (manual) com conferência do par.
- Domínio próprio para o painel e, opcional, desativar o acesso pelo IP.

### ✉️ E-mail

- Servidor de e-mail próprio (Stalwart) com DKIM RSA 2048.
- Checklist de DNS verificável (A, MX, SPF, DKIM, DMARC e PTR), com instrução de PTR por provedor.
- Caixas com credenciais prontas para Outlook, Gmail ou celular, e e-mail de teste.
- E-mail do projeto: caixa própria e variáveis `SMTP_*` injetadas no deploy.
- Webmail (Roundcube) em `https://mail.<domínio>/`.
- Página **Envios**: fila, histórico, volume, listas de bloqueio e nota de entregabilidade.

### 🔔 Notificações

- Avisos pelo Telegram, por e-mail ou pelos dois: segurança, deploy, certificados, lista de bloqueio, disco, backups.
- Mensagens sem o IP da VPS, com agrupamento de repetidos e limite por hora.

### 💾 Backups

- Detecta bancos (PostgreSQL, MySQL, MariaDB, MongoDB, Redis), volumes e pastas de cada projeto.
- Backup do painel, do e-mail e dos projetos em `.7z`, com agenda e retenção.
- Cópia na VPS e no Cloudflare R2 (ou outro S3), conferida depois do envio.
- Criptografia opcional da cópia externa, com kit de recuperação.
- Restauração por item e "Restaurar de outro servidor" para montar tudo numa VPS nova.

### 🛡️ Segurança

- Wizard de hardening: Lynis, 8 fases com simulação e rollback automático nas que mexem no acesso.
- Guardrails de deploy: 6 regras, com override explícito e auditado.
- Monitoramento contínuo contra um baseline, central de alertas e log de auditoria.
- Verificação de listas de bloqueio de e-mail.
- Login com verificação em duas etapas (TOTP) e códigos de recuperação.

### 🖥️ Terminal web e roteiro

- Terminal real do servidor dentro do painel, com o usuário que você escolhe na instalação.
- Roteiro **Deixe o painel pronto** no Dashboard, com o que ainda falta configurar.

## Instalação rápida

**Requisitos**

- VPS com **Ubuntu 22.04 ou 24.04 LTS**, limpa. Mínimo recomendado: 1 vCPU, 2 GB de RAM e 25 GB de disco.
- Portas **80 e 443** abertas para a internet (o certificado HTTPS depende delas).
- Para o e-mail: a porta **25** liberada pelo provedor (muitos bloqueiam em contas novas).
- Docker, Node e o resto são instalados pelo instalador.

**Comandos essenciais, na ordem** (troque `SEU_IP` e `SEU_USUARIO`):

```bash
# 1. Na VPS, como root: crie o seu usuário com permissão de administrador
ssh root@SEU_IP
adduser SEU_USUARIO
usermod -aG sudo SEU_USUARIO
exit

# 2. No SEU computador: gere a chave SSH (se ainda não tiver) e instale na VPS
ssh-keygen -t ed25519
ssh-copy-id -i ~/.ssh/id_ed25519.pub SEU_USUARIO@SEU_IP

# 3. Na VPS, com o seu usuário: instale o git, clone e rode o instalador
ssh SEU_USUARIO@SEU_IP
sudo apt update && sudo apt install -y git
sudo git clone https://github.com/kelvindk9w/tws-panel.git /opt/tws-panel
sudo chown -R $USER:$USER /opt/tws-panel
cd /opt/tws-panel && git checkout main
./scripts/install.sh
```

> [!WARNING]
> **Já tem uma chave SSH?** Não rode o `ssh-keygen` por cima: ele apaga a antiga. O
> [Passo 4 do guia](docs/instalacao.md#passo-4) mostra como conferir e qual chave usar.

**O que acontece em seguida.** O instalador confere a máquina sem alterar nada, pergunta com qual
usuário o terminal do painel abre, instala o Docker, sobe o painel e termina mostrando o endereço
com HTTPS e o token de instalação: `https://203-0-113-10.sslip.io/?token=…` (com o seu IP). Abra
no navegador e siga o assistente: boas-vindas, saúde da máquina, segurança (hardening) e conta de
administrador.

O passo a passo completo, com o que aparece na tela e o que fazer quando algo dá errado, está em
**[docs/instalacao.md](docs/instalacao.md)**. Antes da etapa de segurança, leia o
[Wizard de segurança](docs/wizard-seguranca.md): ela desliga o login por senha no SSH.

## Depois de instalar

No primeiro acesso, o Dashboard mostra o roteiro **Deixe o painel pronto**. O estado de cada passo
é conferido pelo próprio painel, e cada um tem um "Como fazer" com o botão para a tela certa.

| # | Passo | O que é |
|---|---|---|
| 1 | Proteções da VPS | As fases de hardening: atualizações, SSH só com chave, firewall, bloqueio de tentativas e auditoria. |
| 2 | Verificação em duas etapas | Código de 6 dígitos do celular, além da senha, para entrar no painel. |
| 3 | Domínio do painel | Um endereço seu (`painel.exemplo.com.br`) no lugar do endereço com o IP. |
| 4 | E-mail do servidor *(opcional)* | Servidor de e-mail na VPS para os seus projetos enviarem mensagens. |
| 5 | Notificações *(opcional)* | Avisos pelo Telegram ou por e-mail quando algo precisa de atenção. |
| 6 | Backups fora da VPS *(opcional)* | Cópia cifrada no Cloudflare R2 (ou outro S3) para recuperar tudo numa VPS nova. |

Os passos opcionais aceitam "Não vou usar". O roteiro inteiro fica também em
**Configurações → Primeiros passos**.

<table>
  <tr>
    <td><img src="docs/imagens/projeto.png" alt="Página de um projeto: serviços do compose, domínios com HTTPS válido e e-mail do projeto ativo"></td>
    <td><img src="docs/imagens/email-dns.png" alt="Domínio de e-mail com o checklist de DNS todo verde (6/6 OK)"></td>
    <td><img src="docs/imagens/backups.png" alt="Configurações de backups com o Cloudflare R2 conectado e a criptografia ativa"></td>
  </tr>
  <tr>
    <td align="center">Projeto</td>
    <td align="center">E-mail com DNS conferido</td>
    <td align="center">Backups</td>
  </tr>
</table>

## Documentação

| Doc | Conteúdo |
|---|---|
| [Instalação](docs/instalacao.md) | Passo a passo completo numa VPS limpa (Passos 1 a 8) |
| [Wizard de segurança](docs/wizard-seguranca.md) | As 8 fases do hardening e como confirmar o acesso sem se trancar fora |
| [Funcionalidades](docs/funcionalidades.md) | O que cada módulo faz, em detalhe |
| [Operação](docs/operacao.md) | Atualizar, comandos úteis, scripts de emergência, pasta dos projetos, porta e usuário do terminal |
| [Perdi o acesso](docs/recuperar-acesso.md) | Senha, celular, chave SSH ou domínio do painel perdidos: o caminho de volta |
| [Segurança](docs/seguranca.md) | O que o painel protege e o que ele exige |
| [Produção](docs/production.md) e [problemas comuns](docs/troubleshooting.md) | Portas de e-mail, PTR, UFW; porta 25 bloqueada, e-mail em spam, certificado que não sai |
| [Desenvolvimento](docs/desenvolvimento.md) | Modo dev local e arquitetura |
| [Índice completo](docs/README.md) | Toda a documentação, inclusive specs e pesquisas |

## Segurança

Encontrou uma vulnerabilidade? **Não abra uma issue pública.** Veja o [SECURITY.md](SECURITY.md).

Um painel como este precisa de acesso privilegiado ao servidor: o terminal web é um shell real na
VPS, e o socket do Docker montado no painel equivale a root. Isso está explicado, junto com o que
o projeto **não** protege, em [docs/seguranca.md](docs/seguranca.md).

## Roadmap

Ainda não existe:

| Item | Descrição |
|---|---|
| Aquecimento de IP guiado | Limitar o volume de envio de um IP novo e aumentar aos poucos (hoje a nota de entregabilidade só conta os dias enviando) |
| Google Drive nos backups | Outro destino para a cópia externa, além do R2 e do S3 |
| Tradução EN/ES | Interface e documentação em inglês e espanhol |
| Multi-servidor | Gerenciar várias VPS a partir de um painel |
| MTA-STS / TLS-RPT | Política de TLS obrigatório no e-mail e relatórios de falha |
| BIMI | Logo verificado nas caixas de entrada (exige DMARC endurecido) |
| MCP para IA | Permitir que assistentes de IA operem o painel |

Já entregue: hardening, deploy e domínios, e-mail, guardrails e monitoramento, verificação em duas
etapas, certificados, domínio do painel, webmail, envios e entregabilidade, notificações e backups.
Veja o [CHANGELOG](CHANGELOG.md).

## Contribuir

Contribuições são bem-vindas. O [CONTRIBUTING.md](CONTRIBUTING.md) explica o setup local, os
testes, os padrões e o fluxo de pull request. Para rodar o painel no seu computador, veja
[docs/desenvolvimento.md](docs/desenvolvimento.md). Código de conduta:
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Sobre a TWS

O **TWS Panel** é mantido pela **TWS**, software house fundada e liderada pelo CEO **Kelvin**.
A TWS desenvolve soluções web, sistemas e automações sob medida para clientes. O projeto nasceu de
uma dor real da própria empresa e foi aberto à comunidade sob licença MIT.

- Site: [tws.tec.br](https://tws.tec.br/)
- E-mail: [contato@tws.tec.br](mailto:contato@tws.tec.br)
- LinkedIn: [Kelvin Medeiros](https://www.linkedin.com/in/kelvin-medeiros-37920487)

## Licença

[MIT](LICENSE) © 2026 TWS — Kelvin
