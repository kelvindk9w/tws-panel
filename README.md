# TWS Panel

> **Transforme qualquer VPS Ubuntu em sua própria plataforma de hospedagem — segura, com e-mail profissional e zero mensalidade de painel.**

[![Licença: MIT](https://img.shields.io/badge/licen%C3%A7a-MIT-green.svg)](LICENSE)
[![Node.js 22](https://img.shields.io/badge/node-%E2%89%A522-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Docker](https://img.shields.io/badge/docker-compose-2496ED?logo=docker&logoColor=white)](https://docs.docker.com/compose/)
[![pnpm](https://img.shields.io/badge/pnpm-monorepo-F69220?logo=pnpm&logoColor=white)](https://pnpm.io)
[![Status: beta](https://img.shields.io/badge/status-beta-yellow)](#roadmap)

---

## Por que este projeto existe?

A TWS mantinha um plano de hospedagem mensal usado basicamente para ter e-mails profissionais.
Quando surgiu a chance de testar um serviço alternativo, mais simples e nacional, topamos —
por uma escolha deliberada de apoiar outros empreendedores brasileiros.
No começo funcionou bem: migramos projetos reais, principalmente sites institucionais de
clientes.

Até que um dia precisamos fazer algo trivial — atualizar o número de WhatsApp de um cliente no
site — e não conseguimos. Abrimos um chamado pelo canal oficial de suporte do serviço e
ficamos dias sem resposta, sem qualquer posicionamento. Com o projeto do cliente parado e
nenhuma previsão de solução, a sensação foi a de um serviço abandonado.

Essa experiência deixou claro que o problema não era só nosso: é o medo que trava qualquer
pessoa na hora de colocar um projeto real na infraestrutura de outra empresa — não o medo do
serviço cair, mas o de ficar sem resposta, sem aviso e sem saída. Em vez de sair atrás de outro
fornecedor, decidimos resolver a parte que nos deixava dependentes: a configuração.

O TWS Panel não é uma hospedagem, e não quer ser a próxima empresa de quem você depende. É o
painel que prepara a VPS para você — o hardening, o deploy, o domínio com SSL, o e-mail
profissional — em qualquer provedor que você escolher. Se um dia quiser trocar de provedor,
troca: o painel vai junto, e a infraestrutura continua sendo sua.

## O que é

O TWS Panel transforma uma VPS Ubuntu 22.04/24.04 crua em uma plataforma de hospedagem própria.
Um único comando abre um assistente web que conduz o processo do início ao fim: protege a
máquina, instala e configura o painel, e deixa tudo pronto para publicar projetos com Docker,
domínios com SSL automático e e-mail profissional com DKIM/SPF/DMARC.

**Princípios**

- **Não-invasivo** — usa o Docker que já está na máquina; não mexe nas stacks que já funcionam.
- **Segurança primeiro** — nada entra no ar antes do hardening da VPS; depois, baseline registrado e monitoramento contínuo.
- **Minimalista** — instala o mínimo de pacotes na VPS; o próprio painel é leve (Fastify + arquivos JSON em disco, sem banco de dados).
- **Open source** — licença MIT, aberto a contribuições desde o primeiro commit.

## Funcionalidades

| Módulo | O que faz |
|---|---|
| **🖥️ Terminal web embutido** | Nos 4 passos do wizard, a tela mostra **visão dupla**: em cima a UI formatada em cards e fases, embaixo um **terminal real ao vivo** do servidor (xterm.js + WebSocket + PTY), numa janela contida estilo IDE — **bloqueado até o setup token ser validado** e recolhido por padrão. As varreduras e as fases de hardening rodam DENTRO dele: você vê os comandos de verdade (`cat /etc/os-release`, checks do Lynis, scripts de fase), como faria por SSH. Prompts de senha e confirmação são digitados direto no terminal — o backend faz **relay puro** do PTY e **nunca lê, loga ou armazena** o que você digita, só audita conexão e desconexão. |
| **🛡️ Wizard de segurança** | Um scan com **Lynis** e checks próprios dá o score antes e depois. O hardening roda em fases idempotentes — SSH, UFW, fail2ban, unattended-upgrades, auditd/AIDE e outras — com backup de cada arquivo alterado. Um **rollback automático** fica agendado e só é cancelado depois que você confirma que ainda tem acesso. Disponível também **depois da instalação**, em `/security/hardening`, para revisar ou reaplicar quando quiser. |
| **🚀 Deploy** | **3 modos de ingestão**: git com branch configurável, upload de diretório, ou adoção de um compose existente sem reescrevê-lo. O tipo de pipeline é **detectado automaticamente** (estático, Node, Dockerfile, compose). Um **Caddy central** cuida do SSL automático e do reload sem downtime, com suporte a WebSocket e conexões longas, e os logs de deploy aparecem em tempo real. Nome, repositório, branch e domínio são **editáveis depois de criado**, e a tela mostra qual branch está de fato no ar quando a configuração diverge do último deploy. |
| **🌿 Múltiplos ambientes** | O mesmo repositório pode rodar mais de uma vez, em branches e domínios diferentes — produção em `main`, sandbox em outra branch, lado a lado na mesma VPS. Cada instância tem clone, imagem, containers e rede próprios; só o domínio precisa ser único. |
| **📧 E-mail** | Um único container **Stalwart** cobre SMTP, IMAP e DKIM. Cada domínio ganha seu par de chaves **DKIM RSA 2048**, e um **checklist de DNS verificável** (A/AAAA/MX/SPF/DKIM/DMARC/PTR) traz os valores prontos para colar no provedor — inclusive um texto pronto para abrir chamado de PTR. Criar uma caixa gera **credenciais prontas para Outlook, Gmail ou Thunderbird**, e as variáveis SMTP são injetadas automaticamente nos seus projetos. |
| **🚧 Guardrails** | **6 regras** de segurança de deploy, em 3 níveis (`block`, `warn`, `info`): porta de banco exposta no host, credenciais fracas, container privilegiado, serviço de dev em produção, secret comitado no código, tag `:latest`. Um bloqueio (`block`) só passa com **override explícito e auditado**, com evidência do problema e sugestão de correção. |
| **📊 Monitoramento** | Depois do hardening, um **baseline** registra pacotes, portas e hashes de arquivos críticos. Scans recorrentes comparam o estado atual com esse baseline, e qualquer mudança vira alerta (**diff**). Também verifica se o domínio caiu em **blacklist de e-mail** (Spamhaus ZEN, SpamCop, Barracuda, Spamhaus DBL), e mantém uma central de alertas e um **log de auditoria** de todas as ações sensíveis. |

## Instalação — VPS limpa do zero

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
lista exatamente o que encontrou. Depois, entre em outra pasta (`cd ~`) e **recomece pelo Passo 6**
(clonar o repositório) — o git do Passo 5 continua instalado. Quer manter a pasta do repositório?
Use `--keep-repo` e vá direto ao Passo 7.

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

**1. Contrate uma VPS** com Ubuntu 24.04 LTS (mínimo recomendado: 1 vCPU / 2 GB RAM / 25 GB de disco).

> [!NOTE]
> **Nunca contratou uma VPS antes?** Este guia começa no momento em que você já tem **um IP e uma
> senha de root** em mãos. Como contratar, pagar e escolher a região muda de provedor para
> provedor, quem documenta essa parte melhor é o próprio provedor — procure por "primeiros passos"
> ou "getting started" na central de ajuda dele, e escolha **Ubuntu 24.04 LTS** na criação.
>
> Travou aí, antes de ter o IP? [Fale com a TWS](https://tws.tec.br/) — a gente ajuda e, se o seu
> caso for comum, ele entra nesta documentação.

**2. Acesse como root via SSH** e confirme a versão do SO:

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

**3. Crie o seu usuário não-root** — é ele quem vai operar a VPS daqui em diante:

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
> `99-paas-hardening.conf`, e o SSH lê os arquivos dessa pasta em ordem alfabética valendo **o
> primeiro valor que encontrar**. Um arquivo começando por `10-` é lido antes e por isso vence; um
> `99-alguma-coisa` seria lido depois do painel e simplesmente não teria efeito nenhum.
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

**4. Gere sua chave SSH** — antes de ir para o wizard:

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
[Perdi o acesso — e agora?](#perdi-o-acesso--e-agora), que cobre cada caso e o caminho de volta.

</details>

O teste acima já te deixou conectado na VPS. A partir daqui, **todos os passos são feitos lá,
com esse usuário** — o que precisar de permissão de administrador vai pedir `sudo` e a sua senha.

**5. Instale o git:**

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

**6. Clone o repositório em `/opt` e dê a propriedade da pasta ao seu usuário:**

```bash
sudo git clone https://github.com/kelvindk9w/tws-panel.git /opt/tws-panel
sudo chown -R $USER:$USER /opt/tws-panel
cd /opt/tws-panel && git checkout main
```

> [!TIP]
> O clone começa na branch `dev` (default do repositório, usada pelos contribuidores). Para
> **uso real**, sempre use a `main` — ela só recebe código validado e testado. Quer ajudar no
> desenvolvimento? Fique na `dev` (veja o [CONTRIBUTING.md](CONTRIBUTING.md)).

> [!IMPORTANT]
> **Confira que a `main` está em dia antes de instalar.** Já aconteceu de a `main` ficar 96
> commits atrás enquanto este README mandava instalar a partir dela. Rode:
>
> ```bash
> git fetch origin && git diff --stat origin/main origin/dev
> ```
>
> Contar commits de diferença não funciona aqui: cada versão liberada para a `main` entra como
> um único commit (squash), então a contagem sempre mostra dezenas de commits mesmo quando o
> conteúdo das duas branches é idêntico. O que importa é o conteúdo — por isso comparamos os
> arquivos, não o histórico. Interprete o resultado assim:
>
> - **Nenhuma saída** — as branches têm o mesmo conteúdo. Pode instalar.
> - **Poucos arquivos, e nenhum deles código do painel** — documentação (`README.md`, `docs/`,
>   `comoFuncionaSistema/`) ou testes (`*.test.ts`). É trabalho em andamento que não muda nada do
>   que roda na sua máquina. Pode instalar.
> - **Arquivos dentro de `apps/` ou `packages/`** — há código de produção na `dev` que ainda não
>   foi promovido para a `main`. Aí sim, [abra uma issue](https://github.com/kelvindk9w/tws-panel/issues)
>   avisando, porque pode ser uma correção de segurança não publicada, e aguarde a promoção — a
>   `dev` é a branch de desenvolvimento e não passa pelo mesmo processo de validação da `main`.

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

**7. Rode o instalador** — ele instala o Docker se necessário, builda a imagem e sobe os containers.
Tenha em mãos o número de porta que você [conferiu no seu computador](#porta-livre-no-seu-computador):
é ele que você vai informar quando o instalador perguntar.

```bash
./scripts/install.sh
```

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

**Logo depois do pré-flight, o instalador faz quatro perguntas.** As duas primeiras decidem como o
**terminal ao vivo do painel** trabalha — é nele que a varredura de segurança e o hardening rodam:

1. **Com qual usuário o terminal abre.** Ele mostra os usuários da VPS que têm permissão de
   administrador, mas **quem digita o nome é você** — mesmo que só exista um. Digite o usuário
   que você criou no Passo 3. `root` também é aceito, mas não recomendamos: uma aba do navegador
   esquecida aberta daria acesso de root à VPS para quem sentasse na frente dela.
2. **Como rodar o que precisa de root.** Responda **`1` (senha)** — é o recomendado: quando algo
   precisar de administrador, o painel usa o `sudo` dentro do terminal e **você digita a sua
   senha ali**, como faria por SSH. A outra opção, `2` (segundo-plano), não pede senha: esses
   comandos rodam como root por trás, e você confere depois na tela de **Auditoria**.
3. **Em qual porta da VPS o painel fica.** O padrão é **9000** e serve para quase todo mundo — é só
   apertar Enter. O instalador **confere antes se essa porta está livre nesta VPS**: se já houver
   algo nela, ele diz qual programa (ou qual container) está usando, oferece uma porta livre como
   sugestão e pergunta de novo — mas quem escolhe é você, ele nunca troca sozinho. Algumas portas
   são recusadas porque quebrariam o próprio produto: **22** (é por onde o SSH entra), **80** e
   **443** (o proxy que publica os seus sites com SSL) e **25, 465, 587, 143, 993 e 8080** (o
   servidor de e-mail). Essa é a porta **da VPS** — a porta do túnel no seu computador é outra
   coisa, explicada [logo abaixo](#duas-portas). Informe aqui o número que você
   [conferiu no seu computador](#porta-livre-no-seu-computador): assim o comando do túnel impresso
   no final, que usa o mesmo número dos dois lados, funciona de primeira.
4. **Qual chave SSH você usa** (opcional). Usou `id_ed25519` ou `id_rsa` no Passo 4? Só aperte
   Enter. É só para o comando de acesso impresso no final já sair pronto para copiar.

Se o usuário não servir (não existe, está sem senha, não tem `sudo`…), ou se a porta estiver
ocupada, o instalador explica o que fazer e pergunta de novo. Nada é instalado antes de você
responder.

<details>
<summary>🔌 <strong>Quero instalar sem responder nada (automação) — como escolho a porta?</strong></summary>

Passe direto na linha de comando:

```bash
./scripts/install.sh --port=9500 --terminal-user=SEU_USUARIO --root-mode=senha
```

Vale também a variável de ambiente `PAAS_PORT=9500`. A ordem de prioridade é: `--port=` primeiro,
depois `PAAS_PORT`, depois o valor já gravado no `.env` por uma instalação anterior, e só então a
pergunta (padrão 9000).

Sem terminal para responder (ou com `--force`), o instalador **não escolhe outra porta sozinho**:
fica na 9000 e, se ela estiver ocupada, avisa em destaque que o painel provavelmente vai falhar ao
subir — para você rodar de novo com `--port=`. Numa reinstalação, a porta que você escolheu da
primeira vez é mantida sem perguntar de novo.

</details>

<details>
<summary>🔑 <strong>Senha ou segundo plano? O que acontece em cada um, sem letras miúdas</strong></summary>

**Modo `senha` (recomendado).** O terminal abre como o seu usuário. Quando uma varredura ou uma fase
do hardening precisa de root, o painel roda o comando com `sudo` no próprio terminal, e o `sudo`
pede a sua senha — a mesma do `adduser`. Nada roda como administrador sem você ver e autorizar.

- **O trade-off:** a senha sai do seu navegador, passa pelo painel e chega ao terminal da VPS. Ela
  não é gravada, registrada nem enviada a lugar nenhum — o projeto é open source e isso pode ser
  conferido no código. Mas, justamente porque ela passa por ali, **abra o painel sempre pelo túnel
  SSH** (explicado logo abaixo). Pelo link do IP direto, ela viajaria pela internet sem
  criptografia.
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
[Trocar o usuário do terminal do painel](#trocar-terminal).

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

> [!IMPORTANT]
> **Antes de abrir o painel: o link que o instalador imprime é HTTP puro, sem criptografia.**
> O instalador termina mostrando algo como `http://SEU_IP:9000/?token=...`, e o navegador vai
> marcar esse endereço como **"Não seguro"**. Não é alarme falso: é uma VPS com IP público, sem
> TLS. Tudo que passa por ali — o setup token e, principalmente, a **senha da conta de
> administrador** que você cria na última etapa do wizard — viajaria legível pela internet. Ao
> contrário do token, essa senha não expira: é a credencial permanente de um painel com acesso
> ao socket do Docker (equivalente a root na máquina).
>
> **Recomendado — abra por túnel SSH.** Você já tem uma sessão SSH nesta VPS, então isso não
> exige nada novo. No **seu computador** (não na VPS), abra uma **segunda janela** de terminal —
> deixe a primeira aberta — e rode:
>
> ```bash
> ssh -L 9000:localhost:9000 SEU_USUARIO@SEU_IP
> ```
>
> Com essa janela aberta, acesse `http://localhost:9000/?token=SEU_TOKEN` no navegador. Ele
> ainda vai mostrar **"Não seguro"** — é `http://localhost`, e dessa vez não tem problema: o
> tráfego viaja criptografado dentro do túnel SSH e nada sai da sua máquina em texto claro.
>
> No Windows 10/11, o PowerShell já vem com `ssh` nativo — o mesmo comando acima funciona sem
> instalar nada. No PuTTY, o equivalente fica em Connection → SSH → Tunnels (Source port `9000`,
> Destination `localhost:9000`, Local).
>
> **Acesso direto pelo link do IP** só é tolerável em ambiente de teste descartável, cuja senha
> de admin você não vai reaproveitar em lugar nenhum.

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

**8. Abra o painel** — pelo túnel SSH acima (recomendado) ou, se aceitar o risco descrito acima, direto em `http://SEU_IP:9000` (troque `9000` pela porta que você escolheu na instalação) — cole o **setup token** exibido no terminal e siga o wizard:

```
┌─────────────────────────────────────────────────────────────┐
│  Assistente de configuração — http://SEU-IP:9000/?token=…   │
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

### Como conduzir a etapa **Segurança** do wizard

A etapa **Segurança** aplica o hardening em **sete fases**, uma de cada vez: aplique, confirme, só então
avance para a próxima. Nunca dispare uma fase nova com a anterior ainda pendente de confirmação.

| Fase | O que faz | Pede confirmação? |
|---|---|---|
| 00 · Atualizações | `apt full-upgrade` + atualizações automáticas (**menos o Docker**) | Não |
| 01 · Usuário não-root | Instala sua chave SSH e trava a senha do root | **Sim** |
| 02 · SSH | Desliga login por senha e acesso root via SSH | **Sim** |
| 03 · Firewall | Ativa o UFW (nega tudo, exceto o que for liberado antes) | **Sim** |
| 04 · Prevenção de intrusão | fail2ban + AppArmor | Não |
| 05 · Minimização | Remove pacotes desnecessários (ex.: snapd) | Não |
| 06 · Auditoria | auditd, Lynis, AIDE, rkhunter — demorada | Não |

> [!NOTE]
> **A fase 00 não atualiza o Docker — de propósito.** As fases rodam num terminal que é mantido de
> pé pelo próprio daemon do Docker, o mesmo que mantém o painel. Atualizar `docker-ce` reinicia esse
> daemon, e a fase derrubaria a si mesma no meio de um `dpkg` — foi exatamente o que aconteceu antes
> desta proteção existir. Por isso os pacotes do Docker ficam de fora do `full-upgrade` e também das
> atualizações automáticas; a fase lista no log quais ficaram e qual comando rodar.
>
> Para atualizar o Docker, entre **por SSH** (não pelo terminal do painel) e rode:
>
> ```bash
> sudo apt-get update && sudo apt-get install --only-upgrade docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
> ```
>
> O painel sai do ar por alguns segundos e **volta sozinho** (o compose usa `restart: unless-stopped`).
> Faça isso de tempos em tempos: como o Docker está fora das atualizações automáticas, ninguém mais
> vai fazer por você.

As três fases marcadas com confirmação (01, 02 e 03) mexem em como você entra na máquina — a
chave, a senha e o firewall. É por isso que, antes de aplicar qualquer uma delas, o próprio script
**já agenda a reversão automática no servidor**. Se ninguém confirmar em ~5 minutos, o servidor
desfaz sozinho o que acabou de fazer. Confirmar cancela esse agendamento — por isso o teste abaixo
importa: é a sua única forma de saber, antes de cancelar a rede de segurança, se ela ainda seria
necessária.

> [!IMPORTANT]
> **O procedimento de confirmação, passo a passo:**
>
> 1. Depois de aplicar a fase, o painel fica "aguardando confirmação" e um cronômetro de ~5
>    minutos começa a correr no servidor.
> 2. **Não teste na janela que já está aberta.** Uma sessão SSH já conectada continua
>    funcionando mesmo que a configuração nova esteja quebrada — ela não prova nada, porque não
>    passou pela mudança que você acabou de aplicar.
> 3. Abra uma **janela nova** de terminal (sem fechar a antiga) e conecte de novo:
>    ```bash
>    ssh SEU_USUARIO@SEU_IP
>    ```
> 4. **Só depois que a janela nova conectar de verdade**, volte ao painel e confirme.
> 5. Se a janela nova **não** conectar: **não confirme**. Deixe os 5 minutos passarem — o
>    servidor reverte sozinho a mudança, e você continua com o acesso da janela antiga.
> 6. Mantenha a janela antiga aberta até o fim de toda a etapa Segurança, mesmo depois de confirmar cada
>    fase.
>
> **Teste específico da fase 01:** a conexão na janela nova precisa entrar **sem pedir a senha da
> conta**. Ela pode pedir a *passphrase da sua chave* — isso é outra coisa, é local e não envolve
> o servidor. Se a janela nova ainda pedir a senha da conta, a chave não foi instalada
> corretamente; **não confirme**, e não avance para a fase 02 nesse estado — sem a chave
> funcionando, a fase 02 (que desliga o login por senha) trancaria você para fora.

Duas proteções já existem no próprio script e ajudam a evitar o pior cenário, mas **não
substituem o teste na janela nova**: a fase 01 só trava a senha do root se encontrar ao menos uma
chave SSH instalada, e a fase 02 se recusa a rodar (com erro) se o usuário informado não existir
ou não tiver chave. São redes de segurança, não uma prova de que o seu acesso específico funciona.

Se mesmo assim alguma coisa der errado, veja [Perdi o acesso — e agora?](#perdi-o-acesso--e-agora).

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

Recomendado — acesse por túnel SSH.

  1) Numa janela NOVA do terminal, no SEU COMPUTADOR (não na VPS), deixe aberto:

      ssh -L 9000:localhost:9000 SEU_USUARIO@203.0.113.10

     Se o ssh recusar com "bind [127.0.0.1]:9000: Address already in use", a porta
     ocupada é a do SEU computador (o número da ESQUERDA, antes dos dois-pontos) —
     não a da VPS. Troque só ele por outro qualquer, por exemplo:

       ssh -L 9100:localhost:9000 SEU_USUARIO@203.0.113.10

     e abra o navegador em http://localhost:9100/... em vez de :9000.

  2) Com essa janela aberta, abra no navegador:

      http://localhost:9000/?token=<seu-token-de-48-caracteres>

Direto pelo IP — sem criptografia; use só em rede confiável ou ambiente de
teste descartável:

      http://203.0.113.10:9000/?token=<seu-token-de-48-caracteres>

┌──────────────────────────────────────────────────────────────────────────┐
│                            ⚑  SETUP TOKEN  ⚑                              │
│                                                                          │
│   <seu-token-de-48-caracteres>                                            │
│                                                                          │
│   ⚠  Ele aparece SÓ AGORA em destaque. Guarde-o até concluir o wizard.   │
│   ⚠  Após criar a conta admin no fim do wizard, ele é invalidado.        │
└──────────────────────────────────────────────────────────────────────────┘
```

**O que fazer:** veja a explicação completa **acima** (túnel SSH recomendado). O link direto
pelo IP funciona, mas trafega sem criptografia — copie o **link completo**
(`http://SEU-IP:9000/?token=...` ou, pelo túnel, `http://localhost:9000/?token=...`) e cole no
navegador. O link já leva o token embutido — não precisa digitar nada.

**Fechou o terminal e perdeu o banner?** Sem pânico. Na VPS, rode qualquer um dos dois:

```bash
sudo ./scripts/show-token.sh                       # reexibe o link completo + token
sudo docker exec tws-panel cat /data/setup-token   # mostra só o token
```

**Erros comuns:**

- **`bind [127.0.0.1]:9000: Address already in use`** (ao abrir o túnel) — a porta ocupada é a
  **do seu computador**, não a da VPS: o número da **esquerda** no `ssh -L`. Algum programa seu já
  está usando a 9000 (é comum em quem programa). Troque só esse número e abra o navegador nele:
  `ssh -L 9100:localhost:9000 SEU_USUARIO@SEU_IP`, depois `http://localhost:9100/?token=...`.
  Qualquer número alto e livre serve — 9100, 9300, 12345. Entenda as
  [duas portas do túnel](#duas-portas). Na próxima instalação, esse erro nem aparece se você
  [conferir antes qual porta está livre no seu computador](#porta-livre-no-seu-computador) e
  informar esse número ao instalador.
- **`channel 2: open failed: connect failed: Connection refused`** (o túnel abre, mas o navegador
  diz que não conseguiu conectar) — aí é o outro lado: o número da **direita** não bate com a porta
  em que o painel está na VPS. Confira com `sudo ./scripts/show-token.sh`, que imprime o comando
  já com a porta certa.
- **`permission denied while trying to connect to the Docker daemon socket`** — faltou o `sudo`
  na frente do comando. É de propósito: o painel não coloca ninguém no grupo docker (veja
  [o porquê](#grupo-docker)).
- **`setup token não encontrado... O painel está instalado?`** — o `show-token.sh` foi rodado
  numa máquina sem o painel instalado. Rode-o na VPS certa, de dentro de `/opt/tws-panel`.
- **O token não funciona mais no navegador** — depois que você cria a conta admin (última
  etapa do wizard), o token é **invalidado para sempre**. A partir daí o acesso é pela tela de
  login, com seu usuário e senha do painel.

</details>

Depois do wizard: cadastre um projeto, aponte o DNS, e o painel cuida do build, do proxy e do
SSL. Guia completo de produção em [docs/production.md](docs/production.md).

### Onde ficam os arquivos dos seus projetos

Cada projeto que você implanta tem uma pasta própria no servidor, com o código clonado do Git
e o `docker-compose.yml` que o painel gera. Por padrão essas pastas ficam em
**`/opt/tws-projects`** — ao lado de `/opt/tws-panel`, e fora de qualquer `/home`, para não
sumirem se você um dia apagar um usuário do Linux.

Elas ficam num diretório de verdade da VPS, e não escondidas dentro do container, por dois
motivos práticos:

- **Você consegue olhar.** Conectado por SSH, `ls /opt/tws-projects` já mostra tudo; dá para
  ler um log, copiar um arquivo ou fazer backup com as ferramentas de sempre.
- **Projetos que gravam arquivos funcionam.** Se o `docker-compose.yml` do seu projeto tem uma
  linha como `./dados:/app/dados` (guardar uploads, um banco SQLite, o que for), quem procura
  essa pasta `dados` é o Docker **da VPS**, não o painel. Se ela existisse só dentro do
  container do painel, o Docker criaria uma pasta vazia e o seu projeto subiria sem os dados.
  Por isso o caminho é exatamente o mesmo dentro e fora.

**Quer usar outro lugar** (um disco maior montado em `/mnt/dados`, por exemplo)? Escolha na
hora de instalar:

```bash
./scripts/install.sh --projects-dir=/mnt/dados/projetos
```

> [!IMPORTANT]
> Essa escolha é feita **na instalação**, não numa tela do painel. Trocar a pasta significa
> trocar uma montagem do container, e um container só pega uma montagem nova quando é
> recriado. Se precisar mudar depois, edite a linha `PAAS_PROJECTS_DIR=` do arquivo `.env` em
> `/opt/tws-panel`, mova os arquivos antigos para o novo lugar (`sudo mv`), ajuste o dono
> (`sudo chown -R 10001:10001 /novo/caminho`) e rode `sudo docker compose up -d` — ele recria o
> painel com a nova pasta. Só reiniciar (`restart`) **não** basta.

> [!NOTE]
> Se você já tinha o painel instalado antes desta mudança, nada se move sozinho: sem a linha
> `PAAS_PROJECTS_DIR=` no `.env`, o painel continua usando o lugar antigo e os projetos que
> você já criou seguem onde estavam.

<a id="trocar-terminal"></a>

### Trocar o usuário do terminal do painel

O usuário com que o terminal abre e o modo (`senha` ou `segundo-plano`) ficam gravados no arquivo
`.env` de `/opt/tws-panel`. Para mudar, rode o instalador de novo pedindo para ele perguntar outra
vez:

```bash
cd /opt/tws-panel
./scripts/install.sh --reconfigure-terminal
```

Ele refaz as mesmas perguntas, valida a resposta e recria o painel com a escolha nova. Seus
projetos, domínios, e-mail e a conta de administrador não são tocados — é a mesma reinstalação
segura de sempre. Se preferir não responder nada, informe direto:

```bash
./scripts/install.sh --terminal-user=OUTRO_USUARIO --root-mode=segundo-plano
```

> [!NOTE]
> Instalou o painel antes de essa pergunta existir? Nada muda sozinho: sem as linhas
> `PAAS_TERMINAL_USER=` e `PAAS_ROOT_MODE=` no `.env`, o terminal continua abrindo como root, como
> antes. Rodar o instalador de novo de forma interativa faz a pergunta — e, se quiser manter tudo
> como está, basta responder `root`.

<a id="trocar-porta"></a>

### Trocar a porta do painel na VPS

A porta em que o painel atende **na VPS** é a que você escolheu na instalação (padrão `9000`) e
fica gravada na linha `PAAS_PORT=` do `.env` de `/opt/tws-panel`. Para trocar, rode o instalador
de novo informando a nova:

```bash
cd /opt/tws-panel
./scripts/install.sh --port=9500
```

Ele confere se a porta nova está livre, recusa as que quebrariam o painel (22, 80, 443 e as do
e-mail), recria o container e imprime o comando de túnel já com o número certo. Seus projetos,
domínios, e-mail e a conta de administrador não são tocados.

> [!NOTE]
> Só a porta **de fora** muda. Dentro do container o painel continua atendendo na 9000 — é o
> `docker-compose.yml` que faz a ligação (`"${PAAS_PORT:-9000}:9000"`). Por isso não adianta
> editar o `.env` e dar `restart`: um container só pega uma publicação de porta nova quando é
> recriado (`sudo docker compose up -d`).

> [!TIP]
> Se o problema é a porta ocupada **no seu computador** na hora de abrir o túnel, não mexa aqui:
> troque só o número da esquerda do `ssh -L`. Veja [as duas portas do túnel](#duas-portas).

### Comandos úteis (produção)

```bash
sudo docker compose ps            # status do painel
sudo docker compose logs -f panel # logs em tempo real
sudo docker compose up -d --build # atualizar para uma nova versão (git pull antes)

sudo ./scripts/show-token.sh      # reexibe a URL + setup token (se você perdeu o token)
sudo ./scripts/reset-setup.sh     # recomeça o wizard do zero (--full apaga também usuários/sessões)
./scripts/install.sh --reconfigure-terminal   # troca o usuário/modo do terminal do painel
./scripts/install.sh --port=9500              # troca a porta do painel na VPS
./scripts/uninstall.sh --dry-run              # mostra o que a remoção do painel apagaria
```

> [!NOTE]
> Os comandos de Docker e os scripts `show-token.sh` e `reset-setup.sh` levam `sudo` porque o
> painel não coloca ninguém no grupo docker — estar nele é ter root sem senha
> ([entenda](#grupo-docker)). Sem o `sudo`, o erro é `permission denied ... docker.sock`.

### Modo dev local

```bash
pnpm install
SETUP_TOKEN=dev-token pnpm dev
# ou, com Docker:
SETUP_TOKEN=dev-token docker compose -f docker-compose.dev.yml up
```

- Painel (build de produção servido pela API): `http://localhost:9000`
- Frontend com hot reload: `http://localhost:5173` (proxy `/api` → 9000)
- Wizard: `http://localhost:5173/setup` com o token `dev-token`
- Domínios de projeto: use `*.localhost` (servidos em HTTP puro pelo Caddy, sem SSL)

Exemplos prontos para deploy em [`examples/`](examples/README.md).

> [!WARNING]
> Os exemplos são **apenas para testes** — não os use como base de produção sem revisão.

> [!IMPORTANT]
> 🔒 **Validação automática:** o `pnpm install` ativa hooks locais de pre-commit
> (arquivos proibidos + scan de segredos + typecheck incremental) e pre-push
> (testes + cobertura + build). O CI no GitHub Actions é o portão final —
> detalhes no [CONTRIBUTING.md](CONTRIBUTING.md).

## Arquitetura

Monorepo pnpm com TypeScript estrito de ponta a ponta:

```
tws-panel/
├── apps/
│   ├── server/                  # API Fastify: wizard, projetos, domínios,
│   │                            # e-mail, segurança, alertas e auditoria
│   └── web/                     # SPA React (Vite + Tailwind + shadcn/ui):
│                                # wizard /setup + dashboard dark pt-BR
├── packages/
│   ├── core/                    # tipos e constantes compartilhados
│   ├── security/                # engine de scan + hardening + baseline/diff
│   ├── deploy/                  # detecção, ingestão, guardrails, Caddy, pipelines
│   └── mailer/                  # Stalwart, DKIM, checklist DNS, blacklist
├── scripts/
│   ├── install.sh               # instalador one-shot (idempotente, 100% Docker)
│   ├── hardening/               # scripts shell idempotentes por fase (00–06)
│   └── test-*.mts               # suítes de verificação (Fases 3 e 4)
├── examples/                    # apps de exemplo para deploy (apenas testes)
├── docs/                        # specs, guias de produção e troubleshooting
├── Dockerfile                   # build multi-stage do painel (produção)
├── docker-compose.yml           # produção: painel em PAAS_PORT (padrão 9000)
└── docker-compose.dev.yml       # dev local com hot reload
```

Como os módulos se relacionam:

```
                    ┌─────────────┐
        browser ───►│  apps/web   │ (SPA: wizard + dashboard)
                    └──────┬──────┘
                           │ /api
                    ┌──────▼──────┐      ┌───────────────┐
                    │ apps/server │─────►│ @paas/security│──► host (Lynis, UFW,
                    │  (Fastify)  │      └───────────────┘    fail2ban, baseline)
                    └──┬───┬───┬──┘
                       │   │   │      ┌───────────────┐
                       │   │   └─────►│  @paas/deploy │──► Docker + Caddy central
                       │   │          └───────────────┘    (SSL automático)
                       │   │          ┌───────────────┐
                       │   └─────────►│ @paas/mailer  │──► Stalwart (SMTP/IMAP/DKIM)
                       │              └───────────────┘
                       │              ┌───────────────┐
                       └─────────────►│   @paas/core  │ (tipos compartilhados)
                                      └───────────────┘
        Estado persistido no volume paas_data (/data, arquivos JSON, modo 0600)
        — sem serviços externos.
```

## Roadmap

| Item | Descrição |
|---|---|
| 2FA TOTP | Segundo fator no login do painel |
| MTA-STS / TLS-RPT | Política de TLS obrigatório + relatórios de falha |
| BIMI | Logo verificado (requer DMARC endurecido + VMC) |
| Warm-up de IP | Assistente de aquecimento de reputação para IPs novos |
| Backups na UI | Agendamento/restore de volumes Docker pela interface |
| Multi-servidor | Gerenciar várias VPS a partir de um painel (v2) |

Fases já entregues: **0** Fundação · **1** Hardening · **2** Deploy + Domínios ·
**3** E-mail · **4** Guardrails + Monitoramento · **5** Polish open source.

## Segurança

Encontrou uma vulnerabilidade? **Não abra uma issue pública.** Leia [SECURITY.md](SECURITY.md)
para saber como reportar de forma responsável.

O painel foi desenhado com segurança em mente: wizard protegido por token de uso único, Docker
socket nunca exposto via TCP, CORS same-origin por padrão, rate limiting, validação de schema em
todas as rotas da API, logs com redação de segredos e auditoria de todas as ações sensíveis.

> [!TIP]
> Duas fases do hardening (etapa **Segurança** do wizard) merecem atenção antes de rodar:
>
> - **Fase 05 (Minimização)** remove o `snapd` e o bloqueia. Se algum programa seu depende de
>   snap, saiba disso antes — o rollback dessa fase restaura a configuração do APT, mas **não
>   reinstala** os pacotes removidos. Exceção: se o Docker deste servidor vier de um snap
>   (`snap install docker`), a fase detecta isso e preserva esse snap e o `snapd` — removê-los
>   derrubaria o próprio painel —, removendo só os demais snaps e explicando no log.
> - **Fase 06 (Auditoria)** demora vários minutos: ela cria a baseline do AIDE varrendo o sistema
>   de arquivos. Parece travada, mas não está.

**Seja franco sobre o que isto exige.** Um PaaS precisa de acesso privilegiado ao host — não há
como criar containers e configurar firewall sem ele. Duas consequências que você deve conhecer
antes de instalar:

- **O terminal web é um shell real na VPS**, não uma lista de ações pré-aprovadas. É o que
  permite ver e conduzir o hardening como se estivesse no SSH, e é também o ponto mais sensível
  do sistema. Na instalação você escolhe com qual usuário ele abre: com o seu usuário comum, o que
  precisa de root passa pelo `sudo` com a sua senha (modo `senha`) ou roda por trás e fica na
  Auditoria (modo `segundo-plano`); com `root`, quem tem sessão no painel tem o terminal de root
  da máquina. Veja [o que cada escolha significa](#terminal-do-painel).
- **O socket do Docker é montado no container do painel**, o que equivale a root no host. É uma
  propriedade do Docker, não uma falha do painel, e nenhum hardening do container altera isso.

Ambos estão documentados em detalhe, junto com o que o projeto **não** protege e as dívidas de
segurança conhecidas, em [comoFuncionaSistema/global/threat-model.json](comoFuncionaSistema/global/threat-model.json).
Recomendamos não expor o painel à internet aberta: prefira VPN ou restrição por IP.

**Autenticação:** o painel nasce protegido pelo setup token gerado na instalação; na etapa
**Conta de administrador** do wizard você cria essa conta (senha com hash argon2id, mínimo de 12 caracteres com
maiúsculas, minúsculas e números), o que conclui o setup e invalida o token para sempre. Daí em
diante todo acesso exige login (`/login`): as sessões são revogáveis, persistidas no servidor
(cookie httpOnly, SameSite=Lax, expiração de 12h — nada de JWT stateless), o login tem rate limit
de 5 tentativas/minuto por IP com lockout progressivo, e trocar a senha invalida as demais sessões.
Login, logout, falhas e criação da conta admin ficam registrados no log de auditoria.

## Perdi o acesso — e agora?

O hardening fecha portas de propósito, e isso corta caminhos de volta. Esta seção existe para
você não descobrir isso no pior momento. Achou seu caso na tabela? Vá direto para ele.

| O que você perdeu | O que ainda funciona | Caminho de volta |
|---|---|---|
| Senha do **painel** (login web) | SSH na VPS | `sudo ./scripts/reset-setup.sh --full` |
| Senha do **usuário Linux** (a do `sudo`) | SSH + painel | Terminal do painel (se ele abre como root) → `passwd SEU_USUARIO`; senão, console do provedor |
| **Chave SSH** | Painel acessível | Terminal do painel (se ele abre com o seu usuário ou root) → recoloca a chave |
| **Chave SSH** | Console do provedor | Login com usuário e senha → recoloca a chave |
| Tudo acima | — | Modo de recuperação (rescue) do provedor |

> [!IMPORTANT]
> **Confirme o seu caminho de recuperação ANTES de aplicar o hardening.** Entre no painel do seu
> provedor e procure por "Console", "VNC", "Rescue" ou "Modo de recuperação". Se você não achar
> nenhum, a prevenção descrita no Passo 4 da instalação deixa de ser recomendação e passa a ser obrigatória:
> sem console, não existe rede de segurança e uma chave perdida pode significar reinstalar a
> máquina do zero.

### Perdi a senha do painel

A conta de administrador do painel é independente do sistema. Com acesso SSH à VPS, apague a
conta e refaça a etapa **Conta de administrador** do wizard:

```bash
cd /opt/tws-panel
sudo ./scripts/reset-setup.sh --full
sudo ./scripts/show-token.sh
```

O primeiro comando apaga a conta admin e todas as sessões (pede confirmação: digite `resetar`).
O segundo mostra o setup token de novo, para você reabrir o wizard e criar uma conta nova.

**Seus projetos, domínios, e-mail e histórico de segurança não são tocados.**

### Perdi a senha do usuário Linux

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

### Perdi a chave SSH

Você precisa reinstalar uma chave nova em `~/.ssh/authorized_keys` do seu usuário. Gere um par
novo no seu computador (Passo 4 da instalação) e use um dos caminhos abaixo, na ordem:

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

### O paradoxo do terminal do painel

Você deve ter notado que o terminal embutido aparece duas vezes como salvação. Quanto mais poder
ele tem, mais ele salva — e mais perigoso ele é. Aberto como root, ele é a porta dos fundos quando
tudo o mais falha, e exatamente por isso o ponto mais sensível do sistema. Aberto com o seu
usuário (o recomendado), ele salva menos, mas uma sessão esquecida também entrega menos.

Vale saber que é assim, e decidir conscientemente: manter o painel acessível é uma rede de
segurança, mas é também a maior superfície de ataque da instalação. Se você optar por restringir
o acesso a ele, garanta antes que o console do seu provedor funciona.

## Documentação

| Doc | Conteúdo |
|---|---|
| [docs/production.md](docs/production.md) | Do dev à VPS real: portas, DNS, ACME, PTR, ordem recomendada |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Porta 25 bloqueada, e-mail em spam, cert não emitido, wizard inacessível… |
| [docs/README.md](docs/README.md) | Índice completo da documentação |
| [comoFuncionaSistema/](comoFuncionaSistema/) | Documentação legível por máquina: um JSON por endpoint, com parâmetros, erros, efeitos colaterais e testes. Escrita para agentes de IA — comece por `index.json` |
| [threat-model.json](comoFuncionaSistema/global/threat-model.json) | O que o painel protege, o que não protege, quais privilégios exige e por quê |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Como contribuir (setup, padrões, como estender o painel) |
| [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) | Código de conduta |
| [SECURITY.md](SECURITY.md) | Política de segurança e reporte de vulnerabilidades |

## Sobre a TWS

O **TWS Panel** é um projeto open source mantido pela **TWS**, software house fundada e liderada
pelo CEO **Kelvin**. A TWS desenvolve soluções web, sistemas e automações sob medida para
clientes — e este projeto nasceu de uma dor real da própria empresa, contada logo no começo
deste README: ficar com projetos de clientes parados, dependendo de uma resposta que não vinha.
Em vez de ficar só no uso interno, decidimos liberar o painel para a comunidade, sob licença MIT.

Quer conversar sobre parcerias, projetos ou contribuições?

- 🌐 Site: [tws.tec.br](https://tws.tec.br/)
- ✉️ E-mail: [contato@tws.tec.br](mailto:contato@tws.tec.br)
- 💼 LinkedIn: [Kelvin Medeiros](https://www.linkedin.com/in/kelvin-medeiros-37920487)

**Autor:** Kelvin — CEO & Founder @ TWS

## Licença

[MIT](LICENSE) © 2026 TWS — Kelvin
