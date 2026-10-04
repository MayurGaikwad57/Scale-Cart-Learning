import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { env } from "../../config/env.js";
import { prisma } from "../../config/prisma.js";
import { authenticate, requireRole } from "../../middleware/auth.js";
import { errorHandler } from "../../middleware/errorHandler.js";

const app = createApp();
// Unique per run so tests never collide with real data or each other.
const run = Date.now();
const email = (n: string) => `test-${run}-${n}@example.com`;

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { startsWith: `test-${run}-` } } });
  await prisma.$disconnect();
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
    const payload = jwt.verify(res.body.token, env.JWT_SECRET) as jwt.JwtPayload;
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

describe("authenticate / requireRole middleware", () => {
  const guarded = express();
  guarded.get("/me", authenticate, (req, res) => res.json(req.user));
  guarded.get("/admin", authenticate, requireRole("ADMIN"), (_req, res) => res.json({ ok: true }));
  guarded.use(errorHandler);

  const tokenFor = (role: string, exp: string | number = "1h") =>
    jwt.sign({ role }, env.JWT_SECRET, { subject: "user-1", expiresIn: exp as never });

  it("401 without a token", async () => {
    expect((await request(guarded).get("/me")).status).toBe(401);
  });
  it("401 for a tampered/foreign token", async () => {
    const bad = jwt.sign({ role: "ADMIN" }, "some-other-secret-0123456789", { subject: "x" });
    const res = await request(guarded).get("/me").set("Authorization", `Bearer ${bad}`);
    expect(res.status).toBe(401);
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
