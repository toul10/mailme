# Security policy

MailMe reads people's mail, so security reports are welcome and taken seriously.

## Reporting a vulnerability

**Please don't open a public issue, discussion or pull request for a security problem.**

Report it privately through GitHub's
[private vulnerability reporting](https://github.com/toul10/mailme/security/advisories/new) (the repository's
**Security** tab → **Report a vulnerability**). Only you and the maintainers can see the report.

Please include:

- what an attacker can do, and what they need first (an account, a mailbox, network access);
- the steps to reproduce it, or a proof of concept;
- the commit you tested, and how MailMe was running (Docker, Node.js, Google Cloud).

Please leave out real mail and real credentials, and test only against an installation of your own.

You'll get a reply as soon as possible. When a fix is out, the advisory is published and credits you, unless you'd
rather not be named.

## Supported versions

Only the latest commit on `main` gets security fixes; there are no release branches. To update, see
[Upgrading](docs/INSTALL.md#upgrading).

## In scope

For example:

- signing in without the password or the two-step code, or taking over another account;
- reading or changing another user's or another organization's data;
- the chat ("Ask your mail") showing a user mail or tasks that are not theirs, or mail it is documented never to
  read (docs/INSTALL.md § Ask your mail);
- the API process opening a mailbox password (only the worker holds the key that can);
- forging, replaying or reusing a one-click report link;
- making the server connect to private or internal addresses through the mail server settings (SSRF);
- prompt injection that gets past the reconciler: an incoming e-mail that gets a change applied that the authority
  rules should have blocked, such as a customer's e-mail closing your task;
- mail content (subjects, bodies, addresses) reaching the logs or the alerts.

## Out of scope

- Anything that first needs control of the server, its `.env`, `data/keys` or the database.
- The command-line tool (`pnpm cli`). It is an operator tool with full access by design, and it is not limited to
  public mail servers.
- The demo (`pnpm run demo`). It skips two-step sign-in and listens on localhost only, by design.
- Setups that go against [docs/INSTALL.md](docs/INSTALL.md), such as plain HTTP on a public address.
- Denial of service through sheer volume, and missing hardening headers without a concrete attack.

## Running MailMe safely

- Serve it over HTTPS only. The Docker setup does this for you.
- Keep `.env` and `data/keys` readable by the owner only, and back them up apart from the database dumps: a dump
  together with the private key exposes every mailbox password.
- Update regularly ([Upgrading](docs/INSTALL.md#upgrading)).

The security model is described in [docs/architecture.md](docs/architecture.md#security-model).
