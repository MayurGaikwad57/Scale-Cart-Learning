-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('HELD', 'COMMITTED', 'RELEASED');

-- DropIndex
DROP INDEX "payments_order_id_idx";

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "payment_method" TEXT,
ADD COLUMN     "payment_status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "status_reason" TEXT;

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "method" TEXT;

-- CreateTable
CREATE TABLE "reservations" (
    "order_id" UUID NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'HELD',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reservations_pkey" PRIMARY KEY ("order_id")
);

-- CreateTable
CREATE TABLE "reservation_items" (
    "order_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "reservation_items_pkey" PRIMARY KEY ("order_id","product_id")
);

-- CreateIndex
CREATE INDEX "reservations_status_created_at_idx" ON "reservations"("status", "created_at");

-- CreateIndex
CREATE INDEX "orders_status_created_at_idx" ON "orders"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "payments_order_id_key" ON "payments"("order_id");

-- AddForeignKey
ALTER TABLE "reservation_items" ADD CONSTRAINT "reservation_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "reservations"("order_id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Backfill (M6): before M6 the order's payment result lived only in "payments" (one row per order,
-- written inside the checkout transaction). The Order Service now keeps its own copy.
UPDATE "orders" o
SET "payment_status" = p."status", "payment_method" = CASE WHEN p."status" = 'SUCCEEDED' THEN 'TEST_CARD_SUCCESS' ELSE 'TEST_CARD_DECLINE' END
FROM "payments" p
WHERE p."order_id" = o."id";

UPDATE "orders" SET "status_reason" = 'payment_declined' WHERE "status" = 'CANCELLED' AND "status_reason" IS NULL;
