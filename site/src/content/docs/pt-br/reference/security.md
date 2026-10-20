---
title: "Segurança: o que o painel faz e o que ele exige"
---

Encontrou uma vulnerabilidade? **Não abra uma issue pública.** Leia o
[SECURITY.md](https://github.com/kelvindk9w/tws-panel/blob/main/docs/community/pt-BR/SECURITY.md) para saber como reportar de forma responsável.

Este documento explica o modelo de segurança do painel. Para conduzir o hardening da VPS, veja o
[Wizard de segurança](../getting-started/security-wizard.md). Para recuperar o acesso, veja
[Perdi o acesso — e agora?](../guides/recover-access.md).

## O que o painel protege

O painel foi desenhado com segurança em mente: wizard protegido por token de uso único, Docker
socket nunca exposto via TCP, CORS same-origin por padrão, rate limiting, validação de schema em
todas as rotas da API, logs com redação de segredos e auditoria de todas as ações sensíveis.

- **Guardrails de deploy:** 6 regras em 3 níveis (`block`, `warn`, `info`) — porta de banco exposta
  no host, credenciais fracas, container privilegiado, serviço de dev em produção, secret comitado
  no código e tag `:latest`. Um bloqueio só passa com override explícito e auditado.
- **Monitoramento:** depois do hardening, um baseline registra pacotes, portas e hashes de
  arquivos críticos; as varreduras recorrentes comparam com ele e cada diferença vira alerta.
- **Segredos cifrados em disco:** variáveis de ambiente dos projetos, token do Telegram, chave do
  armazenamento de backup e senha da criptografia dos backups ficam cifrados no servidor. O token
  do Telegram e a chave do armazenamento nunca voltam para a tela; a senha dos backups só aparece
  em **Ver a senha**, que pede a senha de login e fica registrado na Auditoria.

## O que ele exige

**Seja franco sobre o que isto exige.** Um PaaS precisa de acesso privilegiado ao host — não há
como criar containers e configurar firewall sem ele. Duas consequências que você deve conhecer
antes de instalar:

- **O terminal web é um shell real na VPS**, não uma lista de ações pré-aprovadas. É o que
  permite ver e conduzir o hardening como se estivesse no SSH, e é também o ponto mais sensível
  do sistema. Na instalação você escolhe com qual usuário ele abre: com o seu usuário comum, o que
  precisa de root passa pelo `sudo` com a sua senha (modo `senha`) ou roda por trás e fica na
  Auditoria (modo `segundo-plano`); com `root`, quem tem sessão no painel tem o terminal de root
  da máquina. Veja [o que cada escolha significa](../getting-started/installation.md#terminal-do-painel).
- **O socket do Docker é montado no container do painel**, o que equivale a root no host. É uma
  propriedade do Docker, não uma falha do painel, e nenhum hardening do container altera isso.

Ambos estão documentados em detalhe, junto com o que o projeto **não** protege e as dívidas de
segurança conhecidas, em [comoFuncionaSistema/global/threat-model.json](https://github.com/kelvindk9w/tws-panel/blob/main/comoFuncionaSistema/global/threat-model.json).
Se o seu caso permitir, deixe o painel fora da internet aberta (acesso por túnel SSH, VPN ou
restrição por IP). No acesso padrão, por HTTPS, ative a verificação em duas etapas.

## Autenticação

**Login:** o painel nasce protegido pelo setup token gerado na instalação; na etapa
**Conta de administrador** do wizard você cria essa conta (senha com hash argon2id, mínimo de 12 caracteres com
maiúsculas, minúsculas e números), o que conclui o setup e invalida o token para sempre. Daí em
diante todo acesso exige login (`/login`): as sessões são revogáveis, persistidas no servidor
(cookie httpOnly, SameSite=Lax, expiração de 12h — nada de JWT stateless), o login tem rate limit
de 5 tentativas/minuto por IP com lockout progressivo, e trocar a senha invalida as demais sessões.
Login, logout, falhas e criação da conta admin ficam registrados no log de auditoria.

**Verificação em duas etapas (recomendada):** com o acesso por HTTPS o painel fica na internet, e
a senha sozinha passa a ser a única barreira. No menu do seu usuário (canto superior direito),
**Verificação em duas etapas** liga a exigência de um código de 6 dígitos do celular, gerado por
um app autenticador gratuito (Google Authenticator, Microsoft Authenticator ou outro). Você lê um
QR code, confirma com um código e recebe **10 códigos de recuperação** de uso único — guarde-os
fora do celular. O Dashboard lembra você enquanto ela estiver desligada.
