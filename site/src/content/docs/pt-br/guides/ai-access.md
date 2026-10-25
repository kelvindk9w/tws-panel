---
title: "Acesso por IA (tokens de API)"
description: "Como criar, usar e revogar tokens de API para que um programa, como um assistente de IA, consulte ou opere o painel sem a sua senha."
sidebar:
  label: "Acesso por IA (tokens de API)"
---

Um **token de API** deixa um programa (um script, uma ferramenta, um assistente de IA) chamar a API do
painel sem a sua senha e sem sessão de navegador. Você decide o que ele pode fazer e por quanto tempo,
e pode revogá-lo a qualquer momento. Os tokens ficam em **Configurações → Acesso por IA**.

> [!NOTE]
> Esta é a base. Hoje o token funciona com a API HTTP do próprio painel. A integração pronta
> "conectar um assistente de IA" (MCP) está planejada em cima destes tokens e ainda não faz parte desta página.

## Criar um token

1. Abra **Configurações → Acesso por IA**.
2. Dê um **nome** (ele aparece na Auditoria como `token:nome`), escolha o **escopo** e a **validade**.
3. Confirme com a sua **senha atual** e, se a verificação em duas etapas estiver ativa, com o **código do app autenticador**.
4. **Copie o token na hora.** Ele aparece **uma única vez**. O painel guarda só uma impressão digital (hash), então ninguém, nem você, consegue ver de novo. Se perder, revogue e crie outro.

| Escopo | O que o token pode fazer |
|---|---|
| **Leitura** | Só olhar: projetos, saúde, domínios, backups, auditoria. Não muda nada. |
| **Escrita** | Leitura, mais mudanças do dia a dia: deploy, iniciar e parar projetos, backups. Não troca repositório, domínios nem portas. |
| **Administração** | Escrita, mais ações administrativas: criar projeto ou trocar o repositório de um projeto, apagar projetos (só token de painel inteiro), trocar o domínio do painel, endurecer o servidor, restaurar backups de projeto e de e-mail. |

## Escolher o alcance: o painel inteiro ou só alguns projetos

Além do **escopo** (o que o token pode fazer), você escolhe o **alcance** (onde ele pode fazer):

| Alcance | O que o token enxerga |
|---|---|
| **O painel inteiro** | Todos os projetos e as áreas do painel que o escopo permite. É como os tokens funcionavam antes. |
| **Só os projetos que eu escolher** | Apenas os projetos marcados. Para o token, **os outros projetos não existem**: a lista não os mostra e pedir um deles pelo número dá o mesmo "Projeto não encontrado" de um projeto que nunca existiu. |
| **Só os projetos escolhidos, e pode criar projetos novos** | Igual ao anterior, e cada projeto que o próprio token criar **entra sozinho na lista dele**, para ele configurar e publicar sem sair do limite. Precisa do escopo de Administração (criar projeto é uma ação administrativa). |
| **Só os domínios dos projetos que eu escolher** | Para o **app do seu cliente** cadastrar e remover os domínios do próprio projeto, e mais nada: não lê o projeto, não faz deploy, não vê o resto do painel. Só nos níveis Leitura ou Escrita (sem Administração, sem "pode criar"). Veja [domínios dos seus clientes (SaaS)](saas-domains.md). |

**Exemplo: "só a fazenda".** Você tem os projetos "Fazenda", "Loja" e "Blog" e quer que um assistente
cuide apenas da Fazenda. Em **Configurações → Acesso por IA**, escolha o escopo **Escrita**, o alcance
**Só os projetos que eu escolher**, marque **Fazenda** e crie o token. Com ele, o assistente consegue
publicar e reiniciar a Fazenda, mas a listagem de projetos só mostra a Fazenda e qualquer pedido sobre a
Loja ou o Blog responde "Projeto não encontrado".

Um token limitado a projetos **nunca** alcança o que é do painel ou do servidor, qualquer que seja o escopo:
o domínio do painel, o servidor de e-mail (domínios e caixas), os backups e a restauração do painel e do
e-mail, a segurança do servidor, usuários e verificação em duas etapas, avisos e integrações, a
configuração geral, a Auditoria e os Alertas do painel, a lista de containers, as portas do servidor, o
terminal e os outros tokens. Tudo isso responde `403` e fica só com o token de **painel inteiro**.
Dentro de um projeto do alcance, valem o escopo e as mesmas regras de sempre (por exemplo, domínios e
portas exigem Administração). Por segurança, um token limitado só cria projeto a partir de **repositório
Git** e **não troca a fonte** de um projeto existente (uma pasta do servidor daria acesso a arquivos de
outros projetos). **Repositório privado:** um projeto criado por um token limitado **nunca usa a conta do GitHub conectada** para baixar o código; ele só enxerga repositório **público** (ou usa a credencial que você pôr naquele projeto, na aba Git). Sem isso, apontar o projeto para o repositório privado de outra pessoa clonaria com o acesso da sua conta. Se o repositório é seu e privado, abra o projeto, aba Git, e use **Liberar a conta do GitHub** (pede a senha e o código). Projetos criados por você ou por um token de painel inteiro seguem como antes: usam a conta conectada em qualquer repositório do github.com que ela consiga ler.

**Pode criar projetos** só existe com o escopo de **Administração** (criar projeto é ação administrativa); a tela e o servidor recusam a combinação com Leitura ou Escrita. O apelido (slug) de um projeto criado por token limitado sempre leva um sufixo aleatório, esteja o nome livre ou não, para não revelar que existe um projeto com o mesmo nome fora do alcance.

Quando um domínio ou uma porta não puder ser usado por já estar em uso por algo fora do
alcance dele, a recusa diz apenas "indisponível", sem dizer quem usa.

**Mudar a lista depois.** Na lista de tokens, **Editar projetos** troca os projetos de um token de
alcance limitado. **Diminuir** o alcance (tirar projeto, desligar "pode criar") vale na hora e não pede
senha: tirar acesso é sempre seguro e precisa ser rápido. **Aumentar** (marcar projeto novo, ligar "pode
criar") pede a senha atual e, havendo 2FA, o código, como na criação. Apagar um projeto o tira da lista
de todos os tokens, e o número de um projeto apagado nunca é reaproveitado. Um token não muda o próprio alcance. Se o token criar um projeto enquanto você edita a lista, o painel recusa o salvamento (409), mostra o projeto novo já marcado e você envia de novo: nada some em silêncio.

:::caution[Quem publica código tem acesso às variáveis]
Um deploy roda o código do projeto **com as variáveis dele** (senhas, chaves). Por isso um token de **Escrita** (que dispara deploy) e, mais ainda, um de **Administração** (que pode trocar o repositório e então publicar) devem ser tratados como **acesso às variáveis dos projetos** que alcançam, mesmo que a API nunca devolva esses valores. O painel fecha os atalhos diretos (ver abaixo), mas não consegue separar "publicar código" de "ler o que o código lê". **Limitar o token a poucos projetos é justamente essa proteção:** ele só alcança as variáveis dos projetos da lista. Limitar não cria uma caixa isolada: o código publicado roda no servidor, sob as regras de segurança do deploy. Dê só **Leitura** sempre que bastar.
:::

Validade: **30 dias** por padrão, de 1 hora até **1 ano**. Escolha **24 horas** para uma conexão pontual.
No máximo 20 tokens ativos ao mesmo tempo.

## Usar um token

Envie no cabeçalho `Authorization`, nunca no endereço (o endereço vai para logs e histórico, e o painel o recusa):

```bash
export TWS_PANEL_TOKEN='cole-o-token-aqui'   # fora do histórico do terminal e de conversas
curl -H "Authorization: Bearer $TWS_PANEL_TOKEN" https://painel.exemplo.com/api/projects
```

O token **não** é um cookie: ele não abre a interface web, e uma requisição que o carrega nunca recebe cookie de sessão.

## O que um token nunca faz

Mesmo com escopo de **Administração**, um token não consegue:

- abrir o **terminal web**;
- recomeçar o **assistente de instalação**;
- trocar a **senha** ou a **verificação em duas etapas**;
- revelar **senhas de backup** nem **credenciais de caixas de e-mail**;
- ler nem gravar os **valores das variáveis** dos projetos pela API (veja o aviso acima sobre deploy);
- ligar a **senha de uma caixa de e-mail** a uma variável do projeto;
- **restaurar o painel** (isso troca usuários, senha e verificação em duas etapas);
- testar acesso ao Git com um **token do GitHub** digitado ou o da conta conectada;
- **liberar os bloqueios de segurança do deploy** (o "override" que deixa passar, por exemplo, `privileged: true`): só você, na tela, depois de ler o relatório;
- **liberar a conta do GitHub conectada** para um projeto criado por token limitado (veja abaixo);
- **apagar projeto**, quando o token é limitado a projetos: apagar pede a confirmação de uma pessoa na tela (virá com a próxima fase); um token de painel inteiro com Administração ainda apaga;
- mexer nos **tokens do GitHub ou de outros serviços**, nem na chave do Spamhaus;
- **criar, listar ou revogar tokens** (só você, entrando no painel, faz isso).

O painel responde `403` a tudo isso. Essas rotas estão numa lista fixa no código, e um teste confere todas as rotas. Uma rota nova que ainda não foi classificada **é negada** para tokens até alguém decidir.

Algumas ações dependem do que é enviado: trocar o repositório, a branch, o domínio ou o proxy de um projeto, e pedir uma varredura de segurança nova, exigem **Administração**. O mesmo vale para tudo que muda o que a internet alcança: domínios do projeto (adicionar, remover, principal, porta, par com/sem www), portas publicadas, o webmail e o destino dos avisos. A consulta da varredura de segurança por token só devolve um relatório que já existe: sem relatório, o painel responde "ainda não há relatório" em vez de varrer. A varredura de saúde por token não usa o terminal do painel (rede e reinício pendente aparecem como indisponíveis).

**Logs dos containers.** Nenhum token lê o **valor** das variáveis, mas um token com nível **Leitura** já lê a aba **Logs** dos projetos do seu alcance (as linhas que os containers escrevem e o estado de cada serviço). O painel esconde os valores das variáveis e padrões óbvios de senha, mas isso é feito em melhor esforço: um log pode ter dado do seu negócio, e um segredo escrito de outro jeito pode escapar (por exemplo, o valor antigo de uma variável que você trocou). Se isso for um problema, dê o token só aos projetos que podem ser lidos.

## Revogação e validade

- **Revogar** na lista vale imediatamente.
- Token vencido simplesmente para de funcionar.
- Trocar a **senha** revoga todos os tokens. Recomeçar o assistente também.
- Toda ação feita por um token aparece na **Auditoria** como `token:nome`. O token em si nunca aparece.

## Bons hábitos

- Um token por ferramenta, com o menor escopo que resolve e validade curta.
- Trate como senha: gerenciador de senhas, não conversa, e-mail, captura de tela ou repositório.
- Se um token pode ter vazado, revogue primeiro e investigue depois.
- Vários tokens errados seguidos vindos de um mesmo endereço bloqueiam esse endereço por um tempo.
