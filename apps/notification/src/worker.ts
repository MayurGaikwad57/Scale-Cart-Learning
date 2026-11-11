// An EXTRA consumer process for this service's groups:   npm run worker -w @scalecart/notification
import { runWorker } from "@scalecart/service-kit/worker";
import { db } from "./config/prisma.js";
import { consumers } from "./consumers.js";

runWorker({ name: "notification", consumers, db });
