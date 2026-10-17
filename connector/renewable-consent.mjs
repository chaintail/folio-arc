import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { configuredRefreshWindow } from "./security-policy.mjs";
const RESOURCE = process.env.RESOURCE;
const permitted = new Set([
  "openid",
  "offline_access",
  "folio:profile:read",
  "folio:portfolio:read",
  "folio:research:write",
]);
let db;
function store() {
  if (!db) {
    db = new DatabaseSync(
      path.join(process.env.STATE_DIR || "/state", "renewable-consent.sqlite"),
      { defensive: true, allowExtension: false, timeout: 2000 },
    );
    db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS consent(grant_id TEXT PRIMARY KEY,body TEXT NOT NULL) STRICT",
    );
  }
  return db;
}
export function compatibilityClient(id) {
  return (
    process.env.REFRESH_CONSENT_COMPAT === "1" &&
    (id === "https://chatgpt.com/oauth/client.json" ||
      (process.env.TEST_PROFILE === "1" && id === "local-chatgpt-fixture"))
  );
}
function validScopes(scopes) {
  return (
    Array.isArray(scopes) &&
    scopes.length > 0 &&
    scopes.every((s) => permitted.has(s)) &&
    scopes.some((s) => s.startsWith("folio:"))
  );
}
export function recordConsent({
  grantId,
  accountId,
  clientId,
  resource,
  scopes,
}) {
  if (
    !compatibilityClient(clientId) ||
    resource !== RESOURCE ||
    typeof grantId !== "string" ||
    typeof accountId !== "string" ||
    !validScopes(scopes)
  )
    throw Error("Invalid renewable consent");
  const body = JSON.stringify({
    accountId,
    clientId,
    resource,
    scopes: [...new Set(scopes)].sort(),
    version: 2,
    refreshFamilyTTL: configuredRefreshWindow(),
  });
  const conn = store();
  conn.exec("BEGIN IMMEDIATE");
  try {
    const prior = conn
      .prepare("SELECT body FROM consent WHERE grant_id=?")
      .get(grantId);
    if (prior) {
      const previous = JSON.parse(prior.body), next = JSON.parse(body);
      for (const key of ["accountId", "clientId", "resource", "scopes"])
        if (JSON.stringify(previous[key]) !== JSON.stringify(next[key]))
          throw Error("Conflicting renewable consent");
      // Repeated consent never changes a grant's original window.
    }
    conn
      .prepare("INSERT INTO consent VALUES(?,?) ON CONFLICT DO NOTHING")
      .run(grantId, body);
    conn.exec("COMMIT");
  } catch (e) {
    conn.exec("ROLLBACK");
    throw e;
  }
}
export function consentMatches(source, client) {
  if (
    !compatibilityClient(client.clientId) ||
    !client.grantTypeAllowed("refresh_token") ||
    source.resource !== RESOURCE ||
    source.clientId !== client.clientId ||
    !validScopes([...source.scopes])
  )
    return false;
  const row = store()
    .prepare("SELECT body FROM consent WHERE grant_id=?")
    .get(source.grantId);
  if (!row) return false;
  const record = JSON.parse(row.body);
  return (
    record.accountId === source.accountId &&
    record.clientId === source.clientId &&
    record.resource === source.resource &&
    [...source.scopes].every((s) => record.scopes.includes(s))
  );
}
// Stored policy is immutable; current environment never extends existing families.
export function consentRefreshWindow(token) {
  const row = store().prepare("SELECT body FROM consent WHERE grant_id=?").get(token.grantId);
  if (!row) return 600;
  const record = JSON.parse(row.body);
  if (record.accountId !== token.accountId || record.clientId !== token.clientId ||
      record.resource !== token.resource)
    throw Error("Refresh consent binding mismatch");
  if (record.version === 1) return 600;
  if (record.version !== 2) throw Error("Unknown refresh consent version");
  if (!Number.isSafeInteger(record.refreshFamilyTTL))
    throw Error("Invalid stored refresh consent window");
  return configuredRefreshWindow(record.refreshFamilyTTL);
}
export function renewableHooks({ eligible, validGrant }) {
  async function approved(ctx, client, source) {
    return (
      consentMatches(source, client) &&
      (await validGrant(source.grantId, source.accountId, client.clientId)) &&
      (await eligible(source.accountId, client.clientId))
    );
  }
  return {
    expiresWithSession: async (ctx, source) =>
      compatibilityClient(ctx.oidc.client.clientId)
        ? !(await approved(ctx, ctx.oidc.client, source))
        : !source.scopes.has("offline_access"),
    issueRefreshToken: async (ctx, client, source) =>
      compatibilityClient(client.clientId)
        ? await approved(ctx, client, source)
        : client.grantTypeAllowed("refresh_token") &&
          source.scopes.has("offline_access"),
  };
}
