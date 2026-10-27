---
title: "Perdi o acesso: e agora?"
description: "Como voltar a entrar depois de perder a senha do painel, o celular da verificação em duas etapas, a senha do Linux, a chave SSH ou o domínio do painel."
sidebar:
  label: "Recuperar acesso"
---

O hardening fecha portas de propósito, e isso corta caminhos de volta. Esta seção existe para
você não descobrir isso no pior momento. Achou seu caso na tabela? Vá direto para ele.

> [!NOTE]
> **Idioma da interface.** O painel está disponível em português e em inglês ([como escolher](../getting-started/complete-guide.md#idioma-da-interface)). Esta página cita os rótulos em português, exatamente como aparecem na tela. Algumas mensagens que vêm do servidor ainda aparecem em português mesmo com a interface em inglês (alertas, detalhes da auditoria, resultados das verificações de saúde e de segurança e muitas mensagens de erro).

| O que você perdeu | O que ainda funciona | Caminho de volta |
|---|---|---|
| Senha do **painel** (login web) | SSH na VPS | `sudo ./scripts/reset-senha.sh` (mantém conta, 2FA, projetos e domínios) ou, para apagar a conta, `sudo ./scripts/reset-setup.sh --full` |
| **Celular** da verificação em duas etapas | Códigos de recuperação | No login, digite um código de recuperação no lugar do código do app |
| **Celular** e os códigos de recuperação | SSH na VPS | `sudo ./scripts/reset-2fa.sh` |
| Senha do **usuário Linux** (a do `sudo`) | Painel acessível | **Configurações → Acesso à VPS → Senha do usuário** (ou, se o terminal do painel abre como root, `passwd SEU_USUARIO`); senão, console do provedor |
| **Chave SSH** | Painel acessível | **Configurações → Acesso à VPS → Chaves SSH** (ou o terminal do painel, se ele abre com o seu usuário ou root) |
| **Chave SSH** e não entro no painel | Console do provedor | `sudo /opt/tws-panel/scripts/recuperar-acesso.sh` opção 5 (instala a chave pública da sua conta do GitHub) ou, no console, `echo "CHAVE" >> ~/.ssh/authorized_keys` |
| **Domínio do painel** (com o acesso pelo IP desativado) | SSH na VPS | `sudo ./scripts/reativar-acesso-ip.sh` |
| Meu **computador** (formatei, perdi ou roubaram) | Painel acessível | **Configurações → Acesso à VPS → Chaves SSH**: cadastre a chave nova |
| Meu computador **e** não entro no painel | Console do provedor | `sudo /opt/tws-panel/scripts/recuperar-acesso.sh` opção 5 (chave do GitHub) |
| **Fui bloqueado** (fail2ban) por errar a chave | Painel acessível, ou console do provedor | **Configurações → Acesso à VPS → IPs bloqueados**, ou `recuperar-acesso.sh` opção 1 |
| Senha do painel, **sem apagar a conta** | Console do provedor ou SSH | `recuperar-acesso.sh` opção 4 (mantém 2FA, projetos e domínios) |
| Tudo acima | — | Modo de recuperação (rescue) do provedor |

> [!IMPORTANT]
> **Confirme o seu caminho de recuperação ANTES de aplicar o hardening.** Entre no painel do seu
> provedor e procure por "Console", "VNC", "Rescue" ou "Modo de recuperação". Se você não achar
> nenhum, a prevenção descrita no [Passo 4 da instalação](../getting-started/installation.md#passo-4) deixa de ser recomendação e passa a ser obrigatória:
> sem console, não existe rede de segurança e uma chave perdida pode significar reinstalar a
> máquina do zero.

## Comece pelo painel

Se você ainda entra no painel, **ele é o caminho principal** e quase nunca precisa do console do provedor:

- **Configurações → Acesso à VPS**: cadastra e remove chaves SSH, troca a senha do usuário Linux, mostra e desbloqueia IPs bloqueados e gera o kit de recuperação. Tudo pede a senha do painel + o código do app (+ o código por e-mail, se você ligou).
- **Terminal web do painel**: não usa SSH, então funciona mesmo com a chave perdida, o SSH desligado ou o `sshd` quebrado.

O **console do provedor** só entra em cena quando o painel **também** se perdeu. E a senha do usuário Linux serve **apenas** para o console do provedor e para o `sudo`: o SSH continua só por chave, **nunca por senha**, nem por um tempo.

## Perdi a senha do painel

Quer manter a conta, o 2FA, os projetos e os domínios? Pelo console do provedor rode `sudo /opt/tws-panel/scripts/recuperar-acesso.sh` e escolha a opção 4: ela só troca a senha do painel (e encerra as sessões e revoga os tokens de API).

A conta de administrador do painel é independente do sistema. Com acesso SSH à VPS, apague a
conta e refaça a etapa **Conta de administrador** do wizard:

```bash
cd /opt/tws-panel
sudo ./scripts/reset-setup.sh --full
sudo ./scripts/show-token.sh
```

O primeiro comando apaga a conta admin e todas as sessões (pede confirmação: digite `resetar`).
O segundo mostra o setup token de novo, para você reabrir o wizard e criar uma conta nova.

Ainda entra no painel e quer refazer o assistente? Em **Setup** (com o setup concluído) há
**Recomeçar do zero**: pede a senha atual, o código da verificação em duas etapas e que você digite
a palavra de confirmação (`recomeçar` com a interface em português, `restart` com a interface em
inglês; `recomeçar` vale nos dois) antes de clicar em **Apagar e recomeçar**; apaga a conta e as sessões e já abre o assistente com um token novo. Sem a
verificação em duas etapas ativa, o painel não oferece esse botão — use o script acima.

**Seus projetos, domínios, e-mail e histórico de segurança não são tocados.**

## Perdi o celular da verificação em duas etapas

No login, digite um dos seus **códigos de recuperação** no campo do código (cada um vale uma
vez). Já dentro do painel, desative e ative de novo a verificação para cadastrar o celular novo e
receber códigos novos.

**Bloqueado por erros no código?** Depois de 5 códigos errados seguidos o código do app fica
bloqueado (5 minutos, dobrando a cada reincidência até 24 horas), mas o **código de recuperação
continua entrando**. Sem código de recuperação, e com o celular em mãos, limpe só o bloqueio na VPS
(`sudo ./scripts/reset-2fa.sh --so-bloqueio`, confirmação: `liberar`; a verificação continua ligada).

Perdeu também os códigos? Com acesso SSH à VPS:

```bash
cd /opt/tws-panel
sudo ./scripts/reset-2fa.sh
```

Ele pede confirmação (digite `desligar`), para o painel por alguns segundos, desliga a
verificação em duas etapas (e limpa qualquer bloqueio por códigos errados) e sobe o painel de novo. Entre só com usuário e senha e ative a
verificação outra vez. **Nada mais é tocado.**

## Perdi a senha do usuário Linux

Se você ainda entra no painel, a saída mais simples é **Configurações → Acesso à VPS → Senha do usuário**: digite a nova senha duas vezes e confirme com a senha do painel e o código do app. Ela nunca aparece em log nem na auditoria.

Essa é a mais traiçoeira, porque parece que está tudo bem: a chave SSH ainda te deixa entrar, mas
nenhum `sudo` funciona — e o hardening travou a senha do root, então não dá para virar root pelo
caminho normal.

**Se o terminal do painel abre como root** (a escolha `root` na instalação, ou uma instalação
anterior a essa pergunta), ele é a saída. No painel, abra o terminal e rode:

```bash
passwd SEU_USUARIO
```

Defina a nova senha e pronto.

**Se ele abre com o seu usuário**, esse caminho não existe, e é de propósito: no modo `senha`, o
`sudo` pediria justamente a senha que você perdeu; no modo `segundo-plano`, o painel só executa
como root os próprios comandos de varredura e hardening, não um `passwd` qualquer. A saída é o
**console do provedor** ou o modo de recuperação — por isso vale confirmar que eles funcionam
antes do hardening.

## Perdi a chave SSH

Você precisa reinstalar uma chave nova em `~/.ssh/authorized_keys` do seu usuário. Gere um par
novo no seu computador ([Passo 4 da instalação](../getting-started/installation.md#passo-4)) e use um dos caminhos abaixo, na ordem:

**1. Pelo terminal do painel** — se você ainda consegue entrar no painel. Se ele abre com o
**seu usuário**, a pasta `~/.ssh` é dele, e não precisa de root nenhum:

```bash
echo "COLE_AQUI_A_NOVA_CHAVE_PUBLICA" >> ~/.ssh/authorized_keys
```

Se ele abre como **root**, informe o caminho completo:

```bash
echo "COLE_AQUI_A_NOVA_CHAVE_PUBLICA" >> /home/SEU_USUARIO/.ssh/authorized_keys
```

(Escolheu na instalação um usuário diferente do que você usa no SSH? Então o terminal não alcança a
pasta do seu usuário sem root — siga para o caminho 2.)

**2. Pelo console do provedor** — o acesso via navegador não passa pelo SSH, então a restrição de
login por senha não vale ali. Entre com o seu usuário e a senha, e rode o mesmo comando (sem o
caminho completo, já que você está logado como ele):

```bash
echo "COLE_AQUI_A_NOVA_CHAVE_PUBLICA" >> ~/.ssh/authorized_keys
```

Sem a chave pública à mão, mas com ela cadastrada na sua conta do GitHub? Use a opção 5 do
`recuperar-acesso.sh` (veja [o comando único](#comando-único-pelo-console-do-provedor)): ele baixa as chaves públicas de
`https://github.com/SEU_USUARIO.keys`, mostra as impressões digitais para você conferir e só grava depois da sua confirmação.

> [!TIP]
> **O painel ou o script recusou mexer no `authorized_keys`** (erro `ssh_dir_unsafe`, "link simbólico, outro dono
> ou gravável por outros")? Quase sempre o arquivo ou a pasta `~/.ssh` ficou com o dono `root` (por exemplo,
> depois de editar com `sudo`). Pelo console, como administrador, corrija com:
> `sudo chown -R SEU_USUARIO: /home/SEU_USUARIO/.ssh && sudo chmod 700 /home/SEU_USUARIO/.ssh && sudo chmod 600 /home/SEU_USUARIO/.ssh/authorized_keys`.
> Se for um link simbólico, apague o link e recrie um arquivo comum.

**3. Pelo modo de recuperação** — último recurso. O provedor inicia a máquina por outro sistema e
monta o seu disco, permitindo editar o `authorized_keys` de fora. O procedimento varia por
provedor; procure na documentação dele por "rescue mode".

> [!WARNING]
> Sempre `>>`, nunca `>`. Um `>` sozinho **apaga** as chaves que já estavam lá — inclusive a que
> você talvez ainda estivesse usando. Confira o resultado com `cat ~/.ssh/authorized_keys` antes
> de fechar a sessão, e teste a conexão numa janela nova **antes** de encerrar a que funciona.

## O domínio do painel parou de abrir

Vale para quem cadastrou um domínio em **Configurações → Domínio do painel** e depois desativou o
acesso pelo IP. Se o domínio deixar de abrir (DNS apagado ou trocado, domínio vencido,
certificado que não renovou), religue o endereço pelo IP com acesso SSH à VPS:

```bash
cd /opt/tws-panel && sudo ./scripts/reativar-acesso-ip.sh
```

O script para o painel, volta a ligar o acesso pelo IP (o domínio continua cadastrado), sobe o
painel e confere que o proxy voltou a ter o endereço pelo IP. Depois, abra
`https://SEU-IP-COM-HÍFENS.sslip.io` e entre de novo. Usuário, senha, projetos e o resto ficam
como estão.

## Formatei o computador (ou perdi, ou roubaram)

Se você ainda entra no painel, **não precisa do console do provedor**:

1. No computador novo, abra um terminal (PowerShell no Windows) e rode `ssh-keygen -t ed25519 -C "meu-notebook"`. Ele cria um par de chaves; o arquivo que termina em `.pub` é a chave **pública**, a única que se compartilha.
2. No painel, vá em **Configurações → Acesso à VPS → Chaves SSH**, cole a linha inteira do arquivo `.pub` e confirme com a senha do painel, o código do app e, se você ligou, o código enviado por e-mail.
3. Teste numa janela nova de terminal. Só depois, se o computador antigo foi roubado ou perdido, **remova a chave antiga** na mesma lista. O painel nunca remove a última chave: você não se tranca fora por engano.

O painel não gera chave privada no navegador, não abre o SSH por senha e não mexe no firewall: ele só coloca ou tira linhas do `authorized_keys` do seu usuário. Uma chave com restrição (`from=`, `command=`) não conta como "outra chave": o painel não deixa sobrar só ela.

**Também perdeu o acesso ao painel?** Use o comando único da seção seguinte.

## Comando único pelo console do provedor

Pelo console do provedor (VNC/"Console"), entre com o usuário Linux e a senha dele e rode:

```bash
sudo /opt/tws-panel/scripts/recuperar-acesso.sh
```

O menu oferece:

1. **Desbloquear o fail2ban** (para quando você errou a chave e foi banido).
2. **Reativar o acesso pelo endereço de IP** do painel (o que `reativar-acesso-ip.sh` faz).
3. **Desligar a verificação em duas etapas**, só o **código por e-mail** ou só o bloqueio por códigos errados.
4. **Redefinir só a senha do painel**, sem apagar a conta, o 2FA, os projetos ou os domínios.
5. **Instalar a chave pública de uma conta do GitHub** no usuário de administração: você informa o nome da conta, o script baixa `https://github.com/NOME.keys`, mostra o tipo e a impressão digital de cada chave (compare com a lista em `https://github.com/settings/keys`) e só grava no `authorized_keys` depois de você digitar `s`. A gravação é feita como o próprio usuário, sem seguir link simbólico, de forma atômica e com backup datado.

O script é seguro de repetir. A senha do Linux é a que você guardou no gerenciador de senhas (ou a que trocou em **Configurações → Acesso à VPS**); ela vale **só** para o console do provedor e para o `sudo`. Nenhuma opção abre o SSH por senha: depois de instalar a chave (opção 5), entre por SSH com ela.

## Fui bloqueado

Depois de 3 chaves erradas seguidas, o fail2ban bloqueia o seu IP por 6 horas (mais, se insistir). Isso acontece, por exemplo, ao tentar entrar com a chave do computador antigo. Com o painel aberto, veja e desbloqueie em **Configurações → Acesso à VPS → IPs bloqueados** (o seu IP aparece marcado). Sem o painel, use `recuperar-acesso.sh` opção 1 pelo console do provedor.

## Quanto confiar em cada saída

Da mais fácil para a mais drástica, use a primeira que serve:

1. **Painel** (Acesso à VPS): precisa de senha + código do app (+ código por e-mail, se ligado).
2. **Código de recuperação** do 2FA, no login.
3. **Console do provedor** com `recuperar-acesso.sh`: precisa da senha do usuário Linux e da conta do provedor.
4. **Modo de recuperação (rescue)** do provedor: último recurso.

No topo de tudo está a **conta do seu provedor** (a senha e o 2FA dela): quem a controla controla a VPS. Nunca a perca.

## Código por e-mail (opcional)

Em **Configurações → Segurança → Código por e-mail** você pode ligar um **terceiro fator**, desligado por padrão. Ligado, as ações sensíveis (chaves SSH, senha do Linux, desbloqueio de IP, kit, desligar o 2FA, gerar códigos de recuperação novos, trocar a senha do painel, recomeçar o assistente e criar tokens de API) pedem também um código de 6 dígitos enviado ao seu e-mail (vale 10 minutos, uma vez só). Para ligar é preciso ter o 2FA ligado, um e-mail no perfil e o envio de e-mail do painel funcionando.

> [!WARNING]
> Use um e-mail **de fora da VPS** (Gmail, por exemplo). Uma caixa hospedada na própria VPS cai junto com ela, justamente quando você precisaria do código; o painel avisa se detectar isso. Se o e-mail parar de chegar, a saída é `recuperar-acesso.sh` opção 3 pelo console do provedor.

## Kit de recuperação e códigos de recuperação

Em **Configurações → Acesso à VPS → Kit de recuperação** o painel gera uma folha para **imprimir ou baixar**, com o endereço do painel, o usuário, a porta, as impressões digitais das chaves e o passo a passo. Ela **não contém senha, chave privada nem códigos**. Guarde-a junto com os códigos de recuperação do 2FA (que você pode trocar por 10 novos, sem desligar o 2FA, em **Configurações → Segurança**; o painel avisa quando restam 3 ou menos).

## Faça isto antes de precisar

- Guarde uma **chave SSH de reserva** (com senha de proteção) no gerenciador de senhas e em um pendrive, e cadastre a **pública** dela no painel.
- Anote a **senha do usuário Linux** no gerenciador de senhas e **teste o console do provedor** (login e `sudo`).
- Guarde os **códigos de recuperação** do 2FA impressos e o **2FA da conta do provedor**.
- Se ligar o código por e-mail, use um endereço externo.
- A cada seis meses, simule: cadastre uma chave de teste, remova, abra o console do provedor e rode o menu sem escolher nada.

## O paradoxo do terminal do painel

Você deve ter notado que o terminal embutido aparece duas vezes como salvação. Quanto mais poder
ele tem, mais ele salva — e mais perigoso ele é. Aberto como root, ele é a porta dos fundos quando
tudo o mais falha, e exatamente por isso o ponto mais sensível do sistema. Aberto com o seu
usuário (o recomendado), ele salva menos, mas uma sessão esquecida também entrega menos.

Vale saber que é assim, e decidir conscientemente: manter o painel acessível é uma rede de
segurança, mas é também a maior superfície de ataque da instalação. Se você optar por restringir
o acesso a ele, garanta antes que o console do seu provedor funciona.
