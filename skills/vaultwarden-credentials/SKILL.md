---
name: vaultwarden-credentials
description: >-
  Use this skill whenever you need to securely access, retrieve, or execute with credentials, API tokens,
  or passwords stored in the user's self-hosted Vaultwarden instance (https://vault.driftmango.org).
  Standardizes on Bitwarden Agent Access (aac) with zero-exposure runtime environment injection.
---

# ⣮⣵ Vaultwarden Credential Management via Agent Access (aac)

The user stores all secrets in their self-hosted Vaultwarden instance (`https://vault.driftmango.org`).
AI agents must prioritize using the **Bitwarden Agent Access CLI (`aac`)** with **runtime environment injection (`aac run`)** to prevent plaintext secrets from entering the LLM context, prompt history, or transcript logs.

---

## ⠪⡕ Core Directive: Zero Plaintext Context Exposure

1. **NEVER print or return plaintext secrets in tool outputs, chat responses, or commit messages.**
2. **Execute commands via `aac run` whenever possible** so secrets are injected directly into child process memory spaces without touching stdout or disk logs.
3. The local network hosts an end-to-end encrypted relay at `ws://192.168.8.177:8089` (or `ws://127.0.0.1:8089`).

---

## ⠕⣀ Primary Pattern: Runtime Process Injection (`aac run`)

Wrap the target command using `aac run`. Secrets are injected as environment variables into the spawned subprocess only:

```bash
# Push or pull Git repositories with Gitea authentication (injected as env var):
aac run --domain 192.168.8.177 --env GITEA_PAT=password -- git push origin main

# Execute API requests without printing tokens to stdout:
aac run --domain msg.driftmango.org --env RC_TOKEN=password -- bash -c 'curl -s -H "X-Auth-Token: $RC_TOKEN" http://192.168.8.177:3100/api/v1/me'

# Pass secrets to database or deploy commands:
aac run --domain postgres.local --env PGPASSWORD=password -- psql -h 192.168.8.177 -U dbuser
```

*Fields available for mapping via `--env VAR=field`:* `username`, `password`, `totp`, `uri`, `notes`, `domain`, `credential_id`.

---

## ⠪⢕ Single-Shot Retrieval (`aac connect`)

When direct command injection is impossible and a structured payload is required by tool code:

```bash
# Retrieve scoped credential as a single JSON object:
aac connect --domain 192.168.8.177 --output json

# Specify local relay if outside default network configuration:
aac connect --proxy-url ws://192.168.8.177:8089 --domain 192.168.8.177 --output json
```

*Output format:*
```json
{
  "success": true,
  "domain": "192.168.8.177",
  "credential": {
    "username": "camkerr81",
    "password": "...",
    "totp": null,
    "uri": "http://192.168.8.177:3000",
    "notes": null
  }
}
```

*Security Guard:* Pipe directly into consumer tools (e.g. `jq`) in subshells. Never echo the output to conversation logs.

---

## ⢾⢷ Interactive Approval Flow

When an agent executes an `aac` request:
1. The request is routed across the Noise protocol encrypted tunnel to the host Provider daemon.
2. The user receives a dual notification:
   - **Desktop (`⣫⣝`):** Interactive D-Bus notification with `[ Approve ]` / `[ Deny ]` buttons.
   - **Mobile (`⢏⡹`):** Rocket.Chat direct message to `@camkerr81` with action buttons (`Approve Once`, `Approve 15m`, `Deny`).
3. Once approved, the credential is leased immediately. If approved for 15 minutes, subsequent requests for that domain complete instantly without prompting.

---

## ⠤ Legacy Desktop Fallback (`bw` CLI)

If running in a local interactive desktop shell where `aac` is not configured, the Bitwarden CLI (`bw`) may be used as a fallback:

```bash
# Prompt master password via secure GUI popup if locked:
export BW_SESSION=$(bw unlock "$(zenity --password --title='Unlock Vaultwarden')" --raw)

# Retrieve password in background:
bw get password "<item_name>"
```
