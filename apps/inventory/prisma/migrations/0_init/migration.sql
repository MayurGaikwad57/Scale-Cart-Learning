-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('HELD', 'COMMITTED', 'RELEASED');

-- CreateTable
CREATE TABLE "inventory" (
    "product_id" UUID NOT NULL,
    "available" INTEGER NOT NULL,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "inventory_pkey" PRIMARY KEY ("product_id")
);

-- CreateTable
CREATE TABLE "product_info" (
    "product_id" UUID NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_info_pkey" PRIMARY KEY ("product_id")
);

-- CreateTable
CREATE TABLE "stock_alerts" (
    "product_id" UUID NOT NULL,
    "available" INTEGER NOT NULL,
    "last_order_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_alerts_pkey" PRIMARY KEY ("product_id")
);

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

-- CreateTable
CREATE TABLE "processed_events" (
    "consumer_group" TEXT NOT NULL,
    "event_id" UUID NOT NULL,
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_events_pkey" PRIMARY KEY ("consumer_group","event_id")
);

-- CreateIndex
CREATE INDEX "reservations_status_created_at_idx" ON "reservations"("status", "created_at");

-- AddForeignKey
ALTER TABLE "reservation_items" ADD CONSTRAINT "reservation_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "reservations"("order_id") ON DELETE CASCADE ON UPDATE CASCADE;

