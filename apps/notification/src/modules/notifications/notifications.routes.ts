import { Router } from "express";
import { prisma } from "../../config/prisma.js";
import { z } from "zod";
import { authenticate } from "@scalecart/service-kit/auth";
import { validateBody } from "@scalecart/service-kit/validate";
import { uuid } from "@scalecart/service-kit/validation";

// The customer's notifications - written asynchronously by the "notification" consumer group.
export const notificationsRouter = Router();
notificationsRouter.use(authenticate);

notificationsRouter.get("/", async (req, res) => {
  const userId = req.user!.id;
  const [items, unread] = await prisma.$transaction([
    prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 20 }),
    prisma.notification.count({ where: { userId, read: false } }),
  ]);
  res.json({ items, unread });
});

// Mark exactly the notifications the user has SEEN (the ids shown in the open list). A blanket
// "read all" could also mark one that arrived after the list was loaded and was never shown
// (found in code review). Returns the remaining unread count for the badge.
notificationsRouter.post("/read", validateBody(z.object({ ids: z.array(uuid).max(50) })), async (req, res) => {
  const userId = req.user!.id;
  await prisma.notification.updateMany({ where: { userId, id: { in: req.body.ids } }, data: { read: true } });
  res.json({ unread: await prisma.notification.count({ where: { userId, read: false } }) });
});

notificationsRouter.post("/read-all", async (req, res) => {
  await prisma.notification.updateMany({ where: { userId: req.user!.id, read: false }, data: { read: true } });
  res.status(204).end();
});
