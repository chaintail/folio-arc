# Folio connector

Folio is a treasury agent for people. This connector exposes three scoped tools through OAuth and MCP: read a profile, read a portfolio, and save research.

The authorization server, MCP resource, and restricted core run as separate services. The local core contains isolated Alice/Bob portfolios and saved research; it does not connect to a Folio account or execute transactions. Tool titles and descriptions match the deployed Folio interface; local portfolio responses contain only symbols and quantities.

## Run locally

Requires Docker Compose, Python 3, OpenSSL, `ss` (iproute2), and `curl` on Linux. Preparation must run with permission to assign private state to UID/GID 1000, used by the containers; merely having that account on the host is insufficient. The images use Node 24. Start and test the connector with the Compose commands below; this package has no standalone npm start/test scripts.

```sh
cd connector
./scripts/preflight.sh
./scripts/prepare-runtime.sh
docker compose build
docker compose up -d --wait as mcp core tls-fixture
./scripts/container-acceptance.sh
curl --ipv4 --noproxy '*' --fail http://localhost:38313/.well-known/oauth-protected-resource/mcp
docker compose run --rm --entrypoint node test-runner storage-test.mjs
```

The Compose project is `folio-connector`. Only the authorization server and MCP publish host ports, both bound to IPv4 loopback. The two Compose publication lines are the repository scanner's sole content exemption: loopback bind, not an internal host. Core, administration, and TLS fixture ports stay inside Docker. The OAuth network is a normal bridge so Docker can publish its endpoints; it permits outbound access. The core network remains internal. Acceptance requires no external service and checks both published discovery endpoints from the host before its in-network tests.

The issuer is `http://localhost:38312`; the resource is `http://localhost:38313/mcp`. The local client uses the exact redirect `http://localhost:38314/callback`; no callback listener is needed.

Open `http://localhost:38312/demo/` for the browser viewer. Use `alice` or `bob` with its generated private passcode in `.runtime/secrets/as/password-alice` or `password-bob`. Never publish these files or include credentials in logs. The `/demo/...` route identifiers are protocol paths retained for compatibility.

When finished viewing and testing, stop the services:

```sh
docker compose down -v
```

Acceptance exercises discovery, PKCE, scopes, audience checks, owner isolation, revocation, refresh races, browser sessions, restarts, and signing-key rotation. It writes ignored results under `evidence/`; SSRF coverage remains marked UNVERIFIED because dynamic DNS rebinding is not exercised. Public HTTPS metadata and live ChatGPT authentication are not exercised by this suite.

Each full acceptance run requires fresh local state. Before repeating it, run `./scripts/reset-local.sh`, then prepare/start/test again. Preparation and `docker compose down -v` preserve bind-mounted state; retained authorization bindings have a 200-entry capacity, so repeated runs without reset eventually reject new authorization. Acceptance checks for existing bindings and stops with reset instructions rather than deleting state automatically. Reset removes only AS/core/runner state and preserves generated credentials. Restart checks compare against the signing key and research captured within the same run; the rotation phase expects one rotation from fresh state. Keep `.runtime/` and `evidence/` private and remove them before sharing a source archive.

## Tools and authority

| Tool | Scope | Effect |
| --- | --- | --- |
| Get Folio profile | `folio:profile:read` | Read connected identity |
| Read Folio portfolio | `folio:portfolio:read` | Read holdings |
| Save research to Folio | `folio:research:write` | Save inert research under the connected owner |

There is no trading, transfer, or signing scope. MCP and core independently introspect delegated tokens; service credentials alone do not establish a person's authority. See [connector hardening](../docs/connector-hardening.md).

## Opt-in renewable delegation

The included implementation supports explicit renewable-access consent for the ChatGPT metadata client through `REFRESH_CONSENT_COMPAT=1`. Checked consent binds renewal to the native grant, account, client, resource, and scopes. The default Compose configuration does not forward this setting or `REFRESH_FAMILY_TTL`, and test mode returns authorization prompts as JSON rather than rendering the checkbox. This opt-in flow is outside default container acceptance; setting these variables in the host shell or `.env` does not enable it in the shipped Compose configuration. Default acceptance exercises native `offline_access` behavior and refresh rotation.

When the opt-in implementation is configured separately, `REFRESH_FAMILY_TTL` accepts 600–14400 seconds; the default is 600. The original grant's stored window cannot be extended by changing configuration or rotating tokens. Access issued near that deadline may remain valid for its separate access-token lifetime. Local acceptance uses five-second access tokens; public mode requires 300–600 seconds. Replay or Disconnect revokes the grant; browser logout is separate.

## Publication boundary

The Privy backend verifier and existing-identity mapping are included for review. The Privy browser assets are not included; enabling that browser mode fails at startup without those assets. Local Compose uses development identities. Real sign-in and ChatGPT connection acceptance require the hosted integration.

The Folio-server adapter and its routes, production networks and port maps, production images and digests, and production secret values are not published. Local bootstrap, generated-secret layout, pinned base-image digest, and Compose configuration are published.

The hosted connection at [chatgpt.tryfolio.io](https://chatgpt.tryfolio.io) is designated for Folio Paper; local acceptance does not verify its deployment. See [connect ChatGPT](../docs/connect-chatgpt.md) for the supplied connection steps.

Licensed under Apache-2.0.
