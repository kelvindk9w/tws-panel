---
title: "Ajuda e feedback"
description: "Onde tirar uma dúvida, relatar um bug, sugerir algo ou falar com a gente, e o que informar sem expor dados privados."
sidebar:
  label: "Ajuda e feedback"
---

Travou, achou um bug ou teve uma ideia? Escolha o canal certo e siga o roteiro curto abaixo.
Você pode escrever em português (Brasil) ou em inglês.

<a id="onde-pedir-ajuda"></a>

## Para onde ir

| Você quer | Vá para |
|---|---|
| **Tirar uma dúvida** (como fazer algo, por que algo se comporta de um jeito) | [Discussions](https://github.com/kelvindk9w/tws-panel/discussions) |
| **Relatar um bug** (algo não funciona como os guias dizem) | [Relato de bug](https://github.com/kelvindk9w/tws-panel/issues/new?template=bug_report.yml) |
| **Sugerir algo** | [Pedido de funcionalidade](https://github.com/kelvindk9w/tws-panel/issues/new?template=feature_request.yml), ou [Discussions](https://github.com/kelvindk9w/tws-panel/discussions) se ainda for uma ideia para conversar |
| **Relatar um problema de segurança** | Em privado, por um [relato de segurança](https://github.com/kelvindk9w/tws-panel/security/advisories/new). Leia antes o [SECURITY.md](https://github.com/kelvindk9w/tws-panel/blob/main/SECURITY.md). **Não abra uma issue pública.** |
| **Falar com a gente sem conta no GitHub** | Escreva para [contato@tws.tec.br](mailto:contato@tws.tec.br) |

Antes de escrever, veja o [guia de solução de problemas](troubleshooting.md) e procure nas issues
e nas discussões que já existem: alguém pode já ter a resposta.

<a id="relatar-um-bug"></a>

## O que informar num relato de bug

O formulário de bug pede estes itens. Ter tudo à mão evita uma rodada de perguntas.

1. **Versão do painel.** Na VPS, rode `git -C /opt/tws-panel rev-parse --short HEAD`. Ele mostra o
   código curto do commit. Se você chegou ao formulário pelo menu de ajuda do painel, este campo
   pode já vir preenchido: confira.
2. **Sistema operacional da VPS.** Por exemplo "Ubuntu 24.04", mais a versão do Docker
   (`docker --version`). Para ver o sistema: `cat /etc/os-release`.
3. **Idioma da interface.** Português (Brasil) ou inglês.
4. **Passos para reproduzir.** O que você clicou ou rodou, em ordem, e o que esperava que
   acontecesse no lugar do que aconteceu.
5. **Evidências,** como uma captura de tela ou um trecho de log, depois de tirar os dados privados
   (próxima seção).

<a id="anonimizar"></a>

## Não cole logs sem revisar

Logs, capturas de tela e saídas de comandos podem conter **domínios, endereços IP, e-mails e
tokens**. Uma issue ou uma discussão é pública: qualquer pessoa pode ler. Antes de colar qualquer coisa:

- Troque os seus domínios por `example.com` (e os subdomínios por `app.example.com`, `mail.example.com`).
- Troque os endereços IP por `203.0.113.10` (um endereço reservado para documentação).
- Troque os e-mails por `usuario@example.com`.
- Troque tokens, senhas e chaves por `REDACTED`.
- Recorte as capturas de tela para não mostrar domínios, IPs, nomes de projetos nem o setup token na barra de endereço.

Para mascarar os endereços IP de um log automaticamente, rode isto na VPS e **leia o resultado**
antes de copiar (o comando não conhece os seus domínios nem os seus tokens):

```bash
sudo docker logs --tail 100 tws-panel 2>&1 \
  | sed -E 's/[0-9]{1,3}(\.[0-9]{1,3}){3}/203.0.113.10/g'
```

> [!WARNING]
> **Nunca cole, em lugar público:** o setup token, senhas, códigos de verificação em duas etapas ou
> de recuperação, o kit de recuperação, a senha do backup, as chaves de acesso do armazenamento,
> chaves SSH privadas ou o conteúdo de arquivos `.env`. Se algum deles vazou, trate-o como
> comprometido e troque-o.

<a id="contato"></a>

## Contato direto

Sem conta no GitHub, ou o assunto não serve para uma página pública? Escreva para
[contato@tws.tec.br](mailto:contato@tws.tec.br). Vale a mesma regra: nada de tokens, senhas ou logs
sem revisar na mensagem. Para uma vulnerabilidade de segurança, prefira o relato privado acima.
