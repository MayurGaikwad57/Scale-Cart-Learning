-- Code review of M6.5: remember whether ProductCreated was published, so the announcer can re-send it.
ALTER TABLE "products" ADD COLUMN "announced_at" TIMESTAMP(3);

-- Every product that exists already has its stock row in the inventory service (copied by the data
-- migration or created from its event): mark it as announced.
UPDATE "products" SET "announced_at" = CURRENT_TIMESTAMP;

CREATE INDEX "products_announced_at_idx" ON "products"("announced_at");
