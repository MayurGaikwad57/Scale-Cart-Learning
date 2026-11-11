import { z } from "zod";

// bcrypt only uses the first 72 bytes, so longer passwords add no security.
const password = z.string().min(8).max(72);
const email = z.string().trim().toLowerCase().pipe(z.email());

export const registerSchema = z.object({ email, password });
export const loginSchema = z.object({ email, password: z.string().min(1) });

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
