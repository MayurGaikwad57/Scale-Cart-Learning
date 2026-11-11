/**
 * The system tests check effects INSIDE several services, so they need every service's database
 * client. Each one connects to that service's OWN database (its own URL from .env) - there is no
 * longer one client that sees every table. Production code never does this: a service only has
 * its own database's address and credentials.
 */
export { prisma as orderDb } from "@scalecart/order/config/prisma";
export { prisma as inventoryDb } from "@scalecart/inventory/config/prisma";
export { prisma as paymentDb } from "@scalecart/payment/config/prisma";
export { prisma as notificationDb } from "@scalecart/notification/config/prisma";

import { prisma as o } from "@scalecart/order/config/prisma";
import { prisma as i } from "@scalecart/inventory/config/prisma";
import { prisma as p } from "@scalecart/payment/config/prisma";
import { prisma as n } from "@scalecart/notification/config/prisma";

/** Close every service's connection pool (end of a test file). */
export const disconnectAll = () => Promise.all([o, i, p, n].map((c) => c.$disconnect()));
