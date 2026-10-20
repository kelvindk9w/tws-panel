---
title: "Instalação passo a passo"
---

Guia completo para instalar o TWS Panel numa VPS limpa, do zero até o assistente de
configuração (wizard). O [README](https://github.com/kelvindk9w/tws-panel/blob/main/README.pt-BR.md) tem a versão curta; este guia explica cada
passo, o que aparece na tela e o que fazer quando algo dá errado.

Os passos são numerados de 1 a 8. Os scripts do painel (`install.sh`, `uninstall.sh`) citam
esses números.

| Passo | Onde | O que faz |
|---|---|---|
| [1](#passo-1) | Provedor | Contratar a VPS |
| [2](#passo-2) | Seu computador → VPS | Entrar como root e conferir o sistema |
| [3](#passo-3) | VPS | Criar o seu usuário não-root |
| [4](#passo-4) | Seu computador | Gerar a chave SSH e instalar na VPS |
| [5](#passo-5) | VPS | Instalar o git |
| [6](#passo-6) | VPS | Clonar o repositório em `/opt/tws-panel` |
| [7](#passo-7) | VPS | Rodar o instalador |
| [8](#passo-8) | Navegador | Abrir o painel e seguir o wizard |

Depois do Passo 8, a etapa de Segurança do wizard tem um guia próprio:
[Wizard de segurança](security-wizard.md).

## Antes de começar

> [!NOTE]
> **Único pré-requisito:** uma VPS com Ubuntu 22.04 ou 24.04 LTS limpa. Docker, Node e todo o resto são instalados automaticamente — basta seguir os passos abaixo, na ordem.

<details>
<summary>⚠️ <strong>Deu erro ao conectar: "REMOTE HOST IDENTIFICATION HAS CHANGED!"</strong></summary>

<a id="host-identification-changed"></a>

Se, ao tentar conectar, apareceu isto em letras garrafais e a conexão foi recusada:

```text
@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @
@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
IT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!
...
Host key verification failed.
```

**O que aconteceu.** O SSH guarda a "digital" de cada servidor em que você já entrou. A digital
que o servidor apresentou agora é **diferente** da que está guardada no seu computador — e o SSH
prefere recusar a conexão a te conectar num servidor que pode não ser o seu.

**Quando isso é esperado:** você reinstalou o sistema da VPS, trocou de VPS, ou o provedor
reatribuiu aquele mesmo IP a outra máquina. Nesses casos o servidor é outro de verdade, e a
digital antiga não vale mais.

**A solução** — apague a digital antiga daquele IP e conecte de novo. Rode **no seu computador**:

```bash
ssh-keygen -R SEU_IP
ssh root@SEU_IP
```

Ele vai perguntar se você confia na nova identidade — responda `yes`. Pronto, a conexão volta ao
normal.

> [!IMPORTANT]
> **Esse aviso não é burocracia.** Ele é a única defesa do SSH contra alguém se passando pelo seu
> servidor. Ignorá-lo é seguro **só quando você sabe por que a identidade mudou** — e reinstalar o
> sistema é um motivo legítimo. Se ele apareceu **sem** que você tenha reinstalado ou trocado de
> máquina, **não continue**: investigue antes.

</details>

<details>
<summary>🔄 <strong>Já tinha o painel instalado e quer começar de novo?</strong></summary>

Antes de reinstalar a máquina inteira, veja se o caso é mesmo esse — quase sempre não é.

**Só quero refazer o assistente de configuração.** Não precisa reinstalar nada. Na VPS:

```bash
cd /opt/tws-panel
sudo ./scripts/reset-setup.sh     # o wizard volta ao passo 0
sudo ./scripts/show-token.sh      # mostra o setup token de novo
```

Seus projetos, domínios, e-mail e histórico de segurança continuam intactos. Use `--full` no
primeiro comando se quiser apagar também a conta de administrador do painel.

<a id="remover-o-painel"></a>

**Quero remover o painel e instalar de novo, sem reinstalar o sistema.** Serve para testar a
instalação quantas vezes quiser. Na VPS:

```bash
cd /opt/tws-panel
./scripts/uninstall.sh --dry-run   # só mostra o que seria apagado; não mexe em nada
./scripts/uninstall.sh             # mostra de novo e pede para você digitar "remover"
```

Ele apaga **tudo o que o painel criou**: o painel e os containers dele, o proxy (Caddy), o servidor
de e-mail, os projetos implantados com seus dados, a pasta `/opt/tws-projects`, os scripts de
hardening copiados para a VPS e, por último, a própria pasta `/opt/tws-panel`. Antes de apagar, ele
lista exatamente o que encontrou. Depois, entre em outra pasta (`cd ~`) e **recomece pelo [Passo 6](#passo-6)**
(clonar o repositório) — o git do Passo 5 continua instalado. Quer manter a pasta do repositório?
Use `--keep-repo` e vá direto ao [Passo 7](#passo-7).

> [!WARNING]
> **O que ele NÃO desfaz:** as fases de segurança que já foram aplicadas continuam valendo — a
> senha do root segue travada, o SSH segue sem login por senha, o firewall, o fail2ban e os pacotes
> removidos ficam como estão. Seu usuário, a chave SSH instalada nele e o Docker também ficam. Para
> uma VPS realmente do zero, o caminho é o próximo: reinstalar o sistema.

**Quero a máquina limpa de verdade.** Aí sim é reinstalação do sistema operacional, e ela acontece
em dois lugares:

**1. No painel do seu provedor de VPS.** Procure por "Reinstall", "Reimage" ou "Reinstalar sistema"
— o nome muda conforme o provedor. Escolha **Ubuntu 24.04 LTS** e **anote a nova senha de root**
que ele gerar; a antiga deixa de valer.

> [!WARNING]
> Reinstalar apaga **tudo**: seus projetos, bancos de dados, e-mails, certificados TLS e o painel.
> Não há desfazer. Se houver algo que você queira manter, copie antes.

**2. No seu computador.** Como o sistema é outro, o servidor passa a se identificar com uma chave
diferente, e a sua próxima conexão vai ser **recusada** com o aviso
`REMOTE HOST IDENTIFICATION HAS CHANGED!`. Isso é esperado, e a solução está no bloco logo acima:

**[⬆️ Deu erro ao conectar: "REMOTE HOST IDENTIFICATION HAS CHANGED!"](#host-identification-changed)**

Depois disso é só seguir do Passo 1 em diante, como numa VPS nova — porque agora ela é uma.

</details>

<a id="passo-1"></a>

## Passo 1 — Contrate uma VPS

Contrate uma VPS com Ubuntu 24.04 LTS (mínimo recomendado: 1 vCPU / 2 GB RAM / 25 GB de disco).

> [!NOTE]
> **Nunca contratou uma VPS antes?** Este guia começa no momento em que você já tem **um IP e uma
> senha de root** em mãos. Como contratar, pagar e escolher a região muda de provedor para
> provedor, quem documenta essa parte melhor é o próprio provedor — procure por "primeiros passos"
> ou "getting started" na central de ajuda dele, e escolha **Ubuntu 24.04 LTS** na criação.
>
> Travou aí, antes de ter o IP? [Fale com a TWS](https://tws.tec.br/) — a gente ajuda e, se o seu
> caso for comum, ele entra nesta documentação.

<a id="passo-2"></a>

## Passo 2 — Acesse como root via SSH

Entre na VPS e confirme a versão do SO:

```bash
ssh root@SEU_IP
cat /etc/os-release   # esperado: PRETTY_NAME="Ubuntu 24.04.x LTS" (ou 22.04)
```

<details>
<summary>🔐 <strong>Primeira vez conectando via SSH? O que aparece e o que responder</strong></summary>

Na **primeira conexão** com qualquer servidor novo, o SSH mostra este aviso:

```text
The authenticity of host '203.0.113.10 (203.0.113.10)' can't be established.
ED25519 key fingerprint is SHA256:Xk9vN2mQpL7dR4wT8yB3cF6hJ1uA5sE0gH9zK2xW4vM.
This key is not known by any other names.
Are you sure you want to continue connecting (yes/no/[fingerprint])?
```

**O que responder:** digite `yes` e pressione Enter.

**O que é isso?** O *fingerprint* é a "digital" do servidor — é assim que o seu computador
reconhece a VPS nas próximas conexões. O aviso aparece **só na primeira vez**; depois o
fingerprint fica salvo e a conexão é direta.

**Erros comuns:**

- **"Digito a senha e nada aparece"** — é normal! O terminal **não mostra nenhum caractere**
  (nem `*`) enquanto você digita senhas. Digite com calma e pressione Enter.
- **`Permission denied (publickey,password)`** — senha errada ou o provedor da VPS exige
  chave SSH. Confira a senha no painel do provedor e tente de novo.
- **O aviso de fingerprint aparece de novo depois de reinstalar a VPS** — normal, a máquina
  mudou. Remova a entrada antiga com `ssh-keygen -R SEU_IP` e conecte novamente.

</details>

<a id="passo-3"></a>

## Passo 3 — Crie o seu usuário não-root

É ele quem vai operar a VPS daqui em diante:

```bash
adduser SEU_USUARIO           # troque SEU_USUARIO pelo nome que quiser; você escolhe a senha na hora
usermod -aG sudo SEU_USUARIO  # dá permissão de administrador (sudo)


# --- Errou a senha, desistiu no meio ou quer recomeçar? Escolha UMA das duas: ---
passwd SEU_USUARIO                  # define/redefine só a senha, mantendo o usuário
deluser --remove-home SEU_USUARIO   # apaga o usuário e a pasta dele, para criar tudo de novo
```

<details>
<summary>👤 <strong>Travou no <code>adduser</code>? O que aparece e o que preencher</strong></summary>

Ao rodar `adduser SEU_USUARIO`, o sistema faz uma série de perguntas. Nos exemplos abaixo
usamos "kelvin" como nome de exemplo — no seu caso vai aparecer o nome de usuário que você
escolheu. É assim que aparece:

```text
Adding user `kelvin' ...
Adding new group `kelvin' (1000) ...
Adding new user `kelvin' (1000) with group `kelvin' ...
Creating home directory `/home/kelvin' ...
Copying files from `/etc/skel' ...
New password:
Retype new password:
passwd: password updated successfully
Changing the user information for kelvin
Enter the new value, or press ENTER for the default
        Full Name []:
        Room Number []:
        Work Phone []:
        Home Phone []:
        Other []:
Is the information correct? [Y/n]
```

**O que preencher, passo a passo:**

1. **`New password:`** — crie uma senha forte **que você vai lembrar** (é a senha do seu
   usuário, usada no SSH e no `sudo`). Atenção: **nada aparece enquanto você digita** —
   nem `*`. É normal, a senha está sendo registrada. Digite e pressione Enter.
2. **`Retype new password:`** — repita a mesma senha.
3. **`Full Name`, `Room Number`, `Work Phone`, `Home Phone`, `Other`** — dados opcionais.
   Pode deixar tudo em branco: basta pressionar **Enter** em cada um.
4. **`Is the information correct? [Y/n]`** — digite `Y` (ou só Enter) para confirmar.

**Erros comuns:**

- **`Sorry, passwords do not match`** seguido de **`Try again? [y/N]`** — as duas senhas
  digitadas foram diferentes. Responda **`y`** para digitar de novo. Cuidado com o `N`
  maiúsculo: ele é o padrão, então **só pressionar Enter é o mesmo que responder `n`**.

  **E se eu já respondi `n`?** Aí o `adduser` desiste da senha mas **continua e cria o
  usuário** — você vai ver `passwd: password unchanged` e, no final, `Adding new user ...`.
  O usuário existe, mas **sem senha**, e não consegue entrar por SSH. Não é perda: defina a
  senha agora, sem recriar nada.

  ```bash
  passwd SEU_USUARIO
  ```

  Se preferir começar do zero, apague e rode o `adduser` de novo:

  ```bash
  deluser --remove-home SEU_USUARIO
  ```
- **Digitei `n` (ou qualquer coisa) em `Room Number` / `Work Phone`** — são campos puramente
  cosméticos, não afetam login nem permissão. Se quiser limpar: `chfn SEU_USUARIO` e pressione
  Enter em cada campo.
- **`BAD PASSWORD: ...`** — aviso de senha fraca. O sistema aceita, mas prefira uma senha
  longa (frase com palavras + números, ex.: `cavalo-bateria-42-janela`).
- **"Acho que digitei errado porque não vi nada"** — sem problemas: se errou, o `adduser`
  reclama (`Sorry, try again.`) e pede de novo.

</details>

**Confira que deu certo antes de seguir:**

```bash
id SEU_USUARIO
```

Tem que aparecer `sudo` na lista de grupos. Se não aparecer, o segundo comando não pegou.

> [!CAUTION]
> **Os dois comandos acima são um par — e o segundo é o mais fácil de perder.** Se você errar o
> nome, desistir no meio e criar o usuário de novo com **outro nome**, o `usermod` que você já
> rodou continua apontando para o usuário antigo. O novo nasce **sem permissão de administrador**,
> e o sintoma só aparece bem mais adiante, no Passo 5:
>
> ```text
> SEU_USUARIO is not in the sudoers file.
> ```
>
> Trocou o nome do usuário? **Rode os dois comandos de novo**, com o nome novo, e confirme com o
> `id` acima.

> [!IMPORTANT]
> **Por que antes de tudo?** Operar como root é um anti-padrão de segurança. Criando o usuário agora,
> o wizard só precisa **validar** que ele existe (Fase 01 de segurança) em vez de criá-lo — e o
> acesso root será travado no final do processo. **Anote o nome escolhido**: você vai digitá-lo de
> novo na etapa de Segurança do wizard.

**Agora encerre a sessão de root.** Não vamos reconectar ainda — o próximo passo acontece no
seu computador, e o `exit` já te deixa lá:

```bash
exit    # sai do root e fecha a conexão SSH
```

Você volta para o terminal do seu computador. É de lá que o Passo 4 continua.

<details>
<summary>🤔 <strong>E o <code>su - SEU_USUARIO</code>, não serve?</strong></summary>

Serve, e é mais rápido — mas tem um efeito colateral que vale conhecer.

Com `su - SEU_USUARIO` você continua **dentro da sessão do root** — apenas com outra identidade por
cima. Um `exit` te devolve ao root em vez de encerrar o acesso, e é fácil esquecer que aquele
terminal ainda tem uma sessão de root aberta embaixo.

Entrando por SSH direto como o seu usuário, a sessão é dele do começo ao fim: `exit` encerra de
verdade, e tudo que exigir privilégio vai passar por `sudo` — que pede senha e fica registrado
no log do sistema. É a diferença entre "estou de root com outro chapéu" e "estou como usuário
comum e peço permissão quando preciso".

Isso vale ainda mais se você vai deixar a sessão aberta por um tempo: melhor que ela seja a do
seu usuário, não a do root.

**E por que não usamos esse atalho aqui?** Além da sessão de root que fica aberta, ele te
mantém dentro da VPS — e o Passo 4 acontece no seu computador. Você teria que sair de qualquer
forma, então o `exit` resolve as duas coisas de uma vez.

</details>

> [!WARNING]
> **Essa senha não vai bastar para entrar na VPS.** Ela te leva até aqui e continua sendo a que o
> `sudo` pede dentro da máquina — mas a etapa de Segurança do wizard **desliga o login por senha
> no SSH**. A partir dali, quem entra é a sua chave.
>
> Por isso o **Passo 4, logo abaixo, não é opcional**: é onde você gera essa chave. Se pular, vai
> travar no meio do wizard, com um cronômetro de 5 minutos correndo, tendo que sair para outro
> terminal para resolver.

<details>
<summary>⏱️ <strong>Quer controlar quanto tempo a sua sessão SSH sobrevive parada?</strong> (opcional — leia se a conexão cai sozinha quando você para de digitar)</summary>

Se você já percebeu a sessão fechando depois de alguns minutos parado, o culpado quase sempre
é o **provedor da VPS**, não o servidor: firewalls de rede costumam descartar conexões que
ficam um tempo sem tráfego. O seu computador pode resolver isso mandando um sinal de vida a
cada minuto. Rode **no seu computador**, não na VPS:

```bash
# no SEU computador (Linux/macOS). No Windows com PuTTY, o campo equivalente é
# "Seconds between keepalives" em Connection.
printf 'Host *\n    ServerAliveInterval 60\n    ServerAliveCountMax 3\n' >> ~/.ssh/config
```

Depois disso, reconecte. **Isso não enfraquece a segurança** — a sessão continua sendo
encerrada se a rede realmente cair; o que muda é que ela para de *parecer* abandonada enquanto
você está trabalhando.

> [!IMPORTANT]
> **Mais adiante, no wizard, isso muda.** Quando você aplicar o passo de segurança do painel,
> ele passa a encerrar sessões ociosas por conta própria, em cerca de **10 minutos**. É
> proposital: protege você de deixar um terminal aberto e esquecido — num notebook, num café,
> numa máquina compartilhada. Com o keepalive acima configurado, você não sente isso enquanto
> está trabalhando, só quando realmente abandona a sessão.
>
> **Recomendamos deixar assim.** Mas se o seu caso exigir sessões ociosas mais longas (um build
> demorado que você acompanha de longe, por exemplo), crie um arquivo **seu** com o nome exato
> abaixo. Copie e cole as três linhas de uma vez — sem editor de texto, sem margem para erro de
> digitação:
>
> ```bash
> printf 'ClientAliveInterval 600\nClientAliveCountMax 6\n' | sudo tee /etc/ssh/sshd_config.d/10-local-override.conf
> sudo sshd -t && sudo systemctl restart ssh
> sudo sshd -T | grep -i clientalive
> ```
>
> O tempo até a desconexão é `ClientAliveInterval` **×** `ClientAliveCountMax` — acima, 600 × 6 =
> **1 hora**. Para nunca desconectar por ociosidade, use `0` nos dois valores (não recomendamos).
>
> **O nome do arquivo não é decoração.** O painel grava a configuração dele em
> `40-paas-hardening.conf`, e o SSH lê os arquivos dessa pasta em ordem alfabética valendo **o
> primeiro valor que encontrar**. Um arquivo começando por `10-` é lido antes e por isso vence; um
> `99-alguma-coisa` seria lido depois do painel e simplesmente não teria efeito nenhum. (É também
> por isso que o painel usa `40-`: muitas imagens de VPS trazem um `50-cloud-init.conf` que liga o
> login por senha, e ele precisa ser vencido.)
>
> As duas últimas linhas são a sua rede de proteção. O `sshd -t` confere o arquivo **antes** de
> reiniciar — sem ele, um erro de digitação pode impedir o SSH de subir e te deixar sem acesso à
> máquina. O `sshd -T` mostra o que o servidor de fato adotou, então você não fica no achismo:
> tem que aparecer `clientaliveinterval 600` e `clientalivecountmax 6`. Mantenha a janela atual
> aberta e teste a reconexão em **outra** antes de fechar a que funciona.
>
> **E quando terminar o que precisava**, apague o arquivo. O padrão do painel volta a valer
> sozinho, sem você precisar lembrar quais eram os valores originais:
>
> ```bash
> sudo rm /etc/ssh/sshd_config.d/10-local-override.conf
> sudo sshd -t && sudo systemctl restart ssh
> ```

</details>

<a id="passo-4"></a>

## Passo 4 — Gere sua chave SSH

Faça isso antes de ir para o wizard.

A etapa de Segurança do wizard vai desligar o login por senha no SSH (fase 02 do hardening). A
partir daí, a chave é a sua porta de entrada — e o wizard **pede a chave pública já na primeira
fase**, com um rollback automático de 5 minutos correndo. Gerando agora, com o terminal já
aberto, você não para no meio do processo para trocar de janela.

> [!TIP]
> **A senha que você acabou de criar no `adduser` não vai embora.** O que muda é só a porta de
> entrada remota (SSH). Dentro da máquina, essa senha continua sendo a que o `sudo` pede.

Você acabou de sair da VPS, então já está no lugar certo: os comandos abaixo rodam **no seu
computador**. É nele que a chave precisa existir para você se autenticar depois — se ela fosse
gerada na VPS, não serviria para entrar nela.

**Primeiro, veja se você já tem uma chave.** Se você já usa SSH para alguma coisa — GitHub,
outro servidor, o trabalho — ela provavelmente já existe, e **gerar outra por cima apaga a
antiga**. Rode:

```bash
ls -l ~/.ssh/*.pub
```

No **Windows (PowerShell)**:

```powershell
Get-ChildItem ~\.ssh\*.pub
```

Olhe **só o nome dos arquivos** que apareceram e siga a primeira linha da tabela que bate com
o que você viu:

| Se na lista aparece… | Use esta chave | O que fazer agora |
|---|---|---|
| `id_ed25519.pub` (mesmo que apareçam outros arquivos junto) | `id_ed25519` | **Não gere nada.** Vá direto para **[⬇️ Instale a chave na VPS](#instale-a-chave-na-vps)** (é um link — clique nele) |
| `id_rsa.pub`, mas **não** `id_ed25519.pub` | `id_rsa` | **Não gere nada.** Vá para **[⬇️ Instale a chave na VPS](#instale-a-chave-na-vps)** e, lá, use os comandos com `id_rsa` |
| Só arquivos com **outros nomes** (ex.: `github_deploy.pub`, `algum_servico_deploy.pub`) | nenhuma delas | **Gere uma chave nova** no próximo bloco |
| `No such file or directory` (ou nada) | — | **Gere uma chave nova** no próximo bloco |

Por que essa regra, e não "escolha a que achar melhor":

- **`id_ed25519` e `id_rsa` são nomes que o `ssh` experimenta sozinho** toda vez que você conecta.
  Usando uma delas, o login na VPS funciona sem nenhuma configuração extra no seu computador. A
  `id_rsa` é mais antiga, mas o servidor aceita do mesmo jeito.
- **Chaves com outros nomes foram criadas para um serviço específico** (um deploy, uma empresa,
  uma ferramenta). Não reaproveite: além de o `ssh` não tentá-las sozinho, misturar acessos
  significa que quem tem aquela chave passa a entrar também na sua VPS.
- **Gerar uma `id_ed25519` nova, nesses dois últimos casos, não apaga nada** — ela ainda não
  existe, então não há o que sobrescrever.

**Agora sim, gere o par de chaves** (só se a tabela acima mandou gerar). É o mesmo comando no
Linux, no macOS, no WSL e no PowerShell do Windows:

```bash
ssh-keygen -t ed25519
```

> [!WARNING]
> **Rode só essa linha e espere.** O `ssh-keygen` é interativo: ele para e faz perguntas. Se você
> colar mais de um comando de uma vez, o segundo vira **resposta** à primeira pergunta e a chave
> acaba salva num arquivo com nome errado.

Ele faz três perguntas, nesta ordem:

| O que aparece | O que fazer |
|---|---|
| `Enter file in which to save the key (...id_ed25519):` | Só **Enter** — aceita o local padrão |
| `Enter passphrase (empty for no passphrase):` | Digite uma senha. **Nada aparece na tela**, nem asterisco |
| `Enter same passphrase again:` | Repita a mesma |

> [!CAUTION]
> **Se aparecer `id_ed25519 already exists. Overwrite (y/n)?`, responda `n`.** Você já tinha uma
> chave e o comando está prestes a **apagá-la para sempre** — junto com o acesso a tudo que
> dependia dela. Respondendo `n` o comando cancela sem estragar nada; volte ao bloco anterior e
> siga pelo caminho "já tenho chave".

A passphrase é uma senha extra que protege a chave caso alguém tenha acesso ao seu computador.
Ela é recomendada, e para não digitá-la a cada conexão você pode guardá-la na sessão:

```bash
eval "$(ssh-agent -s)" && ssh-add ~/.ssh/id_ed25519
```

**Quando o comando terminar**, confira que a chave foi criada:

```bash
cat ~/.ssh/id_ed25519.pub
```

No **Windows (PowerShell)** o comando para exibir é outro:

```powershell
Get-Content ~\.ssh\id_ed25519.pub
```

Vai aparecer **uma única linha**, longa, mais ou menos assim:

```text
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIH8k2p... seu-usuario@seu-computador
```

Se a linha apareceu, a chave está criada.

<a id="instale-a-chave-na-vps"></a>

**Instale a chave na VPS** — agora, enquanto a senha ainda funciona. O comando sempre diz **qual
arquivo** instalar; use a linha da chave que a tabela escolheu:

```bash
ssh-copy-id -i ~/.ssh/id_ed25519.pub SEU_USUARIO@SEU_IP
```

Se a tabela mandou usar a `id_rsa`, a linha é esta (em vez da de cima):

```bash
ssh-copy-id -i ~/.ssh/id_rsa.pub SEU_USUARIO@SEU_IP
```

> [!WARNING]
> **Não rode o `ssh-copy-id` sem o `-i ~/.ssh/...pub`.** Sem ele, o comando decide sozinho o que
> enviar: se o seu computador tiver chaves carregadas na sessão, ele instala **todas** na VPS
> (inclusive chaves de outros serviços); se não tiver, pega o arquivo `id*.pub` alterado mais
> recentemente — que pode não ser o que você quer. Com o `-i`, vai exatamente a chave escolhida.

Ele pede a senha do `adduser` uma última vez e grava a sua chave pública no servidor. No
**Windows (PowerShell)**, onde o `ssh-copy-id` não existe, o equivalente é:

```powershell
Get-Content ~\.ssh\id_ed25519.pub | ssh SEU_USUARIO@SEU_IP "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
```

Com a `id_rsa`, troque `id_ed25519.pub` por `id_rsa.pub` nessa linha. Daqui em diante, sempre que
um comando citar `id_ed25519` (o `cat`, o `ssh-add`), quem usa `id_rsa` faz a mesma troca.

**Agora teste, e é o teste que importa:**

```bash
ssh SEU_USUARIO@SEU_IP
```

Se você entrar **sem que ele peça a senha da conta**, está funcionando. Ele pode pedir a
*passphrase da chave* — isso é outra coisa, é local, e não tem relação com o servidor.

> [!IMPORTANT]
> **Por que instalar e testar agora, e não deixar para o wizard.** A etapa de Segurança desliga o
> login por senha. Se a chave só for testada lá, o primeiro teste real acontece no pior momento
> possível: com o hardening já aplicado e um rollback de 5 minutos correndo.
>
> Fazendo aqui, você testa com calma e com a senha ainda ativa como rede de segurança. Se algo
> estiver errado, dá para corrigir sem pressão. Quando chegar no wizard, o acesso por chave já é
> um fato comprovado.

> [!NOTE]
> O wizard ainda vai **pedir a chave pública colada** na fase 01. Não é trabalho perdido: é ali
> que ele registra qual usuário e qual chave o painel deve considerar. Quando chegar lá, volte a
> este terminal, rode o `cat` de novo e cole a linha.

> [!IMPORTANT]
> O comando gera **dois arquivos**, e eles não são intercambiáveis:
>
> - **`id_ed25519.pub`** — a chave **pública**. É a que você cola no wizard. Pode ser mostrada a
>   qualquer um, sem risco.
> - **`id_ed25519`** (sem extensão) — a chave **privada**. **Nunca sai do seu computador**, nunca
>   é colada em lugar nenhum. Quem tiver esse arquivo tem acesso à VPS.
>
> A linha inteira que o `cat`/`Get-Content` mostrou — começando em `ssh-ed25519` — é o que vai no
> campo de chave pública da fase 01 do wizard.

<details>
<summary>🔑 <strong>E se eu perder, apagar ou corromper a chave privada?</strong></summary>

**Prevenção (faça isso antes de seguir em frente):**

- Guarde uma cópia da chave privada em lugar seguro, como um gerenciador de senhas. Quem tiver
  essa cópia acessa a VPS — trate-a como uma senha.
- Alternativa mais robusta: tenha uma **segunda chave**, gerada num outro dispositivo (outro
  computador, ou o seu celular). O campo do wizard aceita **uma chave por vez**, então instale a
  segunda depois de concluir o wizard, enquanto a primeira ainda funciona.

  Pegue a chave **pública** do outro dispositivo (o conteúdo do `.pub` dele), conecte na VPS pelo
  computador que já tem acesso e acrescente a linha:

  ```bash
  echo "COLE_AQUI_A_SEGUNDA_CHAVE_PUBLICA" >> ~/.ssh/authorized_keys
  ```

  Use `>>` e não `>` — um `>` sozinho **apaga** as chaves existentes e te tranca para fora na
  próxima conexão. Confira o resultado com `cat ~/.ssh/authorized_keys`: devem aparecer as duas
  linhas. Assim, perder um dispositivo não te deixa sem acesso.

**Se você já perdeu a chave** — ou a senha, ou o acesso ao painel — veja
[Perdi o acesso — e agora?](../guides/recover-access.md), que cobre cada caso e o caminho de volta.

</details>

O teste acima já te deixou conectado na VPS. A partir daqui, **todos os passos são feitos lá,
com esse usuário** — o que precisar de permissão de administrador vai pedir `sudo` e a sua senha.

<a id="passo-5"></a>

## Passo 5 — Instale o git

```bash
sudo apt update && sudo apt install -y git
```

<details>
<summary>📦 <strong>O <code>git</code> já estava instalado. Isso é normal?</strong></summary>

**É normal, sim.** "Ubuntu 24.04 LTS" no painel do seu provedor quase nunca é o sistema cru da
Canonical: é um *template* montado pelo provedor, e `git`, `curl`, `wget` e `vim` costumam vir
nesse pacote. Encontrar o `git` já pronto numa máquina recém-criada não indica que alguém entrou
nela.

O comando do Passo 5 continua valendo: se o pacote já estiver lá, o `apt` responde
`git is already the newest version` e não faz nada.

**Quer confirmar em vez de confiar?** São três verificações de leitura, nenhuma altera o sistema:

```bash
dpkg -V git             # silêncio = arquivos idênticos aos do pacote oficial
apt-cache policy git    # a origem deve ser archive.ubuntu.com ou security.ubuntu.com
last -a | head          # só os seus próprios logins devem aparecer
```

O `dpkg -V` compara cada arquivo instalado com a assinatura oficial do pacote — **nenhuma saída
é o resultado bom**. No `apt-cache policy`, o que importa é a origem: um repositório
desconhecido aí, sim, seria motivo para parar e investigar.

</details>

<details>
<summary>🔑 <strong>Primeiro <code>sudo</code>: o aviso gigante e a senha que não aparece</strong></summary>

Na **primeira vez** que você usa `sudo` com um usuário novo, aparece um aviso clássico:

```text
We trust you have received the usual lecture from the local System
Administrator. It usually boils down to these three things:

    #1) Respect the privacy of others.
    #2) Think before you type.
    #3) With great power comes great responsibility.

[sudo] password for kelvin:
```

**O que fazer:**

1. O aviso é só cerimônia de boas-vindas (uma tradição do Linux) — não exige resposta.
2. Em **`[sudo] password for kelvin:`** (no seu terminal vai aparecer o nome do usuário que
   você criou, não "kelvin"), digite **a senha do SEU usuário** (a que você criou no
   `adduser`), **não** a senha de root.
3. Lembre-se: **nada aparece na tela enquanto você digita** — nem `*`. Digite e Enter.

Esse aviso longo só aparece uma vez. Depois disso o `sudo` pede a senha direto — e, por
alguns minutos, nem isso (ele "lembra" que você se autenticou).

**Erros comuns:**

- **`Sorry, try again.`** — senha errada. Você tem 3 tentativas antes de o comando falhar.
- **`kelvin is not in the sudoers file`** — o usuário não tem permissão de administrador,
  porque o `usermod` do Passo 3 não chegou a rodar para **este** usuário. Como o próprio `sudo`
  está bloqueado, a correção tem que ser feita como root. **No seu computador**, abra a sessão de
  root, dê a permissão e confirme:

  ```bash
  ssh root@SEU_IP
  usermod -aG sudo SEU_USUARIO
  id SEU_USUARIO          # tem que listar "sudo"
  exit
  ```

  **E agora o detalhe que engana todo mundo:** volte ao terminal do seu usuário, feche a sessão
  com `exit` e **conecte de novo**. O Linux só lê os grupos de um usuário **no momento em que a
  sessão abre** — a sua foi aberta antes de o grupo existir, então ela continuaria recusando o
  comando mesmo com a correção já aplicada. Reconectado, teste com `sudo whoami`: deve responder
  `root`.

</details>

<a id="passo-6"></a>

## Passo 6 — Clone o repositório

Clone em `/opt` e dê a propriedade da pasta ao seu usuário:

```bash
sudo git clone https://github.com/kelvindk9w/tws-panel.git /opt/tws-panel
sudo chown -R $USER:$USER /opt/tws-panel
cd /opt/tws-panel && git checkout main
```

> [!TIP]
> O clone começa na branch `dev` (default do repositório, usada pelos contribuidores). Para
> **uso real**, sempre use a `main` — ela só recebe código validado e testado. Quer ajudar no
> desenvolvimento? Fique na `dev` (veja o [CONTRIBUTING.md](https://github.com/kelvindk9w/tws-panel/blob/main/docs/community/pt-BR/CONTRIBUTING.md)).

<a id="passo-7"></a>

## Passo 7 — Rode o instalador

O instalador instala o Docker se necessário, builda a imagem, sobe os containers
e termina mostrando o **endereço do seu painel**, já com HTTPS:
`https://SEU-IP-COM-HÍFENS.sslip.io` (ex.: `https://203-0-113-10.sslip.io`). Sem túnel e sem
escolher porta.

```bash
./scripts/install.sh
```

> [!NOTE]
> **De onde vem o endereço `https://…sslip.io`.** O [sslip.io](https://sslip.io) é um serviço de
> DNS público e gratuito: o nome `203-0-113-10.sslip.io` simplesmente aponta para o IP
> `203.0.113.10`. Ele **só traduz o nome** — o tráfego vai direto do seu navegador para a sua VPS,
> sem passar por ninguém no meio. Com esse nome, o proxy do painel (Caddy) consegue um
> **certificado HTTPS gratuito e válido** do [Let's Encrypt](https://letsencrypt.org), e o
> navegador abre o painel com o cadeado, sem aviso de "Não seguro". O painel em si escuta só
> dentro da VPS: de fora, quem atende é o proxy, nas portas 80 e 443.
>
> Para o certificado sair, as portas **80 e 443 precisam estar abertas** para a internet. Na
> Contabo (e na maioria das VPS) elas já vêm abertas. Se o seu provedor tiver um firewall no
> painel da hospedagem, libere as duas antes de instalar. O instalador espera o certificado
> ficar pronto (até 3 minutos) e, se ele não sair, diz o motivo mais provável e mostra o acesso
> por túnel como alternativa.
>
> Prefere que o painel fique **invisível na internet**, acessível só por túnel SSH? Veja
> [Acesso por túnel SSH](#acesso-por-tunel).

> [!TIP]
> **Ele pode parar logo no começo pedindo para reiniciar a VPS — é normal, ainda mais em VPS
> nova.** O provedor entrega o sistema com atualizações que só passam a valer depois de reiniciar
> (é o `*** System restart required ***` que aparece ao entrar). Nada foi instalado ainda: rode
> `sudo reboot`, espere cerca de um minuto, entre de novo com o mesmo `ssh` e repita os dois
> comandos, `cd /opt/tws-panel` e `./scripts/install.sh`.

> [!NOTE]
> O instalador precisa de privilégios de administrador (instalar Docker, criar volumes, abrir
> portas). Você **não precisa digitar `sudo`**: rodando como o seu usuário comum, ele detecta
> isso e se reexecuta via `sudo` sozinho, pedindo a sua senha. Se preferir ser explícito,
> `sudo ./scripts/install.sh` faz exatamente a mesma coisa — os dois caminhos são equivalentes.
>
> Depois da instalação, os comandos de Docker do dia a dia também levam `sudo` na frente
> (ex.: `sudo docker compose ps`) — o motivo está em
> [Por que o painel não te coloca no grupo docker](#grupo-docker).

> [!NOTE]
> **🩺 Pré-flight check:** antes de instalar qualquer coisa, o instalador faz verificações
> **somente-leitura** (SO, RAM/disco, Docker e containers em execução, as portas que o painel
> reserva para os seus projetos — 80/443 do proxy e 25/465/587/143/993/8080 do e-mail — e serviços
> como nginx, apache, caddy, postfix, mysql e postgres) e exibe um relatório. A porta do painel em
> si não entra nessa lista: ela é escolhida logo depois, numa pergunta que já confere se está
> livre. Se a VPS já
> estiver em uso, ele avisa que o painel foi feito para uma VPS limpa e pede confirmação explícita
> (digite `continuar`) — ou use `./scripts/install.sh --force` / `PAAS_FORCE=1` em automação. Ele
> **nunca remove nem para** nada que já exista na máquina.

<details>
<summary>🩺 <strong>Pré-flight: o que aparece na tela e o que fazer em cada cenário</strong></summary>

**Cenário 1 — VPS limpa (o esperado):** o relatório sai todo verde e a instalação segue
sozinha, sem pedir nada:

```text
[tws-panel] Pré-flight: inspecionando a máquina (nada será alterado nesta etapa)…
  ✓ SO: Ubuntu 24.04.2 LTS (suportado)
  ✓ RAM: 1984 MB
  ✓ Disco livre em /: 23 GB
  ✓ Docker: ausente (será instalado por este script)
  ✓ Nenhum container Docker em execução
  ✓ Portas do proxy e do e-mail (80/443/25/465/587/143/993/8080) livres
[tws-panel] Máquina limpa detectada ✓ — prosseguindo com a instalação.
```

Não precisa fazer nada — só aguardar o build (leva alguns minutos na primeira vez).

**Cenário 2 — VPS já em uso:** o relatório mostra itens com `⚠` e o instalador **para e
espera sua decisão**:

```text
  ⚠ Portas em uso: 80 443
  ⚠ Serviço ativo: nginx

================================================================================
  ⚠️  ATENÇÃO: esta VPS NÃO parece estar limpa (2 ponto(s) acima).

  O TWS Panel foi feito para uma VPS Ubuntu LIMPA. Continuar pode causar
  conflitos (portas, serviços, recursos) com o que já existe na máquina.
  Este instalador NUNCA remove ou para nada que já exista — mas os
  serviços do painel podem falhar ao subir se as portas estiverem ocupadas.

  Para prosseguir mesmo assim, digite "continuar" — ou rode com
  --force (PAAS_FORCE=1) em automações.
================================================================================

Digite "continuar" para prosseguir:
```

**O que fazer:**

- **Recomendado:** pressione **Ctrl+C** (ou simplesmente não digite nada e feche) para
  abortar — nada foi instalado nem alterado. Resolva os conflitos (ex.: desative o nginx se
  ele não é mais usado, ou contrate uma VPS limpa) e rode o instalador de novo.
- **Se você sabe o que está fazendo** (ex.: o serviço listado não usa as portas do painel):
  digite `continuar` e pressione Enter. Ao digitar, você confirma que **leu o relatório e
  aceita o risco** de conflitos.

**Erros comuns:**

- **Digitou errado (`continua`, `Continuar`)** — o instalador aborta com
  `Instalação abortada. Nada foi instalado ou alterado.` É só rodar de novo.
- **Não use `--force` no seu primeiro contato** — ele pula exatamente a reflexão que este
  aviso quer provocar. O `--force` existe para automação, não para pressa.

</details>

<a id="terminal-do-painel"></a>

**Logo depois do pré-flight, o instalador faz duas perguntas.** Elas decidem como o **terminal ao
vivo do painel** trabalha — é nele que a varredura de segurança e o hardening rodam:

1. **Com qual usuário o terminal abre.** Ele mostra os usuários da VPS que têm permissão de
   administrador, mas **quem digita o nome é você** — mesmo que só exista um. Digite o usuário
   que você criou no Passo 3. `root` também é aceito, mas não recomendamos: uma aba do navegador
   esquecida aberta daria acesso de root à VPS para quem sentasse na frente dela.
2. **Como rodar o que precisa de root.** Responda **`1` (senha)** — é o recomendado: quando algo
   precisar de administrador, o painel usa o `sudo` dentro do terminal e **você digita a sua
   senha ali**, como faria por SSH. A outra opção, `2` (segundo-plano), não pede senha: esses
   comandos rodam como root por trás, e você confere depois na tela de **Auditoria**.

Se o usuário não servir (não existe, está sem senha, não tem `sudo`…), o instalador explica o que
fazer e pergunta de novo. Nada é instalado antes de você responder. A porta do painel ele escolhe
sozinho: ela é só interna, você nunca vai digitá-la.


<details>
<summary>🔑 <strong>Senha ou segundo plano? O que acontece em cada um, sem letras miúdas</strong></summary>

**Modo `senha` (recomendado).** O terminal abre como o seu usuário. Quando uma varredura ou uma fase
do hardening precisa de root, o painel roda o comando com `sudo` no próprio terminal, e o `sudo`
pede a sua senha — a mesma do `adduser`. Nada roda como administrador sem você ver e autorizar.

- **O trade-off:** a senha sai do seu navegador, passa pelo painel e chega ao terminal da VPS. Ela
  não é gravada, registrada nem enviada a lugar nenhum — o projeto é open source e isso pode ser
  conferido no código. No caminho entre o seu navegador e a VPS ela vai **criptografada**: o
  painel é aberto por HTTPS (ou pelo túnel SSH, se você escolher esse acesso).
- **Exige** que o usuário tenha senha e esteja no grupo `sudo` — o que o Passo 3 já fez.

**Modo `segundo-plano`.** O terminal também abre como o seu usuário, mas os comandos que precisam de
root rodam **como root, por trás**, pela mesma ponte que o painel já usa para falar com a VPS. A
saída aparece no terminal só para você acompanhar.

- **O trade-off:** não pede senha, então você não autoriza comando a comando. A conferência é
  depois: tudo fica registrado na tela de **Auditoria** do painel.
- **Não exige `sudo`** — dá até para usar um usuário criado só para o painel. O instalador avisa se
  o usuário escolhido não tiver `sudo`, porque aí, entrando por SSH com ele, você não consegue fazer
  nada como administrador.

**Nos dois modos**, o monitoramento automático agendado — que roda sozinho, sem ninguém para digitar
senha — continua executando como root em segundo plano, e cada execução fica registrada na
Auditoria.

**Condição para os dois modos protegerem de verdade:** o usuário do terminal **não pode estar no
grupo `docker`**. Quem está nesse grupo vira root sem senha com um único comando, então passaria
por cima tanto do pedido de senha quanto da Auditoria. Se ele estiver, o instalador avisa e oferece
remover — veja [Por que o painel não te coloca no grupo docker](#grupo-docker).

**Instalando por automação** (sem ninguém para responder)? Passe as escolhas direto:

```bash
./scripts/install.sh --terminal-user=SEU_USUARIO --root-mode=senha
```

Sem essas opções, com `--force` ou sem terminal interativo, o instalador **não adivinha**: mantém o
comportamento antigo (terminal como root) e avisa. Numa reinstalação, o que você escolheu da
primeira vez é mantido sem perguntar de novo — para trocar, veja
[Trocar o usuário do terminal do painel](../guides/operations.md#trocar-terminal).

</details>

<a id="grupo-docker"></a>

> [!IMPORTANT]
> **Por que o painel não te coloca no grupo docker.** Estar no grupo `docker` é o mesmo que ter
> root na VPS **sem digitar senha**: qualquer membro consegue, com um comando, abrir um container
> com o disco inteiro da máquina. Se o usuário do terminal estivesse nesse grupo, uma aba do painel
> esquecida aberta voltaria a dar root à VPS, e os modos `senha` e `segundo-plano` não protegeriam
> nada. Por isso os comandos de Docker levam `sudo` na frente (`sudo docker compose ps`).
>
> **Já está no grupo** (uma versão antiga do instalador colocava você lá, e desinstalar o painel
> não desfaz)? Ao rodar o instalador, ele pergunta se remove — responda `s`. Para fazer à mão:
>
> ```bash
> sudo gpasswd -d SEU_USUARIO docker
> ```
>
> Depois saia da VPS (`exit`) e entre de novo por SSH: como no grupo `sudo`, a mudança só vale em
> sessões novas. Confira com `groups` — `docker` não deve aparecer na lista. Em instalação sem
> ninguém para responder, o instalador não mexe em grupos: só avisa em destaque no final.

<a id="acesso-por-tunel"></a>

<details>
<summary>🔐 <strong>Opcional — acesso só por túnel SSH (o painel fica invisível na internet)</strong></summary>

Por padrão o painel abre em `https://SEU-IP-COM-HÍFENS.sslip.io`. Se você preferir que ele **não
tenha endereço nenhum na internet** — só quem tem SSH na VPS chega nele —, instale com:

```bash
./scripts/install.sh --acesso=tunel
```

Nesse modo o instalador pergunta em qual porta da VPS o painel fica e termina mostrando o comando
do túnel SSH e o endereço `http://localhost:PORTA/?token=…`. O navegador vai mostrar "Não seguro"
por ser `http://localhost` — e aqui não tem problema: o tráfego viaja criptografado dentro do túnel
SSH. Para trocar de modo depois, rode o instalador de novo com `--acesso=https` ou `--acesso=tunel`.
Com o painel em HTTPS, a Fase 02 fecha também o túnel SSH (não é usado); ao trocar para
`--acesso=tunel`, o instalador libera o túnel de novo sozinho.

<a id="porta-livre-no-seu-computador"></a>

> [!TIP]
> **Antes de instalar: confira, no SEU computador, um número de porta livre.** Daqui a pouco o
> instalador vai perguntar em qual porta o painel fica na VPS — e o comando de acesso que ele
> imprime no final abre o túnel SSH usando **o mesmo número dos dois lados**
> (`ssh -L 9000:localhost:9000`). Ou seja: **o número que você escolher aqui é o que vai ser
> informado ao instalador**, e ele precisa estar livre nos dois lugares. Na VPS, o próprio
> instalador confere e avisa; **no seu computador ele não tem como enxergar**, porque roda na VPS.
> Por isso esta conferência é aqui, na sua máquina, antes de começar.
>
> Comece testando a **9000** (o padrão). Se estiver ocupada, teste **9100**, depois **9200**, e
> assim por diante — qualquer número alto e livre serve. Troque o `9000` do comando pelo número
> que estiver testando.
>
> **Linux e WSL:**
>
> ```bash
> ss -ltnH 'sport = :9000'
> ```
>
> **macOS:**
>
> ```bash
> lsof -nP -iTCP:9000 -sTCP:LISTEN
> ```
>
> **Windows (PowerShell):**
>
> ```powershell
> Get-NetTCPConnection -State Listen -LocalPort 9000 -ErrorAction SilentlyContinue
> ```
>
> **Como ler o resultado — vale para os três:**
>
> - **Não apareceu nada** (o terminal só volta a mostrar o prompt, sem nenhuma linha): a porta
>   está **livre**. É esse número que você informa ao instalador no próximo passo.
> - **Apareceu alguma linha**: já existe um programa ouvindo nessa porta no seu computador. Ela
>   está **ocupada** — escolha outro número e rode o comando de novo.
>
> **Quer saber qual programa está ocupando?** No Linux e no WSL, acrescente `-p`
> (`ss -ltnpH 'sport = :9000'`): sem administrador ele mostra só os seus próprios programas, então
> use `sudo ss -ltnpH 'sport = :9000'` para ver todos. No macOS vale o mesmo: o `lsof` sem `sudo`
> enxerga apenas os seus programas — se a porta parecer livre e mesmo assim o túnel reclamar,
> repita com `sudo` na frente. No Windows, a coluna `OwningProcess` é o número do processo;
> `Get-Process -Id <número>` diz o nome dele (abra o PowerShell como administrador se ele se
> recusar a informar).
>
> Não precisa fechar nada nem liberar a 9000: escolher outro número é mais simples e não quebra o
> programa que já estava lá. Entenda as [duas portas do túnel](#duas-portas).

<a id="duas-portas"></a>

> [!TIP]
> **O túnel tem duas pontas, e elas são portas diferentes.** No comando
> `ssh -L 9000:localhost:9000 ...`, os dois números parecem iguais, mas não são a mesma coisa:
>
> ```text
> ssh -L 9000 : localhost : 9000  SEU_USUARIO@SEU_IP
>      ─┬──              ─┬──
>       │                 └── porta DA VPS: onde o painel atende. É a que você escolheu
>       │                     na instalação (padrão 9000), gravada no .env.
>       └── porta DO SEU COMPUTADOR: a "boca" do túnel na sua máquina. É essa que
>           você digita no navegador, depois de localhost:.
> ```
>
> Elas **não precisam ser iguais**. Usar o mesmo número dos dois lados é só um costume que deixa
> o comando fácil de ler. Se a porta do seu computador já estiver ocupada por outro programa (é
> comum: `9000` é usada por vários ambientes de desenvolvimento), **troque só o número da
> esquerda** e abra o navegador nele:
>
> ```bash
> ssh -L 9100:localhost:9000 SEU_USUARIO@SEU_IP
> # e no navegador: http://localhost:9100/?token=SEU_TOKEN
> ```
>
> O instalador não tem como adivinhar o que está ocupado no seu computador — ele roda na VPS e
> só enxerga a VPS. Por isso a porta da esquerda é sempre escolha sua, na hora de abrir o túnel.
>
> Para não descobrir isso só na hora do erro, dá para
> [conferir antes, no seu computador, qual porta está livre](#porta-livre-no-seu-computador) — e
> informar esse mesmo número ao instalador, para que os dois lados batam.

**Erros comuns ao abrir o túnel:**

- **`bind [127.0.0.1]:9000: Address already in use`** (ao abrir o túnel) — a porta ocupada é a
  **do seu computador**, não a da VPS: o número da **esquerda** no `ssh -L`. Algum programa seu já
  está usando a 9000 (é comum em quem programa). Troque só esse número e abra o navegador nele:
  `ssh -L 9100:localhost:9000 SEU_USUARIO@SEU_IP`, depois `http://localhost:9100/?token=...`.
  Qualquer número alto e livre serve — 9100, 9300, 12345. Entenda as
  [duas portas do túnel](#duas-portas). Na próxima instalação, esse erro nem aparece se você
  [conferir antes qual porta está livre no seu computador](#porta-livre-no-seu-computador) e
  informar esse número ao instalador.
- **"Não é possível acessar esse site"** no navegador, com o túnel aberto — o endereço está com o
  número **errado**. O que vai no navegador é sempre o número da **esquerda** do seu `ssh -L`, que é
  a porta do seu computador. Se o seu túnel é `ssh -L 9100:localhost:9001`, o endereço é
  `http://localhost:9100/?token=...` — a `9001` é a porta da VPS e nunca aparece no navegador.
  Confira qual número o seu túnel está escutando com `ss -ltnH 'sport = :9100'` (Linux/WSL).
- **`channel 2: open failed: connect failed: Connection refused`** (o túnel abre, mas o navegador
  diz que não conseguiu conectar) — aí é o outro lado: o número da **direita** não bate com a porta
  em que o painel está na VPS. Confira com `sudo ./scripts/show-token.sh`, que imprime o comando
  já com a porta certa.

</details>

<a id="passo-8"></a>

## Passo 8 — Abra o painel

Abra o painel no endereço `https://…sslip.io` que o instalador mostrou no final (ele já
leva o **setup token** no link; se precisar, o token também aparece em destaque no terminal) e siga
o wizard:

```
┌─────────────────────────────────────────────────────────────┐
│  Assistente — https://SEU-IP.sslip.io/?token=…              │
├─────────────────────────────────────────────────────────────┤
│  1. Boas-vindas      → valida o setup token e libera o      │
│                        terminal ao vivo do servidor         │
│  2. Saúde da máquina → CPU, RAM, disco, rede — os checks    │
│                        rodam AO VIVO no terminal embutido   │
│  3. Segurança        → scan Lynis → plano → hardening       │
│                        (com rollback automático em 5 min)   │
│  4. Conta admin      → usuário + senha forte do painel      │
└─────────────────────────────────────────────────────────────┘
```

A etapa **Segurança** é a que exige mais atenção: ela mexe em como você entra na VPS. Antes de
aplicar as fases, leia o [Wizard de segurança](security-wizard.md).

O instalador é **idempotente**: pode ser executado de novo sem quebrar nada (rebuild + restart).
O painel roda 100% em Docker (`docker compose up -d`), com o estado persistido no volume
`paas_data` e acesso ao socket do Docker para gerenciar Caddy, Stalwart e seus projetos.

> [!TIP]
> **Perdeu o setup token?** Recupere a qualquer momento com `sudo ./scripts/show-token.sh` ou
> `sudo docker exec tws-panel cat /data/setup-token`.

<details>
<summary>🎫 <strong>Banner final do instalador — e como recuperar o token depois</strong></summary>

Quando a instalação termina, o terminal toca um "bip" e mostra um banner assim:

```text
██████████████████████████████████████████████████████████████████████████████
██                                                                          ██
██               ✅  TWS PANEL INSTALADO E RODANDO COM SUCESSO!               ██
██                                                                          ██
██████████████████████████████████████████████████████████████████████████████

👉  PRÓXIMO PASSO: abra o painel no navegador

  Abra no navegador (de qualquer computador — não precisa de túnel nem de porta):

      https://203-0-113-10.sslip.io/?token=<seu-token-de-48-caracteres>

  A conexão é criptografada (HTTPS, certificado Let's Encrypt): a senha de
  administrador que você vai criar e a senha do sudo, se o terminal pedir,
  trafegam protegidas. O sslip.io só traduz o nome para o IP desta VPS — o
  tráfego vai direto do seu navegador para cá.

┌──────────────────────────────────────────────────────────────────────────┐
│                            ⚑  SETUP TOKEN  ⚑                              │
│                                                                          │
│   <seu-token-de-48-caracteres>                                            │
│                                                                          │
│   ⚠  Ele aparece SÓ AGORA em destaque. Guarde-o até concluir o wizard.   │
│   ⚠  Após criar a conta admin no fim do wizard, ele é invalidado.        │
└──────────────────────────────────────────────────────────────────────────┘
```

**O que fazer:** copie o **link completo** (`https://…sslip.io/?token=...`) e cole no navegador.
Ele já leva o token embutido — não precisa digitar nada. Instalou com `--acesso=tunel`? O banner
mostra, no lugar dele, o comando do túnel e o endereço `http://localhost:…` (veja
[Acesso por túnel SSH](#acesso-por-tunel)).

**Fechou o terminal e perdeu o banner?** Sem pânico. Na VPS, rode qualquer um dos dois:

```bash
sudo ./scripts/show-token.sh                       # reexibe o link completo + token
sudo docker exec tws-panel cat /data/setup-token   # mostra só o token
```

**Erros comuns:**

- **O instalador disse que o endereço `https://…sslip.io` não respondeu em 3 minutos** — o
  certificado não saiu. A causa mais comum são as portas **80 e 443 bloqueadas** num firewall do
  provedor (no painel da hospedagem): libere as duas e reinicie o painel com
  `sudo docker compose restart`. Para ver o que o proxy diz: `sudo docker logs paas-caddy --tail 50`.
  Enquanto isso, o acesso por túnel funciona (o banner mostra o comando).
- **Erros ao abrir o túnel** (só no acesso por túnel) — estão explicados em
  [Acesso por túnel SSH](#acesso-por-tunel).
- **`permission denied while trying to connect to the Docker daemon socket`** — faltou o `sudo`
  na frente do comando. É de propósito: o painel não coloca ninguém no grupo docker (veja
  [o porquê](#grupo-docker)).
- **`setup token não encontrado...`** — ou o `show-token.sh` foi rodado numa máquina sem o painel
  (rode-o na VPS certa, de dentro de `/opt/tws-panel`), ou o assistente já foi concluído e o token foi
  apagado de propósito: para reabri-lo com um token novo, `sudo ./scripts/reset-setup.sh`.
- **O token não funciona mais no navegador** — depois que você cria a conta admin (última
  etapa do wizard), o token é **invalidado para sempre**. A partir daí o acesso é pela tela de
  login, com seu usuário e senha do painel.

</details>

## Depois do wizard

No primeiro acesso, o Dashboard mostra o roteiro **Deixe o painel pronto**, com o que ainda falta
configurar (proteções, verificação em duas etapas, domínio do painel, e-mail, notificações e
backups). Os passos estão no [README](https://github.com/kelvindk9w/tws-panel/blob/main/README.pt-BR.md#depois-de-instalar).

Para publicar um projeto: cadastre o projeto, aponte o DNS, e o painel cuida do build, do proxy e
do SSL. Guia de produção em [production.md](../guides/production.md). Comandos do dia a dia, pasta dos
projetos e troca de porta ou de usuário do terminal estão em [Operação](../guides/operations.md).
