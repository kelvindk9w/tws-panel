---
title: "Conectar um assistente de IA (MCP)"
description: "Como ligar o MCP do painel, criar o token, conectar um cliente (Claude Code e outros), o que cada ferramenta faz, as quatro opções de poder (segurança, segredos, aprovação humana, métricas) e como aprovar ações sensíveis."
sidebar:
  label: "Assistente de IA (MCP)"
---

O **MCP** (Model Context Protocol) é a forma padrão de um assistente de IA usar ferramentas. Com ele ligado, o
assistente consulta e opera o painel pelo mesmo caminho da tela: cria um projeto, define variáveis, faz deploy,
lê logs. Quem decide **quanto poder** ele tem é você, na hora de criar o token.

> [!NOTE]
> O MCP já vem **desligado**. Enquanto estiver desligado, o endereço `/mcp` responde como se não existisse.
> Só o transporte HTTP está no painel. Cliente por terminal (stdio) e OpenAPI ficam para depois.

## 1. Ligar

1. Abra **Configurações → Acesso por IA**.
2. No cartão **Acesso por IA (MCP)**, informe a sua senha (e o código, se tiver verificação em duas etapas) e
   clique em **Ligar o acesso por IA**.
3. O endereço aparece na tela, no formato `https://painel.example.com/mcp`. Para desligar, o botão fica ao lado
   e não pede senha.

## 2. Criar o token

Na mesma tela, crie um token (veja [Acesso por IA](./ai-access.md)). Para o MCP, escolha:

- **Nível**: leitura (só consulta), escrita (consulta e opera projetos que já existem) ou administração
  (também cria projeto e cadastra domínio). O token **nunca** apaga nada pelo MCP, qualquer que seja o nível.
- **Alcance**: o painel inteiro ou só alguns projetos. Fora do alcance o projeto simplesmente não existe para o
  assistente (o mesmo 404 de um projeto que não existe).
- **Validade**: 1, 7, 15, 30 (padrão), 90, 180 ou 365 dias, ou **sem vencimento**. Sem vencimento pede a sua
  confirmação, porque um token que vazar vale para sempre até você revogá-lo.
- **Opções de IA**, todas desligadas por padrão (veja a seção 4).

O valor do token aparece uma única vez. Guarde-o.

## 3. Conectar um cliente

Qualquer cliente MCP com transporte HTTP serve. Exemplo para o Claude Code:

```bash
claude mcp add --transport http tws-panel https://painel.example.com/mcp \
  --header "Authorization: Bearer <seu-token>"
```

O token vai sempre no cabeçalho `Authorization`. Cookie de sessão não vale no `/mcp`, e token na URL é recusado.

## O que o assistente pode fazer

| Ferramenta | O que faz | Nível mínimo |
|---|---|---|
| `get_access_info` | diz o que este token alcança e quais opções tem ligadas | leitura |
| `list_projects`, `get_project`, `get_project_guardrails` | consulta projetos e as travas de segurança | leitura |
| `list_deploys`, `get_deploy`, `get_logs` | histórico de deploys e logs | leitura |
| `get_project_https`, `check_dns` | situação do HTTPS e do DNS | leitura |
| `list_env_names` | nomes das variáveis, sem valor | leitura |
| `get_env_value` | valor de uma variável (só com a opção "Ler segredos") | leitura |
| `get_approval` | situação de um pedido de aprovação | leitura |
| `read_panel_info` | informações do painel (só token de painel inteiro) | leitura |
| `create_project` | cria um projeto a partir de um repositório Git | administração |
| `update_project` | altera configurações do projeto | escrita |
| `set_env_vars` | define ou substitui variáveis; nunca apaga | escrita |
| `add_domain` | cadastra um domínio no projeto | administração |
| `deploy_project`, `restart_project` | publica e reinicia | escrita |
| `recreate_project` | recria os containers (sensível, pede aprovação) | escrita |
| `security_plan`, `get_security_job` | simula uma fase de segurança do servidor (SSH, firewall) e acompanha o trabalho | administração |
| `security_apply` | simulação por padrão; aplicar de verdade é uma opção | administração |

Não existe ferramenta que apague projeto, variável, domínio, backup ou token. Cada chamada passa pelas mesmas
rotas, validações, travas e limites de taxa da tela, e cai na **Auditoria** com o nome do token e o nome do cliente.

## 4. As opções de poder

Quem instala decide quanto poder a IA tem. Cada opção é do **token**, nasce desligada e só se liga com a sua
senha (desligar não pede senha e vale na hora). Ao ligar, a tela mostra o risco.

| Opção | Desligada (padrão) | Ligada |
|---|---|---|
| **Aplicar segurança** | `security_apply` só simula (dry-run). | Pode aplicar de verdade SSH e firewall. Um erro pode trancar você para fora do servidor. |
| **Ler segredos** | A IA define e troca valores, mas vê só os nomes; o valor vem mascarado. | `get_env_value` devolve o valor. Ele pode ficar no histórico da conversa da IA. |
| **Dispensar aprovação** | Recriar projeto e aplicar segurança esperam a sua aprovação na tela. | A IA faz sozinha, sem você ver antes. |
| **Métricas** | A IA não vê consumo. | `get_metrics_summary` e `get_project_metrics`; `get_host_metrics` (VPS inteira) só se o token tiver alcance de painel ou de monitoramento. |

## 5. Aprovar uma ação sensível

Quando a IA pede algo sensível e o token **não** dispensa a aprovação, a chamada volta com
`approval_required` e um número de pedido. Então:

1. O pedido aparece em **Configurações → Acesso por IA → Pedidos de aprovação**, com o que ela quer fazer.
2. Clique em **Aprovar**, informe a senha (e o código) e confirme. Ou **Recusar**.
3. A IA repete a mesma chamada com o número do pedido.

O pedido vale por 10 minutos, serve para **uma** execução, está preso àquele token e àqueles argumentos, e some
se o painel reiniciar. Um token não consegue aprovar nada, nem um de administração.

## Instalando agora (opcional)

Para que uma IA ajude a **instalar** o painel antes de existir uma conta, defina `PAAS_MCP_SETUP_LEVEL` com
`read`, `write` ou `admin` no ambiente do painel. O token de setup passa a valer no `/mcp` com esse nível,
sem aprovação humana. Depois de criar a conta, remova a variável e use um token normal.

## Limitações

- O endereço precisa chegar ao painel pelo Caddy, por HTTPS. As respostas são JSON simples; não há stream.
- Pedidos de aprovação e sessões MCP ficam na memória e somem ao reiniciar o painel.
- O painel guarda o nome do cliente enviado pelo próprio cliente; ele serve para a Auditoria, não para segurança.
