import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
let db;
const validAccount = (id) =>
  typeof id === "string" && /^folio-privy-[a-zA-Z0-9_-]{1,80}$/.test(id);
function database() {
  if (db) return db;
  db = new DatabaseSync(
    path.join(process.env.STATE_DIR || "/state", "identities.sqlite"),
    { defensive: true, allowExtension: false, timeout: 2000 },
  );
  db.exec(
    "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY,portfolio TEXT NOT NULL) STRICT; CREATE TABLE IF NOT EXISTS identity_links(provider TEXT NOT NULL,app_id TEXT NOT NULL,did TEXT NOT NULL,account_id TEXT NOT NULL REFERENCES accounts(id),PRIMARY KEY(provider,app_id,did)) STRICT;",
  );
  return db;
}
export function provisionIdentities() {
  const entries = JSON.parse(
    fs.readFileSync(
      process.env.PRIVY_ELIGIBLE_FILE || "/config/eligible-identities.json",
      "utf8",
    ),
  );
  if (!Array.isArray(entries) || entries.length > 20)
    throw Error("Invalid eligible identity configuration");
  const conn = database();
  conn.exec("BEGIN IMMEDIATE");
  try {
    const ambiguous = conn
      .prepare(
        "SELECT account_id FROM identity_links GROUP BY account_id HAVING COUNT(*)>1",
      )
      .get();
    if (ambiguous) throw Error("Ambiguous identity account linkage");
    conn.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS identity_account_unique ON identity_links(account_id)",
    );
    const tuples = new Set(),
      accounts = new Set();
    for (const e of entries) {
      if (
        e.provider !== "privy.io" ||
        typeof e.app_id !== "string" ||
        !/^[a-zA-Z0-9_-]{8,128}$/.test(e.app_id) ||
        !/^did:privy:[a-zA-Z0-9_-]{1,128}$/.test(e.did) ||
        !validAccount(e.account_id) ||
        !Array.isArray(e.portfolio) ||
        e.portfolio.length > 20 ||
        e.portfolio.some(
          (p) =>
            !p ||
            typeof p.symbol !== "string" ||
            !/^[A-Z0-9.-]{1,16}$/.test(p.symbol) ||
            !Number.isFinite(p.quantity) ||
            p.quantity < 0,
        )
      )
        throw Error("Invalid eligible identity entry");
      const tuple = JSON.stringify([e.provider, e.app_id, e.did]);
      if (tuples.has(tuple) || accounts.has(e.account_id))
        throw Error("Duplicate identity or account linkage");
      tuples.add(tuple);
      accounts.add(e.account_id);
      const prior = conn
        .prepare(
          "SELECT account_id FROM identity_links WHERE provider=? AND app_id=? AND did=?",
        )
        .get(e.provider, e.app_id, e.did);
      if (prior && prior.account_id !== e.account_id)
        throw Error("Identity remapping forbidden");
      conn
        .prepare("INSERT INTO accounts VALUES(?,?) ON CONFLICT(id) DO NOTHING")
        .run(e.account_id, JSON.stringify(e.portfolio));
      conn
        .prepare(
          "INSERT INTO identity_links VALUES(?,?,?,?) ON CONFLICT DO NOTHING",
        )
        .run(e.provider, e.app_id, e.did, e.account_id);
    }
    conn.exec("COMMIT");
  } catch (e) {
    conn.exec("ROLLBACK");
    throw e;
  }
  // Eligibility is current operator config, separate from retained stable links.
  return new Set(
    entries.map((e) => JSON.stringify([e.provider, e.app_id, e.did])),
  );
}
let eligible;
export function initializeIdentityStore() {
  eligible = provisionIdentities();
}
export function resolveIdentity(value) {
  if (
    !value ||
    !eligible?.has(JSON.stringify([value.provider, value.app_id, value.did]))
  )
    return undefined;
  return database()
    .prepare(
      "SELECT account_id FROM identity_links WHERE provider=? AND app_id=? AND did=?",
    )
    .get(value.provider, value.app_id, value.did)?.account_id;
}
export function account(id) {
  if (!eligible) return undefined;
  const row = database()
    .prepare("SELECT id,portfolio FROM accounts WHERE id=?")
    .get(id);
  if (!row) return undefined;
  const links = database()
    .prepare(
      "SELECT provider,app_id,did FROM identity_links WHERE account_id=?",
    )
    .all(id);
  if (
    !links.some((l) =>
      eligible.has(JSON.stringify([l.provider, l.app_id, l.did])),
    )
  )
    return undefined;
  return { id: row.id, portfolio: JSON.parse(row.portfolio) };
}
