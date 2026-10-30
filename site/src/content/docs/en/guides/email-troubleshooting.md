---
title: "My app's email did not arrive"
description: "How to find out why a project's email did not arrive: refused attempts, the Why nothing arrived card, the connection test and the Laravel cases (queue without a worker, MAIL_MAILER=log, LOG_CHANNEL)."
sidebar:
  label: "Email did not arrive"
---

When the app says it sent an email and it never shows up, the panel shows what the mail server saw. Open the
project, **Sends** tab (and **Email** for the connection test). For all projects at once use **Email → Sends →
Outgoing**.

## 1. Check the app's last attempt

On the project's **Sends** tab, **Last connection attempt from the app** shows when the app last talked to the
mail server and whether it was accepted or refused. **Never seen** means the mail server logged no attempt at
all: the app is not reaching it (wrong variables, email turned off, project not restarted).

## 2. Refused attempts

The **Refused attempts** section lists what the server refused **before** accepting a message: wrong password,
a temporary ban for too many attempts, TLS failure, sender not allowed, sending limit. Each row shows the time,
the reason and the login used. It appears on the project only when the login is the project's mailbox. TLS
refusals carry no login and appear only on the global page.

| Reason | What to do |
| --- | --- |
| Username or password refused | Check `MAIL_USERNAME` and `MAIL_PASSWORD` (or link them to the panel's email, below). After changing the mailbox password, restart the project. |
| TLS connection did not complete | The app does not trust the mail server certificate, or uses an old TLS version. Use host `mail.<your domain>` on port 587 with STARTTLS. |
| Sender not allowed | The `MAIL_FROM_ADDRESS` address does not belong to the project's mailbox. Use the mailbox address. |
| Not authenticated | The app tried to send without a username and password. |

## 3. Why nothing arrived?

With no sends in the last 24 hours, the **Sends** tab shows the **Why nothing arrived?** card with whatever
applies to the project:

- the project's email is off, or the mailbox has no password;
- the **test inbox** is on: the messages are there, they were not delivered;
- email was turned on or changed but the project was **not redeployed**;
- `MAIL_MAILER` is `log` or `array`: Laravel only writes the email to a file or discards it;
- `MAIL_HOST`, `MAIL_USERNAME` or `MAIL_PASSWORD` are not linked to the panel's SMTP (in **Email → Link
  variables**, link them to `SMTP_HOST`, `SMTP_USER` and `SMTP_PASS`);
- the **queue without a worker** (item 5);
- the server refused recent attempts (item 2).

## 4. Test the connection from the app

On the project's **Email** tab, **Test connection from the app** follows the same path as the app: it connects
to `mail.<your domain>:587`, runs STARTTLS with **certificate verification** and logs in with the project's
mailbox. It sends no message and never shows the password. It stops at the first failing step and explains why.
The test runs in the panel itself, which sits on the same Docker network as the projects; a network rule that
exists only inside the app's container is not covered.

## 5. Laravel: queue without a worker

If `QUEUE_CONNECTION` is not `sync` (for example `database` or `redis`; the Laravel 11 default is `database`)
and no process runs `queue:work`, `queue:listen` or `horizon`, the panel warns **Queue without a worker:
queued e-mails and jobs will not be processed**. The emails sit in the jobs table forever. Two fixes:

1. Set `QUEUE_CONNECTION=sync` in the project Variables (sends during the request: simplest, slower for the
   user).
2. Add a worker service to `docker-compose.yml`:

```yaml
services:
  worker:
    build: .
    command: php artisan queue:work --sleep=3 --tries=3 --max-time=3600
    restart: unless-stopped
    depends_on:
      - app
```

Use the same image and variables as the app service. Containers get the project variables on the next
deploy.

## 6. Laravel: `LOG_CHANNEL=stderr`

By default Laravel writes errors to `storage/logs/laravel.log` inside the container, and the project's **Logs**
tab cannot see them. Set `LOG_CHANNEL=stderr` in the Variables and exceptions show up in the Logs tab. This is
only a suggestion, not an error.

## Server logs

If the problem looks like the mail server or the proxy, see [Server logs](server-logs.md).
