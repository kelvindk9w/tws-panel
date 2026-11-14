---
title: "Redis que reinicia sem parar (arquivo AOF corrompido)"
description: "Por que o redis ou o valkey de um projeto pode não subir depois de uma queda da VPS, como o painel mostra a causa, como reparar com um clique e como fazer o mesmo à mão."
sidebar:
  label: "Reparo do arquivo do redis"
---

Quando a VPS cai de repente (falta de energia, reinício forçado, falta de memória no servidor), o redis ou o
valkey pode estar no meio da gravação do seu arquivo de dados (o **AOF**, *append only file*). Ao voltar, o
fim desse arquivo fica pela metade e o redis se recusa a subir: o container entra num ciclo de reinício sem
fim e o projeto fica sem cache, sem fila ou sem sessão, conforme o uso.

No log do serviço aparece uma destas mensagens. No Redis 7.x, 8.0 e 8.2 e no Valkey:

```text
Bad file format reading the append only file appendonly.aof.27.incr.aof: make a backup of your AOF file,
then use ./redis-check-aof --fix <filename.manifest>
```

A partir do Redis 8.4, com a pasta, a posição e o tamanho do fim ilegível:

```text
Bad file format reading the append only file appendonlydir/appendonly.aof.27.incr.aof at offset 81920.
... set the 'aof-load-corrupt-tail-max-size' configuration option to 1397 ...
```

Ou, em todas as versões, quando o arquivo acaba no meio de um comando e `aof-load-truncated` está desligado:
`Unexpected end of file reading the append only file appendonly.aof.27.incr.aof. You can: ...`.

Só o Redis 8.4 em diante informa quantos bytes do fim estão corrompidos (o `1397` acima). As outras versões e
o Valkey só dizem que o arquivo está com defeito e pedem para rodar `redis-check-aof --fix` (ou
`valkey-check-aof --fix`).

## O que o painel mostra

O painel lê o log recente dos containers que estão reiniciando sem parar e reconhece essa mensagem. Quando
encontra:

- **Dashboard**: o item de atenção do projeto diz qual serviço não sobe, qual arquivo ficou corrompido e
  leva ao reparo, em vez de só "pode estar fora do ar";
- **Alertas** (menu): o alerta "reinicia sem parar" ganha a causa;
- **Aba Recursos do projeto**: um cartão com a explicação, os bytes que serão descartados e o botão
  **Reparar arquivo do redis**.

O painel **nunca repara sozinho**. Cortar o fim do arquivo apaga dados (poucos, mas apaga) e a decisão é sua.

## O reparo pelo painel

1. Abra a aba **Recursos** do projeto.
2. Se o redis não informou os bytes (antes do Redis 8.4, e no Valkey), clique em **Medir quanto será descartado**. A
   ferramenta do próprio redis confere o arquivo e diz o número; nada é alterado.
3. Clique em **Reparar arquivo do redis**. O diálogo diz o que vai acontecer:
   - o serviço é parado durante o reparo;
   - a pasta inteira do AOF (`appendonlydir`, ou a que o `--appenddirname` do container definir) é copiada
     para `appendonlydir.bak-<data-hora>`, no mesmo volume;
   - os **N bytes do fim** do arquivo são descartados, do último comando inteiro até o fim. Depois de uma queda
     costuma ser só o que estava sendo gravado; se o defeito estiver no meio do arquivo, o corte é maior.
     Confira o número antes de confirmar;
   - o serviço é iniciado de novo. Se o projeto estiver **parado por você** (botão Parar), o serviço fica
     parado: o reparo é feito e você inicia o projeto quando quiser.
4. Marque **Entendi** e confirme.

O resultado aparece no cartão, com a saída da ferramenta. Fica registrado na **Auditoria**.

### Garantias

- **Nunca corta mais do que você confirmou.** Logo antes de cortar, o painel mede de novo. Se a ferramenta
  cortaria mais bytes do que o número que você viu, nada é alterado e o diálogo mostra o número novo para você
  decidir de novo.
- **A cópia vem antes.** Se a cópia falhar, nada é cortado e o serviço volta ao estado de antes.
- **Se o corte falhar**, o serviço volta ao estado de antes e a cópia fica no volume.
- O reparo usa a **própria imagem do serviço** (que já traz o `redis-check-aof` ou o `valkey-check-aof`) num
  container auxiliar temporário: sem rede, sem privilégios extras, com limite de memória, CPU e tempo, e que
  monta só o volume da pasta de dados. Ele é removido ao terminar.
- Só o container daquele projeto é reparado; as pastas vêm da configuração real do container (`--dir` do
  redis ou a pasta de trabalho da imagem, e `--appenddirname` ou o padrão `appendonlydir`), nunca de algo
  digitado nem do log.
- Um reparo por vez em cada projeto. Durante o reparo, deploy, **Parar**, **Iniciar** e **Remover** do projeto
  esperam (o painel responde que há um reparo em andamento), e a parada não conta como queda nas métricas.

### Quando o painel não repara

O painel recusa (e não altera nada) quando:

- a imagem não tem a ferramenta de conferência (`redis-check-aof`/`valkey-check-aof`) ou o `sh`;
- a pasta de dados não está num volume, ou o volume está montado só para leitura;
- o serviço tem mais de um container (réplicas);
- o AOF é do formato antigo de arquivo único (Redis 6 ou anterior), sem a pasta `appendonlydir` e o manifesto;
- o log recente do serviço não mostra mais o erro (o redis já subiu, por exemplo);
- a pasta do AOF foi trocada num arquivo de configuração do redis (`redis.conf`), e não nos argumentos do
  container: o painel não acha o manifesto e para sem alterar nada.

Nesses casos, faça o reparo à mão, como abaixo.

## O reparo à mão

Pelo SSH da VPS. Troque `paas-loja-redis-1` pelo nome do container do serviço (aparece na aba Recursos) e
`/data` pela pasta de dados do redis, se for outra.

```bash
# 1. pare o serviço
docker stop paas-loja-redis-1

# 2. descubra a imagem do container (a ferramenta vem nela)
IMG=$(docker inspect -f '{{.Image}}' paas-loja-redis-1)

# 3. copie a pasta e veja quanto seria cortado (sem --fix nada é alterado)
docker run --rm --network none --volumes-from paas-loja-redis-1 -w /data --entrypoint sh "$IMG" -c \
  'cp -a appendonlydir "appendonlydir.bak-$(date -u +%Y%m%d-%H%M%S)" && redis-check-aof appendonlydir/appendonly.aof.manifest'

# 4. se estiver de acordo com o "diff=" mostrado, corte o fim
docker run --rm --network none --volumes-from paas-loja-redis-1 -w /data --entrypoint sh "$IMG" -c \
  'echo y | redis-check-aof --fix appendonlydir/appendonly.aof.manifest'

# 5. inicie de novo
docker start paas-loja-redis-1
```

No Valkey, troque `redis-check-aof` por `valkey-check-aof`. Se o seu redis usa outro nome de arquivo
(`appendfilename`) ou de pasta (`appenddirname`), ajuste os caminhos.

Quando tudo estiver funcionando há alguns dias, você pode apagar a pasta `appendonlydir.bak-...` do volume.

## Para não acontecer de novo

O redis grava o AOF no disco uma vez por segundo (`appendfsync everysec`, o padrão): numa queda brusca,
perder o último segundo é esperado. O que evita a queda brusca é a VPS ter memória de sobra (o painel avisa
quando a memória fica no limite) e não ser desligada à força. A partir do Redis 8.4 também existe a opção
`aof-load-corrupt-tail-max-size`, que faz o redis descartar sozinho um fim corrompido até o tamanho que você
definir; o painel não liga essa opção por você.
