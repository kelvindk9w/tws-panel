# Relatório — Domínio do painel (07/10/2026, branch `feat/dominio-painel`)

Item 3 da ordem combinada com o dono do produto em 01/10/2026: Configurações →
Domínio do painel. Comportamento e API em `configuracoes/dominio-do-painel.json`.

## O que mudou (pelo comportamento)

- **Seção nova em Configurações: "Domínio do painel"** (`/settings/panel-domain`).
  - Mostra por onde o painel abre agora. O endereço automático aparece marcado "pelo IP" e a página atual, "esta página".
  - A pessoa informa um domínio seu (ex.: `painel.exemplo.com.br`). A tela mostra o registro a criar: tipo A, o nome e o IP da VPS, cada um com botão de copiar. Pede a nuvem cinza no Cloudflare e a remoção de um AAAA, se houver.
  - **Verificar DNS** consulta o DNS público (1.1.1.1 e 8.8.8.8), como o e-mail faz; o DNS do sistema só entra quando o público não responde. A resposta vem em frase simples: ainda não aponta, nuvem laranja, IP errado, AAAA para outro lugar ou não deu para conferir.
  - **Com o DNS certo**, o domínio entra no bloco do painel no proxy, e o painel passa a responder **nos dois endereços**. O certificado aparece no mesmo cartão da página Certificados, com "Tentar emitir agora" se falhar.
  - **Com o certificado válido**, aparece o botão "Abrir o painel pelo endereço novo", com o aviso de que será preciso entrar de novo, porque a sessão vale só no endereço em que a pessoa entrou.
  - **"Desativar o acesso pelo IP"** só fica liberado quando três coisas valem ao mesmo tempo:
    - a página está aberta pelo domínio novo, conferido pelo servidor (Host do pedido) e pelo navegador;
    - o certificado está válido;
    - a pessoa digita o domínio para confirmar.

    Antes de confirmar, a tela mostra o comando de SSH para voltar atrás. Depois de desativar, o endereço `…sslip.io` não responde mais pelo painel.
  - **"Reativar o acesso pelo IP"** fica na mesma tela.
  - **Trocar e remover o domínio:** os dois religam o acesso pelo IP antes de tirar o domínio. O painel nunca fica sem endereço.
  - **Modo túnel:** a tela explica que não há endereço público e mostra o comando para mudar o acesso para HTTPS. Não há formulário nesse modo.
- **Volta por SSH:** `cd /opt/tws-panel && sudo ./scripts/reativar-acesso-ip.sh`.
  - O script para o painel e religa o acesso pelo IP no arquivo de configuração. O domínio continua cadastrado.
  - Depois sobe o painel, que remonta o proxy no boot.
  - Por fim, espera até 90 s até o Caddyfile do proxy voltar a ter o endereço pelo IP e avisa onde olhar se não voltar.
- **Onde fica gravado:** `/data/panel-domain.json`, no volume Docker `paas_data` (`<dataDir>/panel-domain.json`).
  - O painel lê o arquivo no boot, antes de montar o proxy, então reiniciar o painel mantém a escolha.
  - Reiniciar só o Caddy também mantém: o Caddyfile fica dentro do container e o painel o regrava a cada mudança.
  - O `PAAS_PANEL_DOMAIN` do `.env` não muda nunca. Ele continua sendo a fonte do IP da VPS (registro A, checklist do e-mail e endereço automático dos projetos).
- **Página Certificados:** lista os dois endereços do painel enquanto os dois estiverem ativos.
- **Projetos:** não podem usar nenhum endereço do painel, nem o domínio já cadastrado que ainda espera o DNS.
- **Roteiro de primeiros passos (passo 3):** deixou de ser "em breve".
  - **A fazer:** só existe o endereço pelo IP.
  - **Em andamento:** falta o DNS, falta o certificado ou o painel ainda foi aberto pelo IP. O detalhe diz o que falta.
  - **Feito:** o painel abre pelo domínio novo com certificado válido. Se o acesso pelo IP ainda estiver ativo, o detalhe avisa "acesso pelo IP ainda ativo".
  - No modo túnel, o passo conta como feito.
  - O "Como fazer" tem o passo a passo real e o botão "Abrir Domínio do painel".
- **`scripts/show-token.sh`:** com o acesso pelo IP desativado, mostra o link pelo domínio, que é o que abre.
- **Auditoria:** `panel_domain.set` (cadastrar ou trocar), `panel_domain.activated`, `panel_domain.ip_disabled`, `panel_domain.ip_enabled` e `panel_domain.removed`. O script de SSH não passa pela auditoria, porque age com o painel parado.

## Decisões

1. **O domínio só entra no proxy depois do DNS certo.** Assim a primeira tentativa de emissão do certificado sai na hora, sem a espera crescente de tentativas que falharam antes. Por isso a verificação não chama "Tentar emitir agora" sozinha; o botão fica no cartão.
2. **Passo 3 "feito" com o IP ainda ativo, mas com aviso.** Desativar o IP é a última camada e é opcional. Quem prefere manter o endereço de reserva não fica com o cartão aberto no Dashboard para sempre.
3. **Modo túnel: função desabilitada, com explicação.** Sem endereço público não há IP exposto em nenhum nome, e usar um domínio exigiria publicar o painel nas portas 80 e 443. Por isso a tela mostra o comando para mudar o acesso para HTTPS: `sudo ./scripts/install.sh --acesso=https`.
4. **Desativar exige o Host do pedido igual ao domínio, e o navegador confere de novo.** Só entra quem prova que o endereço novo abre, então ninguém se tranca fora.
5. **Trocar o domínio religa o IP** até o novo ficar pronto. É a forma simples de garantir que sempre há um endereço que funciona.
6. **Proteções por origem continuam como estavam:**
   - o WebSocket do terminal compara o Origin com o Host do próprio pedido, então cada endereço só aceita a si mesmo;
   - o cookie não tem `Domain`;
   - o CORS aceita só a mesma origem;
   - não há CSRF por token (SameSite=Lax + JSON).

   Nada disso precisou mudar para aceitar os dois endereços.
7. **O rótulo do 2FA no app autenticador** (`admin@<endereço>`) continua o da instalação. É só um nome no celular, e mudar não ajudaria quem já cadastrou.

## Riscos e o que não foi validado

- **Não testado numa VPS real.** Faltam o ACME de verdade com o domínio próprio, a recarga do Caddy com dois nomes no mesmo bloco e o script de volta com Docker de verdade (nos testes ele roda com um `docker` falso).
- **`install.sh --acesso=https` numa instalação feita com túnel não foi testado.** O instalador diz que a opção substitui o valor do `.env`, mas a troca de modo numa VPS existente não foi exercitada aqui.
- **Os endereços automáticos dos projetos** (`<projeto>.<ip>.sslip.io`) continuam funcionando e continuam com o IP no nome. "Desativar o acesso pelo IP" vale só para o painel.
- **A página de "domínio não configurado" pode aparecer no endereço pelo IP.** Quem abrir `http://<ip>.sslip.io` depois de desativar vê essa página; em HTTPS, o navegador mostra erro de certificado. As duas reações são as esperadas.

## Como testei

- Suítes (`pnpm -r --workspace-concurrency=1 --no-bail run test:coverage`), todas passando com os mínimos:

| Pacote | Antes | Depois |
|---|---|---|
| core | 6 arquivos / 54 testes | 6 / 54 |
| web | 47 / 627 | 48 / 638 |
| deploy | 29 / 417 | 29 / 423 |
| mailer | 17 / 339 | 17 / 339 |
| security | 11 / 187 | 11 / 187 |
| server | 88 / 1219 | 91 / 1304 |

- Os testes que baixam `ubuntu:24.04` passaram nesta máquina, antes e depois.
- **Testes novos:**
  - serviço: validação do domínio, DNS com resolvedor simulado (falta de registro, Cloudflare, IP errado, AAAA, DNS do sistema de reserva, sem resposta), regras do botão, fluxo completo, persistência, arquivo inválido e falha do proxy desfazendo a mudança;
  - rotas: schema, Host, 401, 409, 500 sem detalhe interno e a ligação com o resto do painel;
  - Caddyfile com um e com dois endereços;
  - DeployService;
  - Certificados;
  - roteiro;
  - tela (estados, confirmação forte, botão travado fora do domínio novo, modo túnel);
  - script (`.mjs` e `.sh` com `docker` falso).
- `shellcheck` 0.10.0 sem avisos em `reativar-acesso-ip.sh` e `show-token.sh`.
- Navegador (Playwright, vite com a API simulada): conferido no computador e a 390 px, sem rolagem lateral. O botão "Abrir o painel pelo endereço novo" passava da caixa no celular e foi corrigido.

## Passo a passo na VPS

1. **Atualizar o painel:**
   `cd /opt/tws-panel && sudo git pull && sudo git log --oneline -1 && sudo docker compose up -d --build`
2. **Criar o registro no Cloudflare** (ou no seu provedor de DNS): DNS → Registros → Adicionar registro.
   - Tipo: **A**.
   - Nome: `painel` (para `painel.exemplo.com.br`).
   - Endereço IPv4: o IP da VPS.
   - Proxy: **nuvem cinza ("Somente DNS")**.
   - Salvar. Se existir um registro AAAA com o mesmo nome, apague.
3. **Cadastrar o domínio:** no painel (ainda pelo `…sslip.io`), abra **Configurações → Domínio do painel**, digite `painel.exemplo.com.br` e clique em **Salvar domínio**.
4. **Verificar o DNS:** clique em **Verificar DNS**. Se aparecer "ainda não aponta", espere alguns minutos e tente de novo.
   Com o DNS certo, a lista "Endereço do painel" passa a mostrar os dois endereços.
5. **Acompanhar o certificado:** espere ficar "Válido" (de segundos a 2 minutos). Use **Conferir de novo** para atualizar.
   Se falhar, a causa aparece no cartão, junto com o botão **Tentar emitir agora**.
6. **Abrir pelo endereço novo:** clique em **Abrir o painel pelo endereço novo** e entre de novo, com usuário, senha e código.
7. **Conferir:** no Dashboard, o passo 3 do roteiro aparece como feito, com o aviso "acesso pelo IP ainda ativo".
8. **Desativar o IP (opcional), ainda pelo endereço novo:** em **Configurações → Domínio do painel**, anote o comando de SSH mostrado na tela.
   Clique em **Desativar o acesso pelo IP**, digite o domínio e clique em **Desativar agora**.
9. **Conferir o resultado:**
   - `https://<ip-com-hífens>.sslip.io` não abre mais o painel;
   - `https://painel.exemplo.com.br` continua abrindo;
   - a Auditoria mostra `panel_domain.ip_disabled`.
10. **Voltar pela tela:** em **Configurações → Domínio do painel**, clique em **Reativar o acesso pelo IP**.
11. **Voltar por SSH**, se o domínio parar de abrir:
    `cd /opt/tws-panel && sudo ./scripts/reativar-acesso-ip.sh`
    Espere a mensagem "pronto", abra `https://<ip-com-hífens>.sslip.io` e entre de novo.
    Se aparecer erro, veja `sudo docker logs tws-panel --tail 50` e `sudo docker logs paas-caddy --tail 50`.
12. **Conferir que a escolha sobrevive a um reinício:**
    `sudo docker restart tws-panel` (ou `sudo docker restart paas-caddy`)
    Depois, abra o painel pelo mesmo endereço de antes.
    Para ver o arquivo:
    `sudo docker run --rm -v paas_data:/data alpine:3 cat /data/panel-domain.json`
