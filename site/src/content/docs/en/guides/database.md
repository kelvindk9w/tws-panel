---
title: "Project Database tab"
description: "How to view the project's database, empty tables, reset the database, run Laravel commands and use the SQL console, by unlocking editing once (password and 2FA) and with an optional backup first."
sidebar:
  label: "Database tab"
---

The **Database** tab on the project page shows the database the project uses and lets you work on it without leaving the
panel. It is fully supported for **PostgreSQL**, **MySQL** and **MariaDB**. For MongoDB, Redis and SQLite the tab shows a
notice that support is not available yet.

## What the tab shows

- Engine, version, database name and total size.
- A table list with the **approximate** row count and size of each table (estimates from the database itself).
- A **Refresh** button. Looking does not ask for a password or an unlock: reading uses the normal session and never shows the database
  password.

If the database is stopped or Docker is down, the tab explains why instead of showing an empty screen.

## Unlock database editing

Viewing the database and running read-only queries uses the normal session. **Changing data** (emptying tables, resetting the
database, framework commands and write SQL) first requires **unlocking database editing**, once:

1. click **Unlock editing** on the Database tab;
2. enter your panel **password** and the **authenticator app code** (two-step verification is mandatory), plus the email code
   if you turned it on in Settings;
3. choose whether to **"Take a full project backup when unlocking"**. It is checked for normal projects and unchecked for
   projects marked **"This is a development project"** (project settings, general section).

If the backup fails, finishes with a warning, takes over 30 minutes or, with the restore test enabled, fails validation,
editing is **not unlocked** and nothing is changed. It is the same "Back up now" as on the Backups tab; there is no
table-only backup.

Once unlocked, the tab shows **"Editing unlocked, expires in mm:ss"** and a **Lock now** button. When the time runs out the
screen goes back to locked by itself. Within that window you **do not type your password or code again**:

- **SQL console**: write SQL runs straight away, with no prompt at all.
- **Empty tables**: a simple confirm button (with the backup choice, since it is a large, rare action).
- **Reset the database**: asks for the **project name typed in** (it wipes everything) and the backup choice.
- **Laravel commands**: a simple confirm; `migrate:fresh --seed` counts as a reset and asks for the project name.

The unlock is valid **only for your session and only for that project**, and lives **only in the panel's memory**: logging
out, the session expiring or restarting the panel ends it, and other projects or other sessions stay locked. The duration
(15 min, 30 min, 1 h, 2 h, 4 h or "until I log out") and the **Renew on use** option (each command extends the unlock to the
full duration again) are in **Settings, Database**; the default is 30 minutes, renewing. Lengthening the window or turning
renewal on asks for your password and code; shortening only needs the session. Shortening also cuts unlocks already in progress.

API tokens and MCP **cannot** reach this tab or create unlocks: only a logged-in person. The audit log records "editing
unlocked" (who, project and duration), "unlock ended" (timeout, button or end of session) and every write command (who, which
action, which tables), never the SQL, values or credentials.

### Empty tables

Pick one or more tables. On PostgreSQL the panel uses `TRUNCATE ... RESTART IDENTITY`; the **CASCADE** option, which also
empties tables that depend on the chosen ones, is unchecked and comes with a warning. On MySQL/MariaDB foreign keys are
switched off only for the duration of the command. **On MySQL/MariaDB emptying is not atomic**: `TRUNCATE` commits by
itself, so if it fails midway the earlier tables are already empty.

### Reset the database

Deletes the **tables and common objects** (views, sequences, types, functions, routines and events) but **keeps the
database, the users and the grants**. It also **does not remove**: extensions and schemas; on PostgreSQL, large objects,
operators, collations, text search configurations, publications and foreign servers; on MySQL/MariaDB, users and grants. On
MySQL/MariaDB the action is **not atomic** (each `DROP` commits by itself): if it fails midway, part of the objects are
already gone. On PostgreSQL the panel drops the objects one by one in a single command and preserves extensions and schema
grants; it does not use `DROP SCHEMA public CASCADE`, which would take those with it. After a reset, rebuild the structure
with the app's migrations or restore a backup.

### Restore a backup

The tab links to the **Backups** tab, where the existing restore flow lives.

### Framework command

On **Laravel** projects (detected by `laravel/framework` in `composer.json` and the `artisan` file) three fixed commands
appear: `migrate:fresh --seed`, `migrate --force` and `db:seed --force`. They run inside the app container and the output is
shown on screen with a **Copy** button. Other commands cannot be typed. If more than one container has `artisan` (for example
the app and a worker), the screen asks where to run it; the nginx container, which has no `artisan`, is never used.

### SQL console

- **Several statements per run** (up to 50), separated by `;`. The panel splits the text the way the database would read it:
  a `;` inside a quoted string, comment, backticks or a `$$ ... $$` body (PostgreSQL) does not split, and the last statement
  may omit the `;`. Each statement shows its own result; if one fails, the run **stops there** and the screen tells you the
  **number** of the statement that failed.
- **Read only** (every statement is `SELECT`, `SHOW`, `EXPLAIN`...): runs with the normal session, in a **single read-only
  transaction enforced by the database**, with a 15-second timeout, at most 500 rows per statement and 2 MB in total, and at
  most 2 queries at a time. No need to unlock editing.
- **Any write statement** in the text: requires **editing unlocked**. Without it the screen shows "Unlock database editing to
  run commands that change data" with the button. On PostgreSQL the **Run everything in one transaction** checkbox (checked by
  default) wraps everything in `BEGIN`/`COMMIT`: if a statement fails nothing is saved. Without it, the statements before the
  failing one are already saved. **MySQL/MariaDB has no transaction here**: structure commands (`CREATE`, `ALTER`, `DROP`)
  commit by themselves and cannot be rolled back, so the statements before the failing one stay applied.
- A read-only transaction does not block functions that act outside the tables when the database user is an administrator
  (reading server files, ending connections, `SLEEP`, `INTO OUTFILE`...). The panel therefore treats those queries as
  **writes**: they require unlocked editing instead of running directly.
- On MySQL/MariaDB the read query runs with an empty `sql_mode`, each statement sent to the server already closed into a
  single statement (`PREPARE`), without passing through the client's splitter. In practice: `||` means OR (use `CONCAT()`),
  `"text"` is a string and not a column name, and queries with `?` placeholders do not work.
- For actions, the database itself also gets time limits (15 s lock wait and an execution limit), so a command does not keep
  running if the panel gives up waiting. If it still goes over, the screen warns that it **may still be running**: check
  before repeating. When the time limit is hit, the panel also cancels the query on the server (through the database, not
  just by closing the connection) and only says it was stopped if that worked. On MySQL, `UPDATE`, `DELETE` and DDL have no
  server-side time limit of their own: the panel's limit and this cancellation apply.
- Still **rejected**: client commands (`\` in psql, `source`, `system` and `DELIMITER` in mysql) and MySQL executable
  comments (`/*! ... */`). So **MySQL procedures that need `DELIMITER` do not run in the console**; on PostgreSQL, functions
  with a `$$ ... $$` body work. A few commands that MySQL's `PREPARE` rejects (such as `SHOW ERRORS`) also need the write flow.
