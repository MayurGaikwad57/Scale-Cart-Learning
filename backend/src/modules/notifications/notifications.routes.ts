import { Router } from "express";
import { prisma } from "../../config/prisma.js";
import { authenticate } from "../../middleware/auth.js";

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

notificationsRouter.post("/read-all", async (req, res) => {
  await prisma.notification.updateMany({ where: { userId: req.user!.id, read: false }, data: { read: true } });
  res.status(204).end();
});
