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

The service log shows one of these messages. On Redis 7.x, 8.0 and 8.2 and on Valkey:

```text
Bad file format reading the append only file appendonly.aof.27.incr.aof: make a backup of your AOF file,
then use ./redis-check-aof --fix <filename.manifest>
```

From Redis 8.4 on, with the folder, the position and the size of the unreadable end:

```text
Bad file format reading the append only file appendonlydir/appendonly.aof.27.incr.aof at offset 81920.
... set the 'aof-load-corrupt-tail-max-size' configuration option to 1397 ...
```

Or, on every version, when the file ends in the middle of a command and `aof-load-truncated` is off:
`Unexpected end of file reading the append only file appendonly.aof.27.incr.aof. You can: ...`.

Only Redis 8.4 and later say how many bytes at the end are corrupted (the `1397` above). Older versions and
Valkey only say the file is damaged and ask you to run `redis-check-aof --fix` (or `valkey-check-aof --fix`).

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
2. If redis did not report the bytes (before Redis 8.4, and on Valkey), click **Measure how much will be discarded**. Redis's
   own tool checks the file and reports the number; nothing is changed.
3. Click **Repair redis file**. The dialog says what will happen:
   - the service is stopped during the repair;
   - the whole AOF folder (`appendonlydir`, or the one the container's `--appenddirname` sets) is copied to
     `appendonlydir.bak-<date-time>`, in the same volume;
   - the **last N bytes** of the file are discarded, from the last complete command to the end. After a crash
     it is usually just what was being written; if the defect is in the middle of the file, the cut is bigger.
     Check the number before confirming;
   - the service is started again. If **you stopped the project** (Stop button), the service stays stopped:
     the repair is done and you start the project whenever you want.
4. Tick **I understand** and confirm.

The result shows up on the card, with the tool's output. It is recorded in the **Audit** log.

### Guarantees

- **It never cuts more than you confirmed.** Right before cutting, the panel measures again. If the tool
  would cut more bytes than the number you saw, nothing is changed and the dialog shows the new number so you
  can decide again.
- **The copy comes first.** If the copy fails, nothing is cut and the service goes back to how it was.
- **If the cut fails**, the service goes back to how it was and the copy stays in the volume.
- The repair uses the **service's own image** (which already ships `redis-check-aof` or `valkey-check-aof`)
  in a temporary helper container: no network, no extra privileges, with memory, CPU and time limits, and
  mounting only the data folder's volume. It is removed when it finishes.
- Only that project's container is repaired; the folders come from the container's real configuration
  (redis `--dir` or the image's working directory, and `--appenddirname` or the default `appendonlydir`),
  never from typed text nor from the log.
- One repair at a time per project. During the repair, deploy, **Stop**, **Start** and **Remove** of the
  project are refused until the repair finishes (the panel answers that a repair is in progress), and the stop
  does not count as a crash in the metrics. The other way around too: while the project is being stopped,
  started or removed, the panel refuses to measure and repair; try again when it finishes.

### When the panel does not repair

The panel refuses (and changes nothing) when:

- the image does not have the check tool (`redis-check-aof`/`valkey-check-aof`) or `sh`;
- the data folder is not on a volume, or the volume is mounted read-only;
- the service has more than one container (replicas);
- the AOF uses the old single-file format (Redis 6 or older), without the `appendonlydir` folder and manifest;
- the service's recent log no longer shows the error (redis already started, for example);
- the AOF folder was changed in a redis configuration file (`redis.conf`), not in the container's arguments:
  the panel does not find the manifest and stops without changing anything.

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
warns when memory is at its limit) and not being powered off by force. From Redis 8.4 on there is also the
`aof-load-corrupt-tail-max-size` option, which makes redis discard a corrupted end on its own up to the size
you set; the panel does not turn it on for you.
