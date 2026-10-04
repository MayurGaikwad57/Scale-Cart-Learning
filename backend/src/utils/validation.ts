import { z } from "zod";

export const uuid = z.uuid();

// Shared by every list endpoint.
export const pageParams = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(12),
};

export const idParams = z.object({ id: uuid });
