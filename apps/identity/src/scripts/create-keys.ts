/**
 * Create the identity service's RSA SIGNING KEY:   npm run keys -w @scalecart/identity
 * Writes JWT_PRIVATE_KEY (PEM, base64) + JWT_KEY_ID into apps/identity/.env - and into
 * tests/system/.env, because the system tests run the identity service in their own process.
 * Running it again = KEY ROTATION in its simplest form: a new key and kid; tokens signed with the
 * old key stop working (a real rotation publishes both keys until the old tokens have expired).
 */
import { generateKeyPairSync, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = fileURLToPath(new URL("../../", import.meta.url));
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const values = { JWT_PRIVATE_KEY: Buffer.from(pem).toString("base64"), JWT_KEY_ID: `scalecart-${randomUUID().slice(0, 8)}` };

for (const file of [path.join(appDir, ".env"), path.join(appDir, "../../tests/system/.env")]) {
  let text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  for (const [k, v] of Object.entries(values)) {
    const line = `${k}="${v}"`;
    const re = new RegExp(`^${k}=.*$`, "m");
    text = re.test(text) ? text.replace(re, line) : `${text}${text && !text.endsWith("\n") ? "\n" : ""}${line}\n`;
  }
  fs.writeFileSync(file, text);
  console.log(`wrote JWT_PRIVATE_KEY + JWT_KEY_ID (${values.JWT_KEY_ID}) to ${path.relative(path.join(appDir, "../.."), file)}`);
}
