# Security policy

## Supported versions

Athena is pre-1.0 and released from `master`. Only the latest release receives
security fixes; there are no maintained backport branches.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately to **dev@markmartinez.ca**, or use GitHub's
[private vulnerability reporting](https://github.com/athenaeum-app/athena/security/advisories/new)
on this repository.

Useful things to include, as far as you have them:

- What the issue is and roughly how severe you think it is
- Steps to reproduce, or a proof of concept
- The version or commit you tested
- Whether the server was exposed to a network or running locally

You should get an acknowledgement within a few days. This is a
single-maintainer hobby project, so please be patient with fix timelines. I will
keep you updated and credit you in the release notes unless you would rather stay
anonymous.

## Scope

Athena is self-hosted: you run the server, and you own the deployment. Findings
in the application itself are in scope: authentication and session handling,
the permission model, invite redemption, asset upload and serving, SSRF in link
preview scraping, and SQL injection.

The following are out of scope:

- Anything requiring an attacker to already hold owner or administrator rights
- Findings that depend on a misconfigured deployment (a server put on the public
  internet without TLS, a reverse proxy that strips security headers, and so on)
- The demo seed data. `npm run demo` publishes its credentials in the README on
  purpose; a demo-seeded server is not meant to be network-exposed.
- Denial of service through sheer request volume
