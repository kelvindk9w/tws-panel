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
| **Administração** | Escrita, mais ações administrativas: criar projeto ou trocar o repositório de um projeto, apagar projetos, trocar o domínio do painel, endurecer o servidor, restaurar backups de projeto e de e-mail. |

:::caution[Quem publica código tem acesso às variáveis]
Um deploy roda o código do projeto **com as variáveis dele** (senhas, chaves). Por isso um token de **Escrita** (que dispara deploy) e, mais ainda, um de **Administração** (que pode trocar o repositório e então publicar) devem ser tratados como **acesso às variáveis dos projetos** que alcançam, mesmo que a API nunca devolva esses valores. O painel fecha os atalhos diretos (ver abaixo), mas não consegue separar "publicar código" de "ler o que o código lê". Dê só **Leitura** sempre que bastar.
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
- mexer nos **tokens do GitHub ou de outros serviços**, nem na chave do Spamhaus;
- **criar, listar ou revogar tokens** (só você, entrando no painel, faz isso).

O painel responde `403` a tudo isso. Essas rotas estão numa lista fixa no código, e um teste confere todas as rotas. Uma rota nova que ainda não foi classificada **é negada** para tokens até alguém decidir.

Algumas ações dependem do que é enviado: trocar o repositório, a branch, o domínio ou o proxy de um projeto, e pedir uma varredura de segurança nova, exigem **Administração**. O mesmo vale para tudo que muda o que a internet alcança: domínios do projeto (adicionar, remover, principal, porta, par com/sem www), portas publicadas, o webmail e o destino dos avisos. A consulta da varredura de segurança por token só devolve um relatório que já existe: sem relatório, o painel responde "ainda não há relatório" em vez de varrer. A varredura de saúde por token não usa o terminal do painel (rede e reinício pendente aparecem como indisponíveis).

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
