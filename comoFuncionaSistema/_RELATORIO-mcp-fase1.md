# Relatório — MCP, Fase 1: projeto no ar

Base: `plano-mcp.md` (seções 5 e 10), Fase 0 e 0b. Detalhes técnicos em `mcp/`.

## O que passou a acontecer

1. **MCP desligado por padrão.** Em Configurações → Acesso por IA a pessoa liga (senha e 2FA) e desliga (sem
   senha). Desligado, `/mcp` responde 404.
2. **Um assistente conecta com um token** e vê só as ferramentas que o nível, o alcance e as opções do token
   permitem. Cria projeto (Git), cadastra domínio, define variáveis, publica, reinicia, recria, lê logs,
   HTTPS, DNS e (com opção) métricas. **Nada apaga.**
3. **Mesmas regras da tela.** Cada ferramenta chama a rota HTTP equivalente com o token do chamador: nível,
   alcance (404 fora dele), validação, travas e limites de taxa valem iguais.
4. **Quatro opções por token**, todas desligadas: aplicar segurança de verdade, ler valores de variáveis,
   dispensar a aprovação humana, consultar métricas. Ligar pede senha e 2FA; desligar não pede.
5. **Aprovação humana**: recriar projeto e aplicar segurança de verdade voltam `approval_required`; a pessoa
   aprova na tela com senha e 2FA; a IA repete a chamada. Uso único, 10 minutos, preso ao token e aos argumentos.
6. **Validade do token**: 1, 7, 15, 30, 90, 180, 365 dias ou sem vencimento (confirmação explícita).
7. **Auditoria** de cada chamada com token e nome do cliente.

## Decisões e por quê

- Opções por token e liga/desliga por instalação: o cadastro já tem criação e ampliação com senha, e
  tokens diferentes merecem confianças diferentes.
- Sem o SDK oficial: pularia os hooks do Fastify, pesa 4,5 MB e exigiria reescrever os esquemas.
- Aprovações em memória: ao reiniciar o painel o pedido some e a IA pede de novo (mais seguro que persistir).

## Falta validar com Docker e VPS reais

Caddy repassando `/mcp`; cliente real; deploy, reiniciar e recriar de verdade; aplicar segurança de verdade;
métricas reais; a tela no navegador; fluxo de 2FA ao vivo.
