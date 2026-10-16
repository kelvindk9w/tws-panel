# Wizard de segurança

Como conduzir a etapa **Segurança** do assistente de configuração (o [Passo 8](instalacao.md#passo-8)
da instalação). As mesmas fases ficam disponíveis depois da instalação, em
**Segurança → Proteções** (`/security/hardening`), para revisar, simular ou reaplicar.

## Como funciona

Uma varredura com o **Lynis** e checagens próprias dá a nota antes e depois. O hardening roda em
fases idempotentes, com backup de cada arquivo alterado. Cada fase pode ser **simulada** antes:
nada muda na VPS durante a simulação. As varreduras e as fases rodam no terminal embutido do
painel, e você vê os comandos de verdade, como faria por SSH.

## As oito fases

A etapa **Segurança** aplica o hardening em **oito fases**, uma de cada vez: aplique, confirme, só então
avance para a próxima. Nunca dispare uma fase nova com a anterior ainda pendente de confirmação.

| Fase | O que faz | Pede confirmação? |
|---|---|---|
| 00 · Atualizações | `apt full-upgrade` + atualizações automáticas (**menos o Docker**) | Não |
| 01 · Usuário não-root | Instala sua chave SSH e trava a senha do root | **Sim** |
| 02 · SSH | Desliga login por senha e o root via SSH; só o seu usuário entra. Mantém o túnel do painel (`ssh -L`) funcionando | **Sim** |
| 03 · Firewall | Ativa o UFW (nega tudo, exceto o que for liberado antes) | **Sim** |
| 04 · Prevenção de intrusão | fail2ban + AppArmor | Não |
| 05 · Minimização | Remove pacotes desnecessários (ex.: snapd) | Não |
| 06 · Auditoria | auditd, Lynis, AIDE, rkhunter — demorada | Não |
| 07 · Endurecimento adicional | As recomendações do Lynis seguras de automatizar: core dump desligado, umask 027, módulos e ajustes de kernel, aviso legal no login, compiladores só para o root, contabilidade de processos | Não |

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
> 3. Abra o **terminal do seu computador** (não o navegador — no Windows, o PowerShell), numa
>    janela nova, sem fechar a antiga, e rode o comando que o painel mostra (tem botão de copiar):
>    ```bash
>    ssh SEU_USUARIO@SEU-IP-COM-HÍFENS.sslip.io
>    ```
> 4. **Só depois que a janela nova conectar de verdade** (aparece `SEU_USUARIO@…$`), digite
>    `exit` e clique em **Entrei — confirmar** no painel.
> 5. Se a janela nova **não** conectar: clique em **Não consegui entrar — desfazer agora**. O
>    servidor desfaz **só esta fase** na hora — as anteriores continuam valendo e as seguintes não
>    rodam. É por isso que cada uma dessas fases tem o seu teste: se algo der errado, você sabe
>    exatamente qual foi e perde só aquela parte. (Se você não fizer nada, ela também se desfaz
>    sozinha quando o cronômetro acabar.)
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

Se mesmo assim alguma coisa der errado, veja [Perdi o acesso — e agora?](recuperar-acesso.md).

## Antes de rodar: fases que merecem atenção

> [!TIP]
> Três fases do hardening merecem atenção antes de rodar, e há um último passo depois delas:
>
> - **Fase 05 (Minimização)** remove o `snapd` e o bloqueia. Se algum programa seu depende de
>   snap, saiba disso antes — o rollback dessa fase restaura a configuração do APT, mas **não
>   reinstala** os pacotes removidos. Exceção: se o Docker deste servidor vier de um snap
>   (`snap install docker`), a fase detecta isso e preserva esse snap e o `snapd` — removê-los
>   derrubaria o próprio painel —, removendo só os demais snaps e explicando no log.
> - **Fase 06 (Auditoria)** demora vários minutos: ela cria a baseline do AIDE varrendo o sistema
>   de arquivos. Parece travada, mas não está. A nota final (auditoria completa do Lynis, depois
>   da última fase) também leva de 2 a 5 minutos.
> - **Fase 07 (Endurecimento adicional)** não aplica tudo o que o Lynis sugere — de propósito.
>   Ficam de fora: expiração de senha (a senha do seu usuário expiraria e o `sudo` do terminal
>   pararia de funcionar), senha no GRUB (um erro impede a VPS de reiniciar sozinha), trocar a
>   porta do SSH (quebra o túnel e o guia de instalação), partições separadas (só na instalação do
>   sistema) e o `apt-listbugs` (feito para o Debian, não para o Ubuntu). Por isso a nota do
>   Lynis não chega a 100 — e não precisa: o que sobra são escolhas conscientes, explicadas acima.
> - **Depois da última fase, reinicie a VPS** (`sudo reboot`), espere um minuto e abra o painel
>   de novo (pelo mesmo endereço, ou pelo túnel se esse for o seu acesso): o kernel atualizado pela
>   fase 00 e os ajustes de kernel só valem depois do reboot.
