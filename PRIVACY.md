# Phone Remote Privacy Policy

Last updated: 20 November 2026

Phone Remote lets you control your own Android phone from a web dashboard or
from an AI agent (such as Claude) through its MCP server. This policy covers the
hosted service at `https://65-1-96-152.sslip.io`, the Phone Remote Android app,
and the Phone Remote plugin for Claude. The full source code is public under the
MIT license at https://github.com/GuptaOum/phone-remote, so you can check
everything described here.

## What we store

The service keeps only what it needs to sign you in and connect your phones:

- **Account:** your email address, a hashed password (never the password
  itself) and the date the account was created.
- **Devices:** for each phone you link, its name, model, a device id and when it
  was last online.
- **AI agent connections:** when an agent such as Claude connects through
  OAuth, the client's id, name and redirect address.

## What passes through but is not stored

When you or an AI agent you authorised uses the service, these travel between
your phone and the agent or dashboard through the server, over encrypted
connections (HTTPS and secure WebSockets):

- screen contents (the on-screen text tree), screenshots and live screen video
- taps, typing and other commands
- notifications, including one-time codes
- the list of installed apps and their storage use
- file lists and the files you transfer
- the phone's location

The server does not write any of these to a database or disk. The phone's last
known location is cached in server memory so it can be shown to you, and is
lost when the server restarts. A file you download from the phone is held in
server memory for at most 10 minutes behind a one-time link and then discarded;
upload links also expire after 10 minutes. Standard web-server logs (time,
address, requested path) are kept for operating and securing the service.

## How data is used

Only to provide the service: signing you in, linking your phones, and carrying
commands and results between your phone and the dashboard or agent you
authorised. Only phones linked to your own account can be reached. We do not
sell data, show ads, or use your data to train models.

## AI agents

When you connect an AI agent, the data that agent requests (for example screen
text or a notification) is sent to that agent and handled under its provider's
privacy policy, for Claude the Anthropic privacy policy. You choose which
agents to connect and can revoke access by removing the device or signing out.

## Where data is hosted

On Amazon Web Services in the ap-south-1 (Mumbai) region.

## Your choices

- Remove a phone from your account at any time in the dashboard; it can then no
  longer be reached.
- Turn off the app's Accessibility, Notification access or Usage access
  permissions on the phone at any time; the related features stop working.
- To delete your account and its stored data, open an issue at
  https://github.com/GuptaOum/phone-remote/issues asking for deletion (do not
  post your password); we will confirm and delete it.

## Children

Phone Remote is not intended for people under 18.

## Changes

Changes to this policy are published in this file; the history is visible in
the repository.

## Contact

Questions: https://github.com/GuptaOum/phone-remote/issues
