import {
  observeAuthorization,
  observeAuthorizationRejected,
  observeAccepted,
  observeEffective,
  observeToken,
  diagnostic,
  observeServerError,
} from "./diagnostics.mjs";
import { document, credentials, html, renewableConsentCopy, expiredAuthorizationBody } from "./auth-pages.mjs";
import express from "express";
import { providerCsp } from "./provider-csp.mjs";
import {
  compatibilityClient,
  recordConsent,
  renewableHooks,
  consentRefreshWindow,
} from "./renewable-consent.mjs";
import {
  allowedAccount,
  exactOrigin,
  sameOwner,
  boundBrowser,
  refreshFamilyTTL,
  operatorClient,
  operatorAccountExists,
  configuredRefreshWindow,
  AuthorizationExpired,
  requireFreshBinding,
  bindInteraction,
} from "./security-policy.mjs";
import { SQLiteAdapter as Adapter } from "./adapter.mjs";
import Provider, { errors } from "oidc-provider";
import {accountInteractionPolicy,recoveringAccount,prepareInteractionSession,verifiedInteractionLogin} from './account-recovery.mjs';
import { generateKeyPair, exportJWK } from "jose";
import { randomBytes, createHmac } from "node:crypto";
import fs from "node:fs";
import {
  AS,
  RESOURCE,
  scopes,
  read,
  write,
  users,
  verifyIdentity,
  secret,
  coreCall,
  equal,
  TEST,
  PUBLIC,
  preloadLocalPasswords,
} from "./common.mjs";
configuredRefreshWindow();
const publicBase = process.env.PUBLIC_BASE_URL || AS;
if (
  PUBLIC &&
  (new URL(publicBase).protocol !== "https:" ||
    new URL(publicBase).host !== new URL(AS).host ||
    Number(process.env.ACCESS_TTL || 5) < 300 ||
    Number(process.env.ACCESS_TTL || 5) > 600 ||
    new URL(AS).protocol !== "https:" ||
    new URL(RESOURCE).protocol !== "https:" ||
    process.env.COOKIE_SECURE !== "1" ||
    process.env.DEV_IDENTITY_STUB === "1" ||
    process.env.TEST_PROFILE === "1" ||
    process.env.CIMD_TEST_FIXTURES === "1")
)
  throw Error("Invalid public connector configuration");
if (
  process.env.PRIVY_LOGIN === "1" &&
  (process.env.MOCK_PASSWORD_LOGIN === "1" ||
    process.env.DEV_IDENTITY_STUB === "1")
)
  throw Error("Identity modes must be separate");
if (process.env.PRIVY_LOGIN === "1") {
  const { privyConfig } = await import("./privy-identity.mjs");
  privyConfig();
  if (!fs.existsSync('/app/viewer/privy-login/login.js')) throw Error('Privy browser assets are not included in this public connector');
}
if (
  process.env.PRIVY_LOGIN !== "1" &&
  process.env.DEV_IDENTITY_STUB !== "1" &&
  process.env.MOCK_PASSWORD_LOGIN !== "1"
)
  throw Error("No real identity verifier; explicit local login required");
if (process.env.MOCK_PASSWORD_LOGIN === "1") preloadLocalPasswords();
let jwks = read("keys.json", null);
if (!jwks) {
  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  jwks = {
    keys: [
      {
        ...(await exportJWK(privateKey)),
        kid: "research-key-1",
        use: "sig",
        alg: "RS256",
      },
    ],
  };
  write("keys.json", jwks);
}
const client = {
  client_id: "local-chatgpt-fixture",
  redirect_uris: ["http://localhost:38314/callback"],
  response_types: ["code"],
  grant_types: ["authorization_code", "refresh_token"],
  token_endpoint_auth_method: "none",
  application_type: "native",
};
const cookies = read("cookies.json", null) || [randomBytes(32).toString("hex")];
write("cookies.json", cookies);
async function policy(id) {
  return coreCall("/policy", id, secret("core-as"));
}
const provider = new Provider(AS, {
  adapter: Adapter,
  jwks,
  ...renewableHooks({
    eligible,
    validGrant: async (id, account, client) => {
      const grant = await provider.Grant.find(id);
      return (
        !!grant && grant.accountId === account && grant.clientId === client
      );
    },
  }),
  cookies: {
    keys: cookies,
    short: { secure: process.env.COOKIE_SECURE === "1" },
    long: { secure: process.env.COOKIE_SECURE === "1" },
  },
  clients: [
    ...(PUBLIC ? [] : [client]),
    {
      client_id: "core-resource",
      client_secret: secret("core-introspection"),
      redirect_uris: [],
      grant_types: [],
      response_types: [],
      token_endpoint_auth_method: "client_secret_basic",
    },
    {
      client_id: "mcp-resource",
      client_secret: secret("introspection"),
      redirect_uris: [],
      grant_types: [],
      response_types: [],
      token_endpoint_auth_method: "client_secret_basic",
    },
  ],
  scopes: ["openid", "offline_access", ...scopes],
  pkce: { required: () => true, methods: ["S256"] },
  revokeGrantPolicy: () => true,
  ttl: {
    AccessToken: Number(process.env.ACCESS_TTL || 5),
    AuthorizationCode: 60,
    RefreshToken: (ctx, token) =>
      refreshFamilyTTL(ctx, token, consentRefreshWindow(token)),
  },
  rotateRefreshToken: () => true,
  features: {
    devInteractions: { enabled: false },
    revocation: { enabled: true },
    introspection: {
      enabled: true,
      allowedPolicy: (_ctx, c) =>
        ["mcp-resource", "core-resource"].includes(c.clientId),
    },
    registration: { enabled: true },
    clientIdMetadataDocument: { enabled: true, ack: "draft-02" },
    resourceIndicators: {
      enabled: true,
      defaultResource: () => RESOURCE,
      useGrantedResource: () => true,
      getResourceServerInfo: (_ctx, r) => {
        if (r !== RESOURCE && !(TEST && r === "https://other.example/mcp"))
          throw new errors.InvalidTarget("Unknown resource");
        return {
          scope: scopes.join(" "),
          audience: r,
          accessTokenFormat: "opaque",
        };
      },
    },
  },
  findAccount: async (ctx, id) => {
    const p = await policy(id);
    if (
      !allowedAccount(p, {
        privy: process.env.PRIVY_LOGIN === "1",
        known: !!users[id],
        client: ctx.oidc?.client?.clientId,
      })
    )
      return undefined;
    return { accountId: id, claims: async () => ({ sub: id }) };
  },
  interactions: { policy: accountInteractionPolicy(), url: (_ctx, i) => `/interaction/${i.uid}` },
  ...(TEST && process.env.CIMD_TEST_FIXTURES === "1"
    ? {
        fetch: async (url, options) => {
          if (!String(url).startsWith("https://cimd.test/"))
            return fetch(url, options);
          const name = new URL(url).pathname;
          if (name === "/redirect")
            return new Response(null, {
              status: 302,
              headers: { location: "https://localhost/private" },
            });
          if (name === "/oversized") return new Response("x".repeat(100000));
          return Response.json({
            ...client,
            client_id: String(url),
            redirect_uris: ["https://client.example/callback"],
            application_type: "web",
          });
        },
      }
    : {}),
});
provider.on("authorization.success", observeEffective);
provider.on("authorization.error", observeAuthorizationRejected);
provider.on("server_error", observeServerError);
provider.on("userinfo.error", (ctx, error) =>
  diagnostic("oauth_userinfo_rejected", { error_code: error?.error, status: ctx.status }),
);
provider.on("grant.success", observeToken);
provider.on("grant.error", (ctx) =>
  diagnostic("oauth_token_rejected", {
    grant_type: ["authorization_code", "refresh_token"].includes(
      ctx.oidc?.params?.grant_type,
    )
      ? ctx.oidc.params.grant_type
      : "other",
    status: ctx.status,
  }),
);
provider.proxy = process.env.TRUST_PROXY === "1";
// Initialize the protected dispatcher locally; private probe must fail, public mode has no TLS fixture dependency.
const originalWarn = console.warn;
console.warn = (message, ...rest) => {
  if (String(message).includes("failed to setup SSRF protection"))
    throw Error("SSRF protection unavailable");
  originalWarn(message, ...rest);
};
const { default: protectedFetch } =
  await import("./node_modules/oidc-provider/lib/helpers/fetch_request.js");
let ssrfFailed = false;
try {
  await protectedFetch(
    provider,
    PUBLIC
      ? "https://localhost:1/ssrf-probe"
      : "https://tls-fixture:38315/metadata",
    {},
  );
} catch (e) {
  if (e.message === "SSRF protection unavailable") ssrfFailed = true;
}
if (ssrfFailed) throw Error("CIMD startup fails closed");
const app = express();
app.use((q, r, next) => {
  if (q.path === "/me") {
    r.once("finish", () => diagnostic("oauth_userinfo_result", { status: r.statusCode }));
  }
  next();
});
if (process.env.TRUST_PROXY === "1") app.set("trust proxy", 1);
if (PUBLIC)
  app.use((q, r, next) => {
    if (q.headers.host !== new URL(publicBase).host) return r.sendStatus(421);
    next();
  });
function limit(max) {
  let start = Date.now(),
    count = 0;
  return (_q, r, next) => {
    if (Date.now() - start >= 60000) {
      start = Date.now();
      count = 0;
    }
    if (++count > max)
      return r
        .set("Retry-After", "60")
        .status(429)
        .json({ error: "development rate limit" });
    next();
  };
}
if (PUBLIC) {
  app.use("/demo/login", limit(20));
  app.use("/interaction", limit(64));
  app.use("/reg", limit(20));
  app.use("/auth", limit(60));
}
app.use(express.urlencoded({ extended: false, limit: "32kb" }));
app.use(express.json({ limit: "32kb" }));
app.use("/auth", (q, _r, next) => {
  if (q.method === "GET") observeAuthorization(q, RESOURCE);
  next();
});
function authDocument(res, title, body) {
  if (process.env.PRIVY_LOGIN !== "1") return document(title, body);
  const nonce = randomBytes(24).toString("base64");
  res.set(
    "Content-Security-Policy",
    `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'nonce-${nonce}'; connect-src 'self' https://auth.privy.io; frame-src https://auth.privy.io; img-src 'self' data:; font-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self' https://chatgpt.com; frame-ancestors 'none'`,
  );
  return document(title, body, nonce);
}
const loginFields = () =>
  process.env.PRIVY_LOGIN === "1"
    ? '<div id="privy-login"><p role="status">Loading secure sign in…</p></div><script type="module" src="/demo/privy-login/login.js"></script>'
    : credentials();
app.get("/demo/identity-config", (_q, r) =>
  process.env.PRIVY_LOGIN === "1"
    ? r.json({ appId: process.env.PRIVY_APP_ID })
    : r.sendStatus(404),
);
const csrf = (uid) =>
  createHmac("sha256", secret("csrf")).update(uid).digest("base64url");
function session(req) {
  const token = req.headers.cookie
    ?.split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith("folio_demo="))
    ?.slice(11);
  const row = read("sessions.json")[token];
  return row && row.expires > Date.now() ? { ...row, token } : null;
}
function cookie(res, name, value, age = 3600) {
  res.append(
    "Set-Cookie",
    `${name}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}${process.env.COOKIE_SECURE === "1" ? "; Secure" : ""}`,
  );
}
function retireDemoSession(current,res){
  const sessions=read('sessions.json');
  delete sessions[current.token];
  write('sessions.json',sessions);
  cookie(res,'folio_demo','',0);
}
function originOK(req) {
  return exactOrigin(req.headers.origin, publicBase);
}
async function eligible(id, client) {
  return allowedAccount(await policy(id), {
    privy: process.env.PRIVY_LOGIN === "1",
    known: !!users[id],
    client,
  });
}
function interactionBinding(d, s) {
  const db = read("interaction-bindings.json");
  const binding = bindInteraction(db, d, s);
  write("interaction-bindings.json", db);
  return binding;
}
app.get("/demo/login", (q, r) => {
  const c = randomBytes(24).toString("hex");
  cookie(r, "folio_login", c, 300);
  r.type("html").send(
    authDocument(
      r,
      "Development Folio sign in",
      `<p>Sign in to view your local portfolio and saved research.</p><form method="POST"><input type="hidden" name="csrf" value="${c}">${loginFields()}${process.env.PRIVY_LOGIN === "1" ? "" : '<button type="submit">Sign in</button>'}</form>`,
    ),
  );
});
app.post("/demo/login", async (q, r) => {
  try {
    const c = q.headers.cookie
      ?.split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith("folio_login="))
      ?.slice(12);
    if (!c || !equal(c, q.body.csrf) || !originOK(q)) return r.sendStatus(403);
    const id = await verifyIdentity(q.body);
    if (!sameOwner(session(q), id) || !(await eligible(id)))
      return r.sendStatus(403);
    const token = randomBytes(32).toString("base64url");
    const db = read("sessions.json");
    db[token] = {
      id,
      csrf: randomBytes(24).toString("hex"),
      expires: Date.now() + 3600000,
    };
    write("sessions.json", db);
    cookie(r, "folio_demo", token);
    cookie(r, "folio_login", "", 0);
    r.redirect("/demo/");
  } catch {
    r.status(401).json({ error: "invalid development credentials" });
  }
});
app.get("/demo/api/:name", async (q, r) => {
  const s = session(q);
  if (!s) return r.sendStatus(401);
  if (
    Object.keys(q.query).length ||
    !["profile", "portfolio", "research"].includes(q.params.name)
  )
    return r.sendStatus(400);
  try {
    const value = await coreCall("/" + q.params.name, s.id, secret("core-as"));
    r.json(
      q.params.name === "profile"
        ? {
            id: value.id,
            name:
              process.env.PRIVY_LOGIN === "1"
                ? "Eligible Privy connector account"
                : value.id === "folio-alice"
                  ? "Alice (local)"
                  : "Bob (local)",
            identity_mode:
              process.env.PRIVY_LOGIN === "1" ? "privy" : "development_local",
            csrf_token: s.csrf,
          }
        : q.params.name === "portfolio"
          ? { portfolio: value }
          : value,
    );
  } catch {
    r.sendStatus(403);
  }
});
app.post("/demo/logout", (q, r) => {
  const s = session(q);
  if (!s || !equal(q.headers["x-csrf-token"], s.csrf) || !originOK(q))
    return r.sendStatus(403);
  const db = read("sessions.json");
  delete db[s.token];
  write("sessions.json", db);
  cookie(r, "folio_demo", "", 0);
  r.json(
    process.env.PRIVY_LOGIN === "1"
      ? { ok: true, identity_logout: true }
      : { ok: true },
  );
});
app.get("/demo/logout-identity", (_q, r) => {
  if (process.env.PRIVY_LOGIN !== "1") return r.sendStatus(404);
  r.type("html").send(
    authDocument(
      r,
      "Finish signing out",
      '<p>Your Folio browser session has ended. Sign out of Privy on this device below. Independent ChatGPT access remains connected. Ask the connector operator to revoke it; signing out here does not revoke it.</p><div id="privy-login" data-mode="logout"></div><script type="module" src="/demo/privy-login/login.js"></script>',
    ),
  );
});
app.use("/demo", express.static("/app/viewer", { fallthrough: true }));
app.get("/demo/", (_q, r) =>
  r
    .type("html")
    .send(
      authDocument(
        r,
        "Folio Connector",
        '<p>Open your portfolio and saved research. <a href="/demo/login">Sign in</a></p>',
      ),
    ),
);
function interactionError(e, r, next) {
  if (e instanceof AuthorizationExpired || e instanceof errors.SessionNotFound)
    return r.status(400).type("html").send(authDocument(r,
      "Authorization page expired or unavailable",
      expiredAuthorizationBody));
  return next(e);
}
app.get("/interaction/:uid", async (q, r, next) => {
  try {
    const d = await provider.interactionDetails(q, r);
    if (d.uid !== q.params.uid) return r.sendStatus(403);
    const s = await prepareInteractionSession(d,session(q),{
      eligible,retire: current=>retireDemoSession(current,r),
    });
    interactionBinding(d, s);
    if (s && !(await eligible(s.id, d.params.client_id)))
      throw Error("Account unavailable");
    if (process.env.REFRESH_DIAGNOSTICS === "1")
      observeAccepted(d, await provider.Client.find(d.params.client_id));
    const data = {
      uid: d.uid,
      prompt: d.prompt.name,
      csrf: csrf(d.uid),
      identity: "DEVELOPMENT local identity; fake data",
    };
    if (TEST) {
      data.client_auth_method = (
        await provider.Client.find(d.params.client_id)
      ).tokenEndpointAuthMethod;
      return r.json(data);
    }
    const login = d.prompt.name === "login";
    const identity = login
      ? s && !recoveringAccount(d)
        ? `<input type="hidden" name="session_login" value="yes"><p>Signed in as <strong>${html(s.id)}</strong></p>`
        : loginFields()
      : `<p>Review the access requested for this local account before continuing.</p><dl><dt>Authorized account</dt><dd>${html(d.session.accountId)}</dd><dt>Client</dt><dd>${html(d.params.client_id)}</dd><dt>Requested scopes</dt><dd>${html(d.params.scope)}</dd><dt>Resource</dt><dd>${html(d.params.resource || RESOURCE)}</dd></dl><input type="hidden" name="consent" value="yes">`;
    const renewal =
      !login && compatibilityClient(d.params.client_id)
        ? renewableConsentCopy(configuredRefreshWindow(), Number(process.env.ACCESS_TTL || 5))
        : "";
    const action = login
      ? s && !recoveringAccount(d)
        ? `Continue as ${html(s.id)}`
        : "Sign in"
      : "Authorize requested scopes";
    r.type("html").send(
      authDocument(
        r,
        `Development Folio ${d.prompt.name}`,
        `<form method="POST"><input type="hidden" name="csrf" value="${data.csrf}">${identity}${renewal}${login && (!s || recoveringAccount(d)) && process.env.PRIVY_LOGIN === "1" ? "" : `<button type="submit">${action}</button>`}</form>`,
      ),
    );
  } catch (e) {
    interactionError(e, r, next);
  }
});
app.post("/interaction/:uid", async (q, r, next) => {
  try {
    const d = await provider.interactionDetails(q, r);
    if (d.uid !== q.params.uid) return r.sendStatus(403);
    if (!equal(q.body.csrf, csrf(d.uid)) || !originOK(q))
      return r.sendStatus(403);
    if (d.prompt.name === "login") {
      const s = session(q);
      const binding = requireFreshBinding(read("interaction-bindings.json")[d.uid]);
      const id = await verifiedInteractionLogin(d,s,binding,q.body,{verifyIdentity,eligible});
      binding.account = id;
      const bindings = read("interaction-bindings.json");
      bindings[d.uid] = binding;
      write("interaction-bindings.json", bindings);
      await provider.interactionFinished(
        q,
        r,
        { login: { accountId: id } },
        { mergeWithLastSubmission: false },
      );
      return;
    }
    if (d.prompt.name === "consent" && q.body.consent === "yes") {
      const s = session(q);
      const binding = requireFreshBinding(read("interaction-bindings.json")[d.uid]);
      if (
        !binding ||
        binding.expires <= Date.now() ||
        !boundBrowser(binding, s, d.session.accountId) ||
        !(await eligible(d.session.accountId, d.params.client_id))
      )
        throw Error("Browser identity or eligibility changed");
      let grant = d.grantId ? await provider.Grant.find(d.grantId) : undefined;
      if (compatibilityClient(d.params.client_id)) grant = undefined;
      grant ||= new provider.Grant({
        accountId: d.session.accountId,
        clientId: d.params.client_id,
      });
      if (d.prompt.details.missingOIDCScope)
        grant.addOIDCScope(d.prompt.details.missingOIDCScope.join(" "));
      for (const [r, s] of Object.entries(
        d.prompt.details.missingResourceScopes || {},
      ))
        grant.addResourceScope(r, s.join(" "));
      if (compatibilityClient(d.params.client_id)) {
        const requested = d.params.scope.split(" ");
        grant.addOIDCScope(
          requested
            .filter((x) => ["openid", "offline_access"].includes(x))
            .join(" "),
        );
        if ((d.params.resource || RESOURCE) !== RESOURCE)
          throw Error("Invalid renewable resource");
        grant.addResourceScope(
          RESOURCE,
          requested.filter((x) => scopes.includes(x)).join(" "),
        );
      }
      const grantId = await grant.save();
      if (
        compatibilityClient(d.params.client_id) &&
        q.body.renewable_consent === "yes"
      )
        recordConsent({
          grantId,
          accountId: d.session.accountId,
          clientId: d.params.client_id,
          resource: d.params.resource || RESOURCE,
          scopes: d.params.scope.split(" "),
        });
      await provider.interactionFinished(
        q,
        r,
        { consent: { grantId } },
        { mergeWithLastSubmission: true },
      );
      return;
    }
    r.sendStatus(400);
  } catch (e) {
    interactionError(e, r, next);
  }
});
if (PUBLIC) app.use(providerCsp);
app.use(provider.callback());
app.use((e, _q, r, _n) => {
  observeServerError(null, e);
  return r.status(400).json({ error: "request rejected" });
});
app.listen(38312, "0.0.0.0");
const admin = express();
admin.use(express.json({ limit: "8kb" }));
admin.use((q, r, next) => {
  if (!equal(q.headers.authorization, `Bearer ${secret("operator")}`))
    return r.sendStatus(401);
  next();
});
admin.post("/policy", async (q, r) => {
  try {
    const { account, disconnect, reconnect, suspended } = q.body;
    const client = operatorClient(q.body.client, {
      privy: process.env.PRIVY_LOGIN === "1",
      test: TEST,
    });
    if (!client) return r.sendStatus(400);
    if (
      process.env.PRIVY_LOGIN === "1"
        ? !operatorAccountExists(await policy(account))
        : !users[account]
    )
      return r.sendStatus(400);
    await coreCall("/policy", account, secret("core-operator"), {
      account,
      client,
      disconnect,
      reconnect,
      suspended,
    });
    if (disconnect) {
      for (const id of Adapter.grantsFor(account, client)) {
        const grant = await provider.Grant.find(id);
        if (grant) await grant.destroy();
      }
    }
    r.json({ ok: true });
  } catch {
    r.sendStatus(503);
  }
});
admin.listen(38317, "0.0.0.0");
