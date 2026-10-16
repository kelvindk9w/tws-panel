# Perdi o acesso — e agora?

O hardening fecha portas de propósito, e isso corta caminhos de volta. Esta seção existe para
você não descobrir isso no pior momento. Achou seu caso na tabela? Vá direto para ele.

| O que você perdeu | O que ainda funciona | Caminho de volta |
|---|---|---|
| Senha do **painel** (login web) | SSH na VPS | `sudo ./scripts/reset-setup.sh --full` |
| **Celular** da verificação em duas etapas | Códigos de recuperação | No login, digite um código de recuperação no lugar do código do app |
| **Celular** e os códigos de recuperação | SSH na VPS | `sudo ./scripts/reset-2fa.sh` |
| Senha do **usuário Linux** (a do `sudo`) | SSH + painel | Terminal do painel (se ele abre como root) → `passwd SEU_USUARIO`; senão, console do provedor |
| **Chave SSH** | Painel acessível | Terminal do painel (se ele abre com o seu usuário ou root) → recoloca a chave |
| **Chave SSH** | Console do provedor | Login com usuário e senha → recoloca a chave |
| **Domínio do painel** (com o acesso pelo IP desativado) | SSH na VPS | `sudo ./scripts/reativar-acesso-ip.sh` |
| Tudo acima | — | Modo de recuperação (rescue) do provedor |

> [!IMPORTANT]
> **Confirme o seu caminho de recuperação ANTES de aplicar o hardening.** Entre no painel do seu
> provedor e procure por "Console", "VNC", "Rescue" ou "Modo de recuperação". Se você não achar
> nenhum, a prevenção descrita no [Passo 4 da instalação](instalacao.md#passo-4) deixa de ser recomendação e passa a ser obrigatória:
> sem console, não existe rede de segurança e uma chave perdida pode significar reinstalar a
> máquina do zero.

## Perdi a senha do painel

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
`recomeçar`; apaga a conta e as sessões e já abre o assistente com um token novo. Sem a
verificação em duas etapas ativa, o painel não oferece esse botão — use o script acima.

**Seus projetos, domínios, e-mail e histórico de segurança não são tocados.**

## Perdi o celular da verificação em duas etapas

No login, digite um dos seus **códigos de recuperação** no campo do código (cada um vale uma
vez). Já dentro do painel, desative e ative de novo a verificação para cadastrar o celular novo e
receber códigos novos.

Perdeu também os códigos? Com acesso SSH à VPS:

```bash
cd /opt/tws-panel
sudo ./scripts/reset-2fa.sh
```

Ele pede confirmação (digite `desligar`), para o painel por alguns segundos, desliga a
verificação em duas etapas e sobe o painel de novo. Entre só com usuário e senha e ative a
verificação outra vez. **Nada mais é tocado.**

## Perdi a senha do usuário Linux

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
novo no seu computador ([Passo 4 da instalação](instalacao.md#passo-4)) e use um dos caminhos abaixo, na ordem:

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

## O paradoxo do terminal do painel

Você deve ter notado que o terminal embutido aparece duas vezes como salvação. Quanto mais poder
ele tem, mais ele salva — e mais perigoso ele é. Aberto como root, ele é a porta dos fundos quando
tudo o mais falha, e exatamente por isso o ponto mais sensível do sistema. Aberto com o seu
usuário (o recomendado), ele salva menos, mas uma sessão esquecida também entrega menos.

Vale saber que é assim, e decidir conscientemente: manter o painel acessível é uma rede de
segurança, mas é também a maior superfície de ataque da instalação. Se você optar por restringir
o acesso a ele, garanta antes que o console do seu provedor funciona.
