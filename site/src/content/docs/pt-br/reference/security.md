---
title: "Modelo de segurança: o que o painel faz e o que ele exige"
description: "O que o TWS Panel protege, o que ele exige de você (um shell real e o socket do Docker) e como funcionam o login e a verificação em duas etapas."
sidebar:
  label: "Modelo de segurança"
---

Encontrou uma vulnerabilidade? **Não abra uma issue pública.** Leia o
[SECURITY.md](https://github.com/kelvindk9w/tws-panel/blob/main/docs/community/pt-BR/SECURITY.md) para saber como reportar de forma responsável.

> [!NOTE]
> **Idioma da interface.** O painel está disponível em português e em inglês ([como escolher](../getting-started/complete-guide.md#idioma-da-interface)). Esta página cita os rótulos em português, exatamente como aparecem na tela. Algumas mensagens que vêm do servidor ainda aparecem em português mesmo com a interface em inglês (alertas, detalhes da auditoria, resultados das verificações de saúde e de segurança e muitas mensagens de erro).

Este documento explica o modelo de segurança do painel. Para conduzir o hardening da VPS, veja o
[Wizard de segurança](../getting-started/security-wizard.md). Para recuperar o acesso, veja
[Perdi o acesso: e agora?](../guides/recover-access.md).

## O que o painel protege

O painel foi desenhado com segurança em mente: wizard protegido por um setup token (ele deixa de valer, e o arquivo é apagado,
quando o setup termina), Docker socket não exposto via TCP, CORS same-origin por padrão, rate
limiting, validação de schema nas rotas da API, logs com redação de segredos e log de auditoria
das ações sensíveis.

- **Guardrails de deploy:** regras em 3 níveis (`block`, `warn`, `info`) — porta de banco exposta
  no host, credenciais fracas, serviço de dev em produção, secret comitado no código e tag
  `:latest`. Um bloqueio só passa com override explícito e auditado. O compose também é conferido
  do jeito que o Docker de fato o executa (depois de merge, include, extends e interpolação).
  Container privilegiado, `docker.sock` e bind fora da pasta do projeto são bloqueados, mas aceitam
  o mesmo override auditado. Só as regras que protegem o próprio painel não têm override: as
  imagens, redes, nomes reservados e recursos do painel não podem ser usados nem tomados por um
  projeto.
- **Isolamento entre projeto hospedado e painel:** redes Docker separadas para o proxy, o painel,
  a administração do e-mail e a entrega de e-mail; as imagens do painel são fixadas por digest; os
  hooks e a configuração do git do repositório hospedado nunca rodam com os privilégios do painel.
- **Monitoramento:** depois do hardening, um baseline registra pacotes, portas e hashes de
  arquivos críticos; as varreduras recorrentes comparam com ele e cada diferença vira alerta.
- **Segredos cifrados em disco:** variáveis de ambiente dos projetos, token do Telegram, chave do
  armazenamento de backup e senha da criptografia dos backups ficam cifrados no servidor. O token
  do Telegram e a chave do armazenamento nunca voltam para a tela; a senha dos backups só aparece
  em **Ver a senha**, que pede a senha de login e fica registrado na Auditoria.

## O que ele exige

Um PaaS precisa de acesso privilegiado ao host — não há
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
maiúsculas, minúsculas e números), o que conclui o setup, invalida o token para sempre e apaga o arquivo do token do servidor. Daí em
diante todo acesso exige login (`/login`): as sessões são revogáveis, persistidas no servidor
(cookie httpOnly, SameSite=Strict, expiração de 12h — nada de JWT stateless; em HTTPS o cookie se chama `__Host-paas_session`, o que obriga Secure e Path=/ e impede o atributo Domain), o login tem rate limit
de 5 tentativas/minuto por IP com lockout progressivo, e trocar a senha invalida as demais sessões.
Escritas (POST, PUT, PATCH, DELETE) que o navegador diz vir de outro site ou origem são recusadas com `403 forbidden_origin` antes da autenticação, inclusive no login. Login, logout, falhas e criação da conta admin ficam registrados no log de auditoria.

**Verificação em duas etapas (recomendada):** com o acesso por HTTPS o painel fica na internet, e
a senha sozinha passa a ser a única barreira. No menu do seu usuário (canto superior direito),
**Verificação em duas etapas** liga a exigência de um código de 6 dígitos do celular, gerado por
um app autenticador gratuito (Google Authenticator, Microsoft Authenticator ou outro). Você lê um
QR code, confirma com um código e recebe **10 códigos de recuperação** de uso único — guarde-os
fora do celular. O Dashboard lembra você enquanto ela estiver desligada.

**Travas do login com a verificação ligada:**

- **Bloqueio por conta no código de 6 dígitos.** Depois de **5 códigos errados seguidos**, vindos de
  qualquer IP, o código do app fica bloqueado por **5 minutos**; cada reincidência dobra o tempo, até
  **24 horas**. Durante o bloqueio nem o código certo do app entra, mas o **código de recuperação
  continua valendo** (é a saída do dono) e um login bem-sucedido zera tudo. O bloqueio fica gravado em
  disco: reiniciar o painel não o remove. Se não houver código de recuperação, o
  `sudo ./scripts/reset-2fa.sh --so-bloqueio` na VPS limpa só o bloqueio.
- **Aviso quando a senha certa chega sem o código certo.** Se alguém digita a sua senha e não conclui a
  verificação (ou erra o código), isso vai para a **Auditoria** e vira um **Alerta** (origem "acesso"),
  com notificação do tipo "segurança" se você ligou Telegram ou e-mail. Os avisos são agrupados (no
  máximo um por tipo a cada 15 minutos) e o bloqueio da conta avisa na hora. O aviso nunca traz senha
  nem código, e o IP aparece só mascarado (/24 no IPv4, /64 no IPv6). **Se não foi você, troque a senha.**
- **Limite também com a sessão aberta.** Trocar a senha, ativar ou desativar a verificação e recomeçar
  o assistente têm o mesmo bloqueio progressivo para senha ou código errados, contado por conta.
- **IPv6 por bloco /64.** O limite de tentativas por IP agrupa os endereços IPv6 do mesmo bloco /64;
  IPv4 continua por endereço.

**Atenção: não ligue o proxy da Cloudflare no domínio do painel.** Com o proxy ligado (nuvem laranja), o
painel enxerga o IP da Cloudflare e não o de quem tenta entrar: o limite por IP deixa de separar o
atacante do dono. Deixe o registro DNS do painel como **só DNS (nuvem cinza)**. Se o painel perceber os
cabeçalhos da Cloudflare, a tela **Segurança** mostra um aviso.
