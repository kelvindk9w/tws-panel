---
title: TWS Panel
description: Painel open source que transforma uma VPS Ubuntu na sua própria plataforma de hospedagem.
template: splash
hero:
  tagline: Transforme uma VPS Ubuntu na sua própria plataforma de hospedagem. Proteja a máquina, publique projetos com HTTPS e cuide do e-mail profissional, em um painel que você controla.
  actions:
    - text: Guia passo a passo
      link: /tws-panel/pt-br/getting-started/installation/
      icon: right-arrow
    - text: Restaurar numa VPS nova
      link: /tws-panel/pt-br/guides/restore-new-server/
      icon: right-arrow
      variant: secondary
    - text: Código no GitHub
      link: https://github.com/kelvindk9w/tws-panel
      icon: external
      variant: minimal
---

## Por onde começar

| Sua situação | Vá para |
|---|---|
| **Primeira instalação.** Você nunca instalou, ou quer cada passo explicado, da VPS contratada ao painel configurado e a uma restauração testada. | **[Guia passo a passo](getting-started/installation.md)**<br>A Parte 1 instala o painel; a Parte 2 o configura. |
| **Reinstalei a VPS, ou estou mudando de servidor.** Você quer o painel, os projetos e o e-mail de volta a partir dos backups externos. | **[Restaurar numa VPS nova](guides/restore-new-server.md)** |
| **Já sei o que estou fazendo.** Você tem uma VPS Ubuntu limpa e um usuário com `sudo`. | **[Instalação rápida, 1 comando](https://github.com/kelvindk9w/tws-panel/blob/main/README.pt-BR.md#instalação)** (no README do repositório) |

**Problemas na hora de conectar por SSH?** O aviso "REMOTE HOST IDENTIFICATION HAS CHANGED!" é
esperado depois de reinstalar a VPS. Veja [o que fazer](getting-started/installation.md#host-identification-changed).

## O que ele faz

- **Deploy:** repositórios git, HTML puro, projetos com build, `Dockerfile` e `docker-compose`, com vários domínios por projeto e HTTPS automático.
- **Segurança primeiro:** wizard de hardening com simulação e rollback automático, guardrails de deploy, monitoramento contínuo e login com verificação em duas etapas (TOTP).
- **E-mail:** servidor de e-mail próprio (Stalwart) com checklist de DNS verificável, caixas, variáveis SMTP por projeto e webmail.
- **Backups:** backups agendados em `.7z` do painel, do e-mail e dos projetos, copiados na VPS e no Cloudflare R2 ou em outro S3, com criptografia opcional.

## Por onde seguir

- [Funcionalidades](guides/features.md): o que cada módulo faz.
- [Como preparar seu projeto](guides/prepare-project.md): o que o repositório precisa ter, receitas prontas e um checklist antes do primeiro deploy.
- [Acesso por IA (tokens de API)](guides/ai-access.md): deixe um programa ou assistente de IA usar o painel sem a sua senha.
- [Modelo de segurança](reference/security.md): o que o painel protege e o que ele exige.
- [Solução de problemas](guides/troubleshooting.md): porta 25 bloqueada, e-mail em spam, certificado que não sai.
- [Ajuda e feedback](guides/help.md): dúvidas, bugs, sugestões e como falar com a gente.

## O que você precisa

Uma VPS limpa com Ubuntu 22.04 ou 24.04 LTS (no mínimo 1 vCPU, 2 GB de RAM e 25 GB de disco) e as
portas 80 e 443 abertas. O Docker, o Node e o resto são instalados pelo instalador.

A interface do painel está disponível em português e em inglês. Ela começa no primeiro idioma do seu
navegador que o painel tem (inglês, se nenhum combinar) e você pode trocar no seletor **Idioma** (PT/EN), sempre visível no cabeçalho do painel, ao lado do menu do usuário (na disposição lateral, no rodapé da lateral, acima do menu do usuário, com o nome completo do idioma), nas telas de
login e do assistente e em **Configurações → Aparência**. Algumas mensagens que vêm do servidor
(resultados das verificações de saúde e de segurança, mensagens do deploy e da checagem de DNS,
alertas, detalhes da auditoria e muitas mensagens de erro) ainda aparecem em português; os guias
avisam quando citam uma. Veja [Traduzir a interface](development/translating-the-interface.md) e o
[roadmap](https://github.com/kelvindk9w/tws-panel/blob/main/ROADMAP.md).
