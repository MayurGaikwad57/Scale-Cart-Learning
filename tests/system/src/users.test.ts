import { createHmac, createPublicKey, generateKeyPairSync } from "node:crypto";
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { jwks, signToken } from "@scalecart/identity/keys";
import { disconnectAll, identityDb } from "./db.js";
import { authenticate, requireRole } from "@scalecart/service-kit/auth";
import { errorHandler } from "@scalecart/service-kit/error-handler";
import { startCluster, type Cluster } from "./test-cluster.js";

// M6: every request goes through the API gateway to the real services (see test-cluster.ts).
let cluster: Cluster;
let app: express.Express;
beforeAll(async () => {
  cluster = await startCluster();
  app = cluster.gateway;
});
// Unique per run so tests never collide with real data or each other.
const run = Date.now();
const email = (n: string) => `test-${run}-${n}@example.com`;

afterAll(async () => {
  await cluster.close();
  await identityDb.user.deleteMany({ where: { email: { startsWith: `test-${run}-` } } });
  await disconnectAll();
});

describe("POST /auth/register", () => {
  it("creates a CUSTOMER, returns a token, and never returns the hash", async () => {
    const res = await request(app)
      .post("/auth/register")
      .send({ email: email("a"), password: "password123" });
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe("CUSTOMER");
    expect(res.body.token).toBeTypeOf("string");
    expect(JSON.stringify(res.body)).not.toContain("passwordHash");
  });

  it("ignores a client-supplied role (no self-made admins)", async () => {
    const res = await request(app)
      .post("/auth/register")
      .send({ email: email("b"), password: "password123", role: "ADMIN" });
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe("CUSTOMER");
  });

  it("rejects a duplicate email with 409 (case-insensitive)", async () => {
    await request(app).post("/auth/register").send({ email: email("c"), password: "password123" });
    const res = await request(app)
      .post("/auth/register")
      .send({ email: email("c").toUpperCase(), password: "password123" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("email_taken");
  });

  it("rejects bad input with 400 and field details", async () => {
    const res = await request(app).post("/auth/register").send({ email: "nope", password: "short" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_failed");
    expect(res.body.details.map((d: { path: string }) => d.path).sort()).toEqual(["email", "password"]);
  });

  it("handles two simultaneous registrations of one email: exactly one wins", async () => {
    const body = { email: email("race"), password: "password123" };
    const results = await Promise.all([
      request(app).post("/auth/register").send(body),
      request(app).post("/auth/register").send(body),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
  });
});

describe("POST /auth/login", () => {
  it("returns a token for correct credentials", async () => {
    await request(app).post("/auth/register").send({ email: email("l1"), password: "password123" });
    const res = await request(app).post("/auth/login").send({ email: email("l1"), password: "password123" });
    expect(res.status).toBe(200);
    // RS256, with the key id in the header - verifiable with the PUBLIC key from the JWKS alone.
    const { header } = jwt.decode(res.body.token, { complete: true })!;
    expect(header).toMatchObject({ alg: "RS256", kid: jwks().keys[0].kid });
    const publicKey = createPublicKey({ key: jwks().keys[0] as never, format: "jwk" });
    const payload = jwt.verify(res.body.token, publicKey, { algorithms: ["RS256"] }) as jwt.JwtPayload;
    expect(payload.role).toBe("CUSTOMER");
    expect(payload.sub).toBe(res.body.user.id);
  });

  it("gives the same 401 for wrong password and unknown email", async () => {
    await request(app).post("/auth/register").send({ email: email("l2"), password: "password123" });
    const wrongPw = await request(app).post("/auth/login").send({ email: email("l2"), password: "wrongwrong" });
    const unknown = await request(app).post("/auth/login").send({ email: email("ghost"), password: "password123" });
    expect(wrongPw.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrongPw.body).toEqual(unknown.body);
  });
});

describe("the identity service publishes only PUBLIC keys", () => {
  it("GET /.well-known/jwks.json returns an RSA public key with its kid - and no private part", async () => {
    const res = await request(app).get("/auth/me"); // through the gateway: 401, identity is behind it
    expect(res.status).toBe(401);
    const set = jwks();
    expect(set.keys[0]).toMatchObject({ kty: "RSA", alg: "RS256", use: "sig", kid: expect.any(String) });
    expect(set.keys[0]).not.toHaveProperty("d"); // "d" = the private exponent
  });
});

describe("authenticate / requireRole middleware", () => {
  const guarded = express();
  guarded.get("/me", authenticate, (req, res) => res.json(req.user));
  guarded.get("/admin", authenticate, requireRole("ADMIN"), (_req, res) => res.json({ ok: true }));
  guarded.use(errorHandler);

  const tokenFor = (role: string, exp: string | number = "1h") => signToken({ id: "user-1", role }, exp);
  const kid = () => jwks().keys[0].kid as string;

  it("401 without a token", async () => {
    expect((await request(guarded).get("/me")).status).toBe(401);
  });
  it("401 for a token signed with ANOTHER private key (even with our key id)", async () => {
    const { privateKey: attackerKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const forged = jwt.sign({ role: "ADMIN" }, attackerKey, { algorithm: "RS256", keyid: kid(), subject: "x" });
    expect((await request(guarded).get("/me").set("Authorization", `Bearer ${forged}`)).status).toBe(401);
  });
  it("401 for the ALGORITHM-CONFUSION attack: HS256 'signed' with our public key", async () => {
    // The attacker knows the public key (it is public!). If a verifier trusted the token's "alg",
    // it would check an HMAC with the public key as the secret - and accept this forged admin token.
    const pem = createPublicKey({ key: jwks().keys[0] as never, format: "jwk" }).export({ type: "spki", format: "pem" }).toString();
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const unsigned = `${b64({ alg: "HS256", typ: "JWT", kid: kid() })}.${b64({ sub: "x", role: "ADMIN", exp: Math.floor(Date.now() / 1000) + 600 })}`;
    const forged = `${unsigned}.${createHmac("sha256", pem).update(unsigned).digest("base64url")}`;
    expect((await request(guarded).get("/admin").set("Authorization", `Bearer ${forged}`)).status).toBe(401);
  });
  it("401 for a token without a key id, and for a tampered payload", async () => {
    const { privateKey: k } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const noKid = jwt.sign({ role: "ADMIN" }, k, { algorithm: "RS256", subject: "x" });
    expect((await request(guarded).get("/me").set("Authorization", `Bearer ${noKid}`)).status).toBe(401);
    const [h, , sig] = tokenFor("CUSTOMER").split(".");
    const tampered = `${h}.${Buffer.from(JSON.stringify({ sub: "user-1", role: "ADMIN", exp: 9999999999 })).toString("base64url")}.${sig}`;
    expect((await request(guarded).get("/admin").set("Authorization", `Bearer ${tampered}`)).status).toBe(401);
  });
  it("401 for an expired token", async () => {
    const res = await request(guarded).get("/me").set("Authorization", `Bearer ${tokenFor("CUSTOMER", -10)}`);
    expect(res.status).toBe(401);
  });
  it("attaches req.user for a valid token", async () => {
    const res = await request(guarded).get("/me").set("Authorization", `Bearer ${tokenFor("CUSTOMER")}`);
    expect(res.body).toEqual({ id: "user-1", role: "CUSTOMER" });
  });
  it("403 when a CUSTOMER hits an ADMIN route, 200 for ADMIN", async () => {
    const asCustomer = await request(guarded).get("/admin").set("Authorization", `Bearer ${tokenFor("CUSTOMER")}`);
    const asAdmin = await request(guarded).get("/admin").set("Authorization", `Bearer ${tokenFor("ADMIN")}`);
    expect(asCustomer.status).toBe(403);
    expect(asAdmin.status).toBe(200);
  });
});

describe("a client's bad request body is a 4xx, not 'our bug' (500)", () => {
  it("malformed JSON -> 400 entity.parse.failed", async () => {
    const res = await request(app).post("/auth/login").set("Content-Type", "application/json").send('{"email": "x@example.com",');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "entity.parse.failed" });
  });
  it("a body over the 100 KB limit -> 413 entity.too.large", async () => {
    const res = await request(app).post("/auth/login").set("Content-Type", "application/json").send({ email: "x@example.com", password: "p".repeat(110_000) });
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: "entity.too.large" });
  });
});
