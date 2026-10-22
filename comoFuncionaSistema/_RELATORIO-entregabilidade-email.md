# Relatório — entregabilidade do e-mail: DNS orientado, verificação ao vivo e diagnóstico de atraso (22/10/2026)

Este repositório é público: nada aqui tem IP real, domínio de cliente ou segredo. `203.0.113.10` e
`exemplo.com.br` são valores de exemplo.

Pedido: uma mensagem enviada pelo app de um projeto demorou alguns minutos para chegar ao Gmail. O painel
deve orientar e verificar o que for possível para **aumentar as chances** de entrega e de caixa de entrada.
Não existe garantia de caixa de entrada e a interface não a promete.

## 1. Auditoria: o que já existia e o que faltava

| Exigência (Gmail / Yahoo / Microsoft) | Antes | Agora |
|---|---|---|
| SPF alinhado, `ip4:` do servidor | Checklist com comparação exata do texto | Avaliado como um receptor: IP autorizado, `all` final, vários registros, `ptr`, **limite de 10 consultas DNS** |
| DKIM RSA 2048 | Gerado e publicado no checklist; comparação do texto | Confere que a chave publicada é a do servidor e lê o **tamanho do módulo** (2048 ok, 1024 atenção, menos crítico) |
| DMARC com política e `rua` | Checklist progressivo none, quarantine, reject | Presença, política válida, `rua`, vários registros, **herança do domínio acima** (atenção) |
| PTR coerente com o HELO | Já existia (verde, azul, amarelo) | Entra na nota de saúde |
| IP fora de DNSBL | Card diário na aba Reputação (DQS opcional) | Entra na nota; "não consultável" não vira "limpo" |
| TLS válido no host de e-mail | Página de certificados | Entra na nota: validade e dias restantes, servidor parado |
| Porta 25 de saída | **Não havia** | Sonda (conecta num MX público de teste e espera o 220); bloqueio de provedor é tratado como caso comum |
| Registros A/MX coerentes | Compara texto | Detecta A atrás do proxy do Cloudflare, MX para outro servidor, MX com A errado |
| A do nome do HELO | Só o PTR | Confere o A do nome do servidor quando é diferente de `mail.<domínio>` |
| Propagação | Uma consulta | Compara SPF, DKIM e DMARC em 1.1.1.1, 8.8.8.8 e 9.9.9.9 (propagando = atenção) |
| MTA-STS e TLS-RPT (bônus) | Só no ROADMAP | Registros opcionais no plano, conferência e leitura da política (nunca pesam na nota) |
| Atraso na fila | A página Envios mostrava o texto cru | Causa classificada em português (greylisting, limite de taxa, IP bloqueado, caixa cheia, TLS, DNS, conexão) |
| Teste de entrega | Já existia (limite 30 s e 20 por hora) | **Teto de 60 por dia**; passo a passo do "Mostrar original" no Gmail |
| Autoconfig e autodiscover | Não existe | **Não implementado** (o Stalwart não os serve atrás do Caddy; ver seção 5) |
| `List-Unsubscribe` | Responsabilidade do app | Só documentado: vale para envio em massa, não para transacional |

Configuração do Stalwart v0.11.8 (`packages/mailer/src/server.ts`), conferida:
HELO = `server.hostname` (certo, o PTR deve casar); DKIM RSA 2048 com seletor `paas` e assinatura
automática `rsa-<domínio>`; `Message-ID` e `Date` completados na submissão; saída só por IPv4 (o SPF
só tem `ip4:`); STARTTLS exigido na saída (padrão `require`); fila com retentativas em 2, 5, 10, 15, 30
min, 1 h e 2 h e expiração em 5 dias (é a agenda PADRÃO do Stalwart, não uma configuração do painel; o painel não a altera). **Nenhuma dessas chaves precisou mudar**: nenhuma mudança de
configuração provou ganho.

## 2. Causas prováveis do atraso de alguns minutos no Gmail

Em ordem de probabilidade:

1. **Limite de taxa por IP e domínio novos (a mais provável).** O Gmail aceita a conexão mas responde
   `421 4.7.28` ou `4.7.0` ("rate limited / unusual rate"). O Stalwart guarda na fila e tenta de novo; a
   **primeira nova tentativa é em 2 minutos**, o que bate com "alguns minutos". É reputação em formação:
   some em semanas, com volume baixo e crescente e quase nenhuma reclamação.
2. **Greylisting** em destinos que não são o Gmail (451 4.7.1): primeira tentativa recusada de propósito.
3. **Falha de autenticação** (SPF, DKIM, alinhamento): o Gmail adia com `4.7.26`, `4.7.27`, `4.7.30` ou
   `4.7.32`. **Isto NÃO é limite de taxa** e esperar não resolve; o painel classifica como autenticação,
   marca crítico já na 1ª tentativa e manda conferir SPF/DKIM e o domínio do remetente. Também entram aqui
   DKIM ausente (ver achado abaixo), SPF sem o IP, DMARC ausente e PTR genérico.
4. **Porta 25 de saída bloqueada**: aí nada sai, nem com atraso.
5. TLS e DNS do destino: raros.

O painel agora **diagnostica sozinho** os itens 1 a 5: o item "Fila de envio" da saúde lê a fila do
Stalwart e mostra, em português, a causa mais comum, o número de tentativas e em quantos minutos é a
próxima.

### Achado importante (Docker real, v0.11.8): DKIM só vale depois de reiniciar

O teste de integração mostrou que o Stalwart **não assina com a chave DKIM criada pela API, nem depois de
`GET /api/reload`; só depois de reiniciar**. Sem isso a mensagem sai sem `DKIM-Signature`. Em produção, o
reinício só acontecia quando o certificado do domínio novo era instalado (depois de o registro A existir).
Correção: cadastrar o domínio **e adotá-lo pela Sincronização** (quando a chave DKIM é criada naquele momento)
**reinicia o Stalwart**, numa fila única de reinícios (cadastros simultâneos, sincronização do TLS e reparo
da senha não reiniciam em cima um do outro; quem espera entra no mesmo reinício).

**Correção de uma afirmação anterior deste relatório:** a versão anterior dizia que domínios cadastrados antes
"já passaram por reinício e não são afetados". Isso não se sustenta: um domínio cadastrado antes pode ter
a chave criada DEPOIS do último reinício do servidor (o reinício só acontecia quando o certificado do domínio
era instalado, e só se o registro A já existisse). Para esses não há como o painel saber, só pela API, se o
servidor carregou a chave. A mensagem de teste (cabeçalho DKIM-Signature em "Mostrar original") e o item DKIM
da saúde são a conferência; reiniciar o servidor de e-mail resolve.

Se o reinício falha, o domínio fica marcado com **reinício pendente** (resposta da API, `mail.json`, aviso da
tela de Sincronizar e item DKIM da saúde em **atenção**, nunca "ok"); a sincronização do TLS (de hora em
hora e ao abrir a página E-mail) tenta de novo.

## 3. O que mudou, pelo comportamento

- **Card "Saúde do envio de e-mail"** no topo do checklist de DNS (página do domínio e aba DNS do e-mail
  do projeto). Estado geral em ok, atenção ou crítico, um item por requisito, esperado contra encontrado
  e o que fazer. Botão "Verificar a saúde agora" (6 por minuto, 15 s por domínio). Aviso vermelho quando
  algo que afeta direto a caixa de entrada está pendente; aviso de propagação do DNS.
- **Passo a passo do DNS**: registros em ordem, cada um com nome e valor copiáveis, uma frase de
  finalidade, obrigatório, recomendado ou opcional. Explica a nuvem **cinza** do Cloudflare (nunca
  "proxied"), o MX em dois campos e que o **PTR é no painel do provedor da VPS**, não no DNS do domínio.
- **Verificação diária** de todos os domínios (o estado fica em memória).
- **Teste de entrega**: depois de "entregue", um passo a passo do Gmail ("Mostrar original", SPF, DKIM e
  DMARC = PASS). O painel não lê a caixa. Teto de 60 testes por dia (além de 1 a cada 30 s e 20 por hora);
  o destino é sempre digitado por quem está autenticado.
- **Cadastrar domínio** (e adotar, na Sincronização, um domínio cuja chave DKIM é criada na hora) reinicia o Stalwart; por alguns segundos SMTP e IMAP caem e a fila fica guardada. Se o reinício falha, o painel diz "reinício pendente" em vez de DKIM ok.

## 4. Segurança

- Nenhum alvo de rede vem de quem chama a API: domínio cadastrado, resolvedores públicos fixos e dois MX de
  teste fixos.
- Todo endereço resolvido passa por `isPrivateAddress` (loopback, redes privadas, link-local e metadados,
  CGNAT, multicast, IPv6 e IPv4 mapeado) antes de qualquer conexão; a política MTA-STS não segue
  redirecionamento, confere o certificado, lê no máximo 16 KB e tem prazo.
- A chave privada DKIM nunca sai do Stalwart; só a pública aparece.
- Schema nas duas rotas, limite de uso, auditoria no POST.

## 5. O que não foi feito (propostas)

- **Autoconfig e autodiscover**: exigiria o Caddy servir `autoconfig.<domínio>` e `autodiscover.<domínio>`
  com XML por caixa. Fica como proposta.
- **Publicar o arquivo da política MTA-STS**: o painel só confere e entrega o texto para copiar; servi-lo
  exige um bloco novo no Caddy e certificado para `mta-sts.<domínio>`.
- **Aquecimento guiado com limite por provedor de destino** e **limite por projeto** (desenho completo em
  `email/_PESQUISA-entregabilidade.md`, prioridade 2).
- **Alerta de mudança de estado** (virou crítico) pelo sistema de notificações: exige uma fonte nova de
  alerta; hoje a página mostra o estado e a rotina diária o atualiza.
- **Criação automática dos registros no Cloudflare (só plano, não implementado).** Token de API com
  escopo mínimo (`Zone:DNS:Edit` só na zona do domínio), guardado cifrado como os outros segredos. O painel
  listaria o que existe, mostraria o diff e só criaria com confirmação, sempre com `proxied: false`.
  Riscos: o token dá poder de apagar e alterar DNS da zona (por isso escopo mínimo e uma zona só); um
  erro no registro de MX pode desviar o e-mail do domínio (o aviso de e-mail existente do domínio
  continuaria valendo); o token é mais um segredo no backup. Não entra antes de uma revisão de segurança.
- Teste de entrega com cabeçalhos assinados e TLS usado lidos do lado do servidor: depende do registro do
  Stalwart (lote do histórico de envios).

## 6. Como testei

- `packages/mailer/tests/deliverability-health.test.ts`: plano, SPF (contagem de consultas, CIDR, ciclos, qualificadores, redirect, termos depois de all, include sem SPF, macros),
  DKIM (chave fraca, curta, revogada, de outro tipo), DMARC (herança), MX/A, PTR, porta 25, TLS, listas,
  propagação, MTA-STS contra um servidor HTTPS local, banner SMTP contra um servidor local, destinos
  privados e a classificação do atraso. Resolvedores falsos, sem rede.
- `apps/server/tests/mail-health.test.ts`: serviço (intervalo, cache da sonda, falha parcial) e rotas
  (schema, 400, 404, 429, auditoria, limite do botão). `mail-add-domain-dkim.test.ts`: o reinício.
  `mail-test-email.test.ts`: teto diário.
- `apps/web/tests/delivery-health-card.test.tsx`: estados, aviso de caixa de entrada, erro, passo a
  passo, e que todo código do servidor tem texto nos dois idiomas; o texto nunca promete caixa de entrada.
- **Integração real**: `packages/mailer/tests/stalwart-deliverability.integration.test.ts`, só com
  `STALWART_INTEGRATION=1`. Stalwart v0.11.8 em rede Docker `--internal`, com um proxy de TCP e um receptor
  SMTP falso. Cobre: chave DKIM de 2048 bits lida pelo verificador, `Message-ID` e `Date` completados, a
  mensagem de saída **assinada** (`d=`, `s=paas`, `rsa-sha256`, cabeçalhos assinados), o **controle** (domínio
  com chave criada sem reiniciar sai SEM assinatura; depois do reinício, assinado) e um **adiamento real**: um
  destino falso responde `451 4.7.26` ao destinatário, o Stalwart guarda a mensagem adiada e o painel lê o
  texto que o próprio Stalwart gravou na fila e classifica como autenticação. Os contêineres, redes e volumes criados são removidos no fim; as imagens já existiam.

## 7. Só dá para validar na VPS

- Que o Gmail passa a entregar sem atraso (depende de reputação, semanas).
- A sonda da porta 25 contra a internet de verdade e a leitura do `421 4.7.28` real na fila.
- O reinício único ao cadastrar um domínio com o painel em container (testado com dublês; o reinício
  real do Stalwart foi exercitado no teste em Docker).
