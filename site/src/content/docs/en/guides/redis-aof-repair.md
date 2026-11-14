---
title: "Redis restarting forever (corrupted AOF file)"
description: "Why a project's redis or valkey may not start after the VPS goes down, how the panel shows the cause, how to repair it with one click and how to do the same by hand."
sidebar:
  label: "Redis file repair"
---

When the VPS goes down abruptly (power loss, forced reboot, the server running out of memory), redis or
valkey may be in the middle of writing its data file (the **AOF**, *append only file*). When it comes back,
the end of that file is half-written and redis refuses to start: the container enters an endless restart
loop and the project loses its cache, queue or sessions, depending on what it uses redis for.

The service log shows something like:

```text
Bad file format reading the append only file appendonly.aof.27.incr.aof at offset 81920.
... set 'aof-load-corrupt-tail-max-size' configuration option to 1397 ...
```

Redis 8 says how many bytes at the end are corrupted (the `1397` above). Redis 7 and Valkey only say the
format is wrong and ask you to run `redis-check-aof --fix` (or `valkey-check-aof --fix`).

## What the panel shows

The panel reads the recent log of containers that keep restarting and recognizes this message. When it finds
it:

- **Dashboard**: the project's attention item says which service does not start, which file is corrupted
  and links to the repair, instead of only "may be down";
- **Alerts** (menu): the "keeps restarting" alert includes the cause;
- **Project Resources tab**: a card with the explanation, the bytes that will be discarded and the
  **Repair redis file** button.

The panel **never repairs on its own**. Cutting the end of the file deletes data (little, but it does) and
the decision is yours.

## Repairing from the panel

1. Open the project's **Resources** tab.
2. If redis did not report the bytes (Redis 7, Valkey), click **Measure how much will be discarded**. Redis's
   own tool checks the file and reports the number; nothing is changed.
3. Click **Repair redis file**. The dialog says what will happen:
   - the service is stopped during the repair;
   - the whole folder (`appendonlydir`) is copied to `appendonlydir.bak-<date-time>`, in the same volume;
   - the **last N bytes** of the file are discarded: the last fraction of a second of writes before the
     crash;
   - the service is started again.
4. Tick **I understand** and confirm.

The result shows up on the card, with the tool's output. It is recorded in the **Audit** log.

### Guarantees

- **It never cuts more than you confirmed.** Right before cutting, the panel measures again. If the tool
  would cut more bytes than the number you saw, nothing is changed and the dialog shows the new number so you
  can decide again.
- **The copy comes first.** If the copy fails, nothing is cut and the service starts again as it was.
- **If the cut fails**, the service is started again and the copy stays in the volume.
- The repair uses the **service's own image** (which already ships `redis-check-aof` or `valkey-check-aof`)
  in a temporary helper container: no network, no extra privileges, with memory, CPU and time limits, and
  mounting only the data folder's volume. It is removed when it finishes.
- Only that project's container is repaired; the folder comes from the container's real configuration
  (redis `--dir` or the image's working directory), never from typed text.
- One repair at a time per project; during the repair the project is locked for deploys and the stop does
  not count as a crash in the metrics.

### When the panel does not repair

The panel refuses (and changes nothing) when:

- the image does not have the check tool (`redis-check-aof`/`valkey-check-aof`) or `sh`;
- the data folder is not on a volume, or the volume is mounted read-only;
- the service has more than one container (replicas);
- the AOF uses the old single-file format (Redis 6 or older), without the `appendonlydir` folder and manifest;
- the service's recent log no longer shows the error (redis already started, for example).

In these cases, repair it by hand, as below.

## Repairing by hand

Over SSH on the VPS. Replace `paas-loja-redis-1` with the service's container name (shown in the Resources
tab) and `/data` with redis's data folder, if different.

```bash
# 1. stop the service
docker stop paas-loja-redis-1

# 2. find the container's image (the tool ships with it)
IMG=$(docker inspect -f '{{.Image}}' paas-loja-redis-1)

# 3. copy the folder and see how much would be cut (without --fix nothing changes)
docker run --rm --network none --volumes-from paas-loja-redis-1 -w /data --entrypoint sh "$IMG" -c \
  'cp -a appendonlydir "appendonlydir.bak-$(date -u +%Y%m%d-%H%M%S)" && redis-check-aof appendonlydir/appendonly.aof.manifest'

# 4. if you agree with the "diff=" shown, cut the end
docker run --rm --network none --volumes-from paas-loja-redis-1 -w /data --entrypoint sh "$IMG" -c \
  'echo y | redis-check-aof --fix appendonlydir/appendonly.aof.manifest'

# 5. start it again
docker start paas-loja-redis-1
```

On Valkey, replace `redis-check-aof` with `valkey-check-aof`. If your redis uses another file name
(`appendfilename`) or folder (`appenddirname`), adjust the paths.

Once everything has been working for a few days, you can delete the `appendonlydir.bak-...` folder from the
volume.

## Keeping it from happening again

Redis writes the AOF to disk once per second (`appendfsync everysec`, the default): in an abrupt crash,
losing the last second is expected. What prevents the abrupt crash is the VPS having spare memory (the panel
warns when memory is at its limit) and not being powered off by force. Redis 8 also has the
`aof-load-corrupt-tail-max-size` option, which makes redis discard a corrupted end on its own up to the size
you set; the panel does not turn it on for you.
