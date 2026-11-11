import { PAYMENT_METHODS } from "@scalecart/events";
import { pageParams } from "@scalecart/service-kit/validation";
import { z } from "zod";

export const createOrderSchema = z.object({ paymentMethod: z.enum(PAYMENT_METHODS) });
export const listOrdersQuery = z.object(pageParams);

/** Same limit as the inventory service's reserveSchema: checked here so the customer gets a clear 400. */
export const MAX_ORDER_LINES = 100;
