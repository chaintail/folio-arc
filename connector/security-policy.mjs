// Provider hooks retain native issuance/rotation; application checks fail closed.
export function allowedAccount(
  policy,
  { privy = false, known = false, client } = {},
) {
  return (
    !!policy &&
    (privy ? policy.eligible === true : known) &&
    !policy.suspended &&
    !(client && policy.clients?.[client])
  );
}
// Operator mutations may restore an existing account's eligibility. Older connector
// cores expose only eligible; retain that stricter fallback, never infer existence.
export function operatorAccountExists(policy) {
  return !!policy && (Object.hasOwn(policy, 'exists')
    ? policy.exists === true : policy.eligible === true);
}
export function exactOrigin(origin, base) {
  return origin === new URL(base).origin;
}
export function sameOwner(existing, id) {
  return !existing || existing.id === id;
}
export function boundBrowser(binding, session, account) {
  if (!binding) return false;
  if (binding.token && binding.token !== session?.token) return false;
  return (
    (!binding.account || binding.account === account) &&
    sameOwner(session, account)
  );
}
export function configuredRefreshWindow(value = process.env.REFRESH_FAMILY_TTL) {
  const seconds = value === undefined ? 600 : Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < 600 || seconds > 14400)
    throw Error("Invalid refresh family window");
  return seconds;
}
export class AuthorizationExpired extends Error {}
export function requireFreshBinding(binding, now = Date.now()) {
  if (!binding || !Number.isSafeInteger(binding.expires) || binding.expires <= now)
    throw new AuthorizationExpired("Authorization expired");
  return binding;
}
export function bindInteraction(db, interaction, session, now = Date.now()) {
  if (db[interaction.uid]) requireFreshBinding(db[interaction.uid], now);
  // Retain expired bindings until their provider interaction is gone: a reload
  // must not turn a ten-minute authorization into a fresh authorization.
  for (const [key, row] of Object.entries(db))
    if ((row.retainUntil ?? row.expires + 3600000) <= now) delete db[key];
  if (!db[interaction.uid]) {
    if (Object.keys(db).length >= 200) throw Error("Interaction capacity");
    db[interaction.uid] = {
      token: session?.token || null,
      account: interaction.prompt?.name === 'login' &&
        interaction.prompt.reasons?.includes('account_unavailable')
        ? session?.id || null : interaction.session?.accountId || null,
      expires: now + 600000,
      retainUntil: Math.max(now + 600000, interaction.exp * 1000 || now + 3600000),
    };
  }
  return db[interaction.uid];
}
export function refreshFamilyTTL(_ctx, token, window = 600) {
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(token.iiat) || token.iiat > now)
    throw Error("Invalid refresh family issuance");
  configuredRefreshWindow(window);
  return Math.max(0, token.iiat + window - now);
}

// An operator must target the actual client; public Privy has no fixture default.
export function operatorClient(value, { privy = false, test = false } = {}) {
  const client =
    value === undefined && !privy ? "local-chatgpt-fixture" : value;
  if (
    typeof client !== "string" ||
    client.length === 0 ||
    client.length > 2048 ||
    /[\s\u0000-\u001f\u007f]/u.test(client)
  )
    return undefined;
  if (privy && !test && client === "local-chatgpt-fixture") return undefined;
  return client;
}
