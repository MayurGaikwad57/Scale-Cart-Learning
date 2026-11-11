import bcrypt from "bcryptjs";
import { conflict, unauthorized } from "@scalecart/service-kit/errors";
import { signToken } from "../../keys.js";
import { usersRepository } from "./users.repository.js";
import type { LoginInput, RegisterInput } from "./users.validation.js";

const BCRYPT_COST = 10;
// Compared against when the email is unknown, so "no such user" and "wrong password"
// take about the same time (prevents leaking which emails are registered).
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", BCRYPT_COST);


export const usersService = {
  async register({ email, password }: RegisterInput) {
    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
    try {
      const user = await usersRepository.create(email, passwordHash);
      return { user, token: signToken(user) };
    } catch (err) {
      // P2002 = unique constraint violation. Relying on the DB constraint (not a
      // check-then-insert) is race-safe when two people register the same email at once.
      if ((err as { code?: string }).code === "P2002") throw conflict("email_taken");
      throw err;
    }
  },

  async me(id: string) {
    const user = await usersRepository.findById(id);
    // A valid token for a deleted user is treated as logged out.
    if (!user) throw unauthorized("invalid_token");
    return { id: user.id, email: user.email, role: user.role };
  },

  async login({ email, password }: LoginInput) {
    const user = await usersRepository.findByEmail(email);
    const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok) throw unauthorized("invalid_credentials");
    return {
      user: { id: user.id, email: user.email, role: user.role },
      token: signToken(user),
    };
  },
};
