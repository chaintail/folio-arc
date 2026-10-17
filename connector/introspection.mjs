import { request } from "node:http";
import { AS, AS_INTERNAL, RESOURCE, users, secret } from "./common.mjs";
// Fixed configured destination, canonical Host, bounded response, no cache or proxy IP trust.
export async function introspectBearer(bearer, client, credential) {
  if (typeof bearer !== "string" || !bearer || bearer.length > 8192)
    throw Error("Missing delegated bearer");
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({ token: bearer }).toString();
    const q = request(
      new URL(`${AS_INTERNAL}/token/introspection`),
      {
        method: "POST",
        headers: {
          host: new URL(AS).host,
          authorization:
            "Basic " +
            Buffer.from(`${client}:${secret(credential)}`).toString("base64"),
          "content-type": "application/x-www-form-urlencoded",
          "content-length": Buffer.byteLength(body),
        },
      },
      (r) => {
        let data = "";
        r.setEncoding("utf8");
        r.on("error", reject);
        r.on("data", (chunk) => {
          data += chunk;
          if (Buffer.byteLength(data, "utf8") > 32768) {
            reject(Error("Introspection response too large"));
            q.destroy();
          }
        });
        r.on("end", () => {
          try {
            if (r.statusCode !== 200) throw Error("Introspection denied");
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    q.setTimeout(2000, () => {
      reject(Error("Introspection timeout"));
      q.destroy();
    });
    q.on("error", reject);
    q.end(body);
  });
}
export function validatePrincipal(token, { realApp = false } = {}) {
  if (
    token?.active !== true ||
    token.iss !== AS ||
    token.aud !== RESOURCE ||
    !Number.isFinite(token.exp) ||
    token.exp <= Date.now() / 1000 ||
    typeof token.sub !== "string" ||
    (realApp
      ? !/^folio-privy-[a-f0-9]{64}$/.test(token.sub)
      : process.env.PRIVY_LOGIN === "1"
      ? !/^folio-privy-[a-zA-Z0-9_-]{1,80}$/.test(token.sub)
      : !users[token.sub]) ||
    typeof token.client_id !== "string" ||
    !token.client_id ||
    (realApp && token.client_id.length > 2048) ||
    typeof token.scope !== "string"
  )
    throw Error("Invalid delegated principal");
  return {
    subject: token.sub,
    client: token.client_id,
    scopes: new Set(token.scope.split(" ").filter(Boolean)),
  };
}
