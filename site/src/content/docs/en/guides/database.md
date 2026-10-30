---
title: "Project Database tab"
description: "How to view the project's database, empty tables, reset the database, run Laravel commands and use the SQL console, with password, 2FA and a backup before any action that deletes data."
sidebar:
  label: "Database tab"
---

The **Database** tab on the project page shows the database the project uses and lets you work on it without leaving the
panel. It is fully supported for **PostgreSQL**, **MySQL** and **MariaDB**. For MongoDB, Redis and SQLite the tab shows a
notice that support is not available yet.

## What the tab shows

- Engine, version, database name and total size.
- A table list with the **approximate** row count and size of each table (estimates from the database itself).
- A **Refresh** button. Looking does not ask for a password: reading uses the normal session and never shows the database
  password.

If the database is stopped or Docker is down, the tab explains why instead of showing an empty screen.

## Actions that change data

Emptying tables, resetting the database, running a framework command and running write SQL always require:

1. your panel **password** and the **authenticator app code** (two-step verification is mandatory), plus the email code if
   you turned it on in Settings;
2. **typing the project name** to confirm;
3. choosing the **backup**: "Full database backup first" (default) or "Do not back up". For projects marked **"This is a
   development project"** (project settings, general section) the default is no backup.

The backup is the same "Back up now" as on the Backups tab. If it fails, finishes with a warning, takes over 30 minutes or,
with the restore test enabled, fails validation, the action **does not run** and nothing is changed. If the restore test is
off (or did not run for that backup), the action proceeds and the screen shows "validation not run". There is no table-only
backup.

API tokens and MCP **cannot** reach this tab: these actions only work with a logged-in person. Every action is recorded in
the audit log (who, which action, which tables), never with the SQL, values or credentials.

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

- **Read** (`SELECT`, `SHOW`, `EXPLAIN`...): runs with the normal session, in a **read-only transaction enforced by the
  database** against data changes, with a 15-second timeout, at most 500 rows and at most 2 queries at a time.
- **Write** (anything else): a destructive action, needs password, 2FA, project name and backup choice.
- A read-only transaction does not block functions that act outside the tables when the database user is an administrator
  (reading server files, ending connections, `SLEEP`, `INTO OUTFILE`...). The panel therefore treats those queries as
  **writes**: they ask for password and 2FA instead of running directly.
- On MySQL/MariaDB the read query runs with an empty `sql_mode` (so the server cannot interpret the text differently). In
  practice: `||` means OR (use `CONCAT()`), `"text"` is a string and not a column name, and queries with `?` placeholders do
  not work.
- For actions, the database itself also gets time limits (15 s lock wait and an execution limit), so a command does not keep
  running if the panel gives up waiting. If it still goes over, the screen warns that it **may still be running**: check
  before repeating. When the time limit is hit, the panel also cancels the query on the server (through the database, not
  just by closing the connection) and only says it was stopped if that worked. On MySQL, `UPDATE`, `DELETE` and DDL have no
  server-side time limit of their own: the panel's limit and this cancellation apply.
- **One statement at a time.** The panel rejects texts with several commands, client commands (`\` in psql, `source` in
  mysql) and MySQL executable comments. That way the read-only protection cannot be switched off by a hidden `COMMIT`. On
  MySQL/MariaDB the text is sent to the server already closed into a single statement (`PREPARE`), without passing through
  the client's splitter.
- Because it is a single statement, **creating functions or procedures whose body contains a semicolon does not work in the
  console**. Use a migration file or restore a backup. A few commands that MySQL's `PREPARE` rejects (such as
  `SHOW ERRORS`) also need the write flow.
