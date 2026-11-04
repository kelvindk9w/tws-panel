---
title: "Logs do servidor"
description: "A página Logs do servidor: o que mostra (painel, proxy, e-mail, Docker e SSH da VPS), controles, máscara de segredos e quem pode abrir."
sidebar:
  label: "Logs do servidor"
---

A página **Logs do servidor** (menu) mostra o que o próprio servidor escreve, sem entrar na VPS por SSH. É só
leitura.

## Fontes

Uma lista fechada; não dá para pedir outro container:

- **Painel** (`tws-panel`);
- **Proxy** (`paas-caddy`): acessos, certificados e erros de HTTPS;
- **Servidor de e-mail** (`paas-stalwart`): entregas, logins e recusas;
- **Docker da VPS** e **SSH da VPS**: lidos do journal do sistema. Só existem no painel instalado na VPS.

Sem escolher fonte, a página junta o painel, o proxy e o e-mail. Os logs de cada projeto ficam na aba
**Logs** do próprio projeto.

## Controles

Os mesmos da aba Logs do projeto: número de linhas (100 a 2000), período (15 minutos, 1 hora, 24 horas),
busca no texto, copiar e atualizar. A página **não atualiza sozinha** por padrão, porque cada leitura é
registrada na Auditoria; a atualização automática é opcional.

## Segredos

O painel esconde, em melhor esforço, as senhas das caixas de e-mail, a senha de administração do servidor de
e-mail, as variáveis dos projetos e padrões comuns (Bearer, senha em URL, cookies, tokens). Um segredo que um
programa escreve de forma incomum pode passar: não cole os logs em lugares públicos sem ler.

O log do **SSH** mostra os endereços IP de quem tentou entrar. É útil para o dono da VPS e é por isso que esta
página é só para você, logado no painel.

## Quem pode abrir

Só uma pessoa logada. **Nenhum token de API** acessa esta página, nem com permissão de administrador. Há
limite de 30 consultas por minuto e cada consulta fica na Auditoria (quem, fonte, tamanho; nunca o conteúdo).
Detalhes de como o journal é lido: [Host bridge](../reference/host-bridge.md).
