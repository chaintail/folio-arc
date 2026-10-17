# Connector hardening

This document distinguishes controls present in the published connector from the hosted Folio integration.\
The local core contains isolated portfolios.\
Production routing and real sign-in are not established by local acceptance.

## 1. Service boundaries

The authorization server uses `oidc-provider`; the MCP resource offers Streamable HTTP; the restricted core enforces person and scope checks. Each runs separately through [server.mjs:1](../connector/server.mjs#L1). MCP forwards the actual bearer with its service credential to core ([mcp.mjs:14](../connector/mcp.mjs#L14)). In the hosted architecture, only the production core adapter connects to Folio; that adapter is excluded. ChatGPT and MCP receive no Privy signing credentials or wallet authority.

## 2. Discovery

The provider exposes OpenID configuration and OAuth authorization-server metadata. The acceptance suite checks both ([test.mjs:52](../connector/test.mjs#L52)). RFC 9728 protected-resource metadata is served at `/.well-known/oauth-protected-resource/mcp`; unauthenticated requests receive a Bearer challenge with `resource_metadata` ([mcp.mjs:8](../connector/mcp.mjs#L8), [mcp.mjs:9](../connector/mcp.mjs#L9)).

## 3. Authorization and metadata fetching

PKCE S256 is required for every client ([as.mjs:152](../connector/as.mjs#L152)). The local client declares an exact redirect URI; dynamic registration is enabled ([as.mjs:104](../connector/as.mjs#L104), [as.mjs:169](../connector/as.mjs#L169)). Redirect validation belongs to the pinned provider; no wildcard callback is configured. Public mode rate-limits registration and authorization routes ([as.mjs:290](../connector/as.mjs#L290)).

Client-ID metadata documents use the provider's protected fetching, including private-destination rejection, redirect refusal, and response-size limits. Startup fails when the provider reports unavailable SSRF protection ([as.mjs:260](../connector/as.mjs#L260)). The local `cimd.test` response boundary is explicitly test-only ([as.mjs:199](../connector/as.mjs#L199)). The TLS fixture verifies that rejected destinations receive no extra request. DNS-rebinding protection is handled by the provider's socket-IP check and is not exercised by local acceptance.

## 4. Token audience

RFC 8707 resource indicators restrict normal issuance to the configured MCP resource. Unknown resources produce `invalid_target`; access tokens are opaque ([as.mjs:171](../connector/as.mjs#L171)). Test mode alone enables a second resource for negative audience checks. This exception must remain disabled in public mode.

## 5. Scopes and tools

The three scopes are `folio:profile:read`, `folio:portfolio:read`, and `folio:research:write` ([common.mjs:12](../connector/common.mjs#L12)). Tool metadata carries the production titles and descriptions, OAuth requirements, and read-only/idempotency hints ([mcp.mjs:19](../connector/mcp.mjs#L19)). Missing tool scope returns `insufficient_scope` through MCP authentication metadata ([mcp.mjs:17](../connector/mcp.mjs#L17)). There is no trading, transfer, or signing scope.

## 6. Independent online verification

MCP introspects every bearer, then core introspects it again using its own credential. The destination is configuration-controlled, the canonical Host is explicit, responses are capped at 32 KiB, and the request times out after two seconds ([introspection.mjs:4](../connector/introspection.mjs#L4)). Validation checks active status, issuer, audience, expiry, subject, client, and scope ([introspection.mjs:51](../connector/introspection.mjs#L51)).

Core derives the person and client from introspection, checks account existence and current policy, and enforces the exact endpoint scope ([core.mjs:16](../connector/core.mjs#L16), [core.mjs:18](../connector/core.mjs#L18)). An asserted subject plus a service credential cannot authorize MCP access. Eligibility and the actual tool operation each reach core, yielding three introspections per successful tool call.

## 7. Identity and sign-in

The retained Privy verifier pins the HTTPS JWKS hostname and app-specific path, delegates cryptographic verification to the pinned Privy SDK, and bounds issuance and expiry claims ([privy-identity.mjs:6](../connector/privy-identity.mjs#L6), [privy-identity.mjs:12](../connector/privy-identity.mjs#L12)). Identity mapping uses the provider/app/DID tuple and a pre-provisioned account; email is not stored as an identity key ([identity-store.mjs:43](../connector/identity-store.mjs#L43), [identity-store.mjs:95](../connector/identity-store.mjs#L95)).

Hosted sign-in uses existing accounts and a separate OAuth consent step. The published image omits the Privy browser assets and fails clearly if that mode is enabled without them ([as.mjs:78](../connector/as.mjs#L78)). Its local run uses development identities. Browser logout removes its display session; it is distinct from revoking ChatGPT access ([as.mjs:428](../connector/as.mjs#L428)).

## 8. Renewable delegation and revocation

The compatibility mode requires explicit checked consent bound to grant, person, client, resource, and scopes ([as.mjs:580](../connector/as.mjs#L580), [renewable-consent.mjs:40](../connector/renewable-consent.mjs#L40)). This implementation is included for review but is outside default container acceptance: Compose does not forward its configuration, and test mode returns JSON prompts rather than rendering the checkbox. With that mode disabled, native `offline_access` rules apply ([renewable-consent.mjs:120](../connector/renewable-consent.mjs#L120)).

The immutable per-grant renewal window defaults to 600 seconds and permits at most four hours. Rotation uses original issuance, so a new configuration cannot extend an existing family's deadline ([renewable-consent.mjs:107](../connector/renewable-consent.mjs#L107), [security-policy.mjs:64](../connector/security-policy.mjs#L64)). Issued access can outlive the renewal deadline by its separate token lifetime.

SQLite transactions and compare-and-set consumption preserve permanent revoked-grant tombstones, preventing replay or late writes from restoring a grant ([adapter.mjs:13](../connector/adapter.mjs#L13), [adapter.mjs:22](../connector/adapter.mjs#L22)). Disconnect first persists core denial and then destroys matching grants; reconnect never restores deleted tokens ([as.mjs:632](../connector/as.mjs#L632)). An operation already authorized may finish; there is no transactional cancellation claim.

## 9. Paper routing and operator policy

The hosted hostname is designated for Paper, where research writes land. This is a deployment property described in the [connection guide](connect-chatgpt.md), not a guarantee implemented by the isolated local core. The published core deliberately has no Folio-server adapter ([core.mjs:2](../connector/core.mjs#L2)).

Local policy records suspension and per-client disconnect state. Core reads them for each operation; AS obtains eligibility through core ([core.mjs:16](../connector/core.mjs#L16), [as.mjs:112](../connector/as.mjs#L112)). Read errors and invalid JSON in an existing policy file deny the request; the parsed policy structure is not schema-validated. A missing local policy file starts with an empty policy ([common.mjs:17](../connector/common.mjs#L17)). Production shared policy and Paper/Live separation belong to the unpublished integration.

## 10. Browser surface

Public mode installs the provider CSP before provider rendering ([as.mjs:604](../connector/as.mjs#L604), [provider-csp.mjs:3](../connector/provider-csp.mjs#L3)). Privy-mode authorization pages have their own nonce-based CSP ([as.mjs:302](../connector/as.mjs#L302)). These hooks do not imply that every local viewer route receives CSP.

Bodies are capped at 32 KiB; public login, interaction, registration, and authorization routes have per-route process-wide limits ([as.mjs:274](../connector/as.mjs#L274), [as.mjs:296](../connector/as.mjs#L296)). Same-origin checks, CSRF tokens, browser identity binding, ten-minute authorization expiry, and bounded retention constrain browser submissions ([security-policy.mjs:19](../connector/security-policy.mjs#L19), [security-policy.mjs:45](../connector/security-policy.mjs#L45)). Research is rendered as text, and input schemas reject foreign owner fields ([viewer/app.js:2](../connector/viewer/app.js#L2), [common.mjs:15](../connector/common.mjs#L15)).

## 11. Publication boundary

The Folio-server adapter and its routes, production networks and port maps, production images and digests, and production secret values are not published. The isolated core, `bootstrap.mjs`, and local Compose layout are published ([core.mjs:2](../connector/core.mjs#L2), [bootstrap.mjs:2](../connector/bootstrap.mjs#L2), [compose.yml:11](../connector/compose.yml#L11)).

The Dockerfile includes a pinned public base-image digest, not a production deployment image ([Dockerfile:1](../connector/Dockerfile#L1)). Bootstrap generates local credentials at runtime; Compose mounts each service's subset. Runtime state, credentials, and acceptance output must remain private and are ignored ([.gitignore:1](../connector/.gitignore#L1)).
