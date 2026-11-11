import { createOnce } from "@scalecart/service-kit/once";
import type { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../config/prisma.js";

/** Idempotent consumer for THIS service's database (logic: service-kit/once.ts). */
export const once = createOnce<Prisma.TransactionClient>((work) => prisma.$transaction(work));
