# Security

AI in 5 holds subscribers' email addresses and the credentials of the Manyfold agents that write it, so we take reports seriously.

## Reporting a vulnerability

Please email **customer-support@netmind.ai** with "AI in 5 security" in the subject, or use GitHub's private vulnerability reporting on this repository. Do not open a public issue for anything that could put subscribers' data or the agents at risk.

Tell us what you found, how to reproduce it, and what an attacker could do with it. We will acknowledge your report within three working days and keep you updated until it is fixed.

## Scope

In scope: the site at https://app.manyfold.ai/ai-news, its API under `/ai-news/api/`, its emails, and this code.

Please don't:
- access, change or delete other people's data, or subscribe addresses that are not yours;
- run tests that send email to others, make billed agent calls in volume, or degrade the service;
- use automated scanners against production without asking first.

## What the code promises

The invariants that keep credentials and personal data safe are listed in [AGENTS.md](AGENTS.md) (rules 4, 6, 7, 11 and 12). A change that weakens one of them is a security bug.
