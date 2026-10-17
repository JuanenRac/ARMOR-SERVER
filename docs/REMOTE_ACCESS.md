# Using the server from outside the house

The server can be reached from the Internet only through ONE door: a reverse proxy with a valid TLS certificate (the `tls` profile of ARMOR-DEVOPS). The broker and the nodes are never published. What the server adds for that case:

| Setting | Meaning | Default |
|---|---|---|
| `ARMOR_TRUST_PROXY` | Which proxies in front of the server may say who the client is (a number of hops, addresses, subnets or `uniquelocal`). Without it every request looks like the proxy's own and everything counts as local | off |
| `ARMOR_LOCAL_NETWORKS` | Address ranges that count as the house | the private ranges and the loopback |
| `ARMOR_VPN_NETWORKS` | Ranges of the VPN, which count as the house too | none |
| `ARMOR_TOTP_REQUIRED` | `off`: the second factor is asked of who turned it on; `remote`: also required from outside (a person without it must set it up from inside first); `always` | `off` |
| `ARMOR_REMOTE_SESSION_TTL_MS` / `ARMOR_REMOTE_IDLE_MS` | Life of a session that came from outside, and how long it may sit unused | 12 h / 30 min |
| `ARMOR_ELEVATION_MS` | How long a new proof of identity lets critical actions through | 5 min |
| `ARMOR_REMOTE_POLICY` | `full`, `operate` (no administering from outside) or `view` (only looking) | `full` |

## What a session from outside gets

* **Its origin is recorded** (local or remote, the address, the browser) and shown in `GET /api/v1/studio/sessions`, where the person ends the ones they do not know (`DELETE /api/v1/studio/sessions/:id`, `POST /api/v1/studio/sessions/end-others`). Changing the password or the second factor ends the others.
* **It is shorter and idle-limited** (see the table).
* **Critical actions need a new proof** (`POST /api/v1/studio/elevate` with the password, or a code when the second factor is on): managing users and PINs, starting a firmware update. Inside the house nothing more is asked.
* **The policy** can close administering (or everything but looking) to remote sessions: the answer is `403 { code: "remote_policy", needs: "vpn" }`.

## The second factor

`POST /api/v1/studio/totp/setup` (with the password) answers the secret and an `otpauth://` address for a QR; `POST /api/v1/studio/totp/enable` with the first code turns it on and answers ten recovery codes, shown once. The next sign-in answers `200 { totp_required, challenge }` and no cookie; `POST /api/v1/studio/session/totp` with the challenge and a code (or a recovery code, once) gives the session. A code is accepted once (no replay in its thirty seconds); five wrong ones make the next tries wait. The secret is kept encrypted, the recovery codes only as hashes. An administrator can turn it off for somebody who lost both (`DELETE /api/v1/users/:id/totp`).

## Checking the set-up

`GET /api/v1/remote/check` (administrator) says what the server sees of the request: the address, local or remote, the protocol, whether the cookie is Secure, the proxy setting and the policy. Open it from a phone on mobile data before relying on any of this.
