-- M6.5 phase 5: products moved to the catalog service's database (copied first by
-- tools/move-products-to-catalog.ts). Order lines keep a SNAPSHOT of the product instead of a join.

-- 1. snapshot columns, filled from the products table while it still exists
ALTER TABLE "order_items" ADD COLUMN "product_name" TEXT, ADD COLUMN "product_sku" TEXT, ADD COLUMN "product_category" TEXT;
UPDATE "order_items" oi SET "product_name" = p."name", "product_sku" = p."sku", "product_category" = p."category"
  FROM "products" p WHERE p."id" = oi."product_id";
UPDATE "order_items" SET "product_name" = COALESCE("product_name", '(unknown product)'),
                         "product_sku" = COALESCE("product_sku", ''),
                         "product_category" = COALESCE("product_category", '');
ALTER TABLE "order_items" ALTER COLUMN "product_name" SET NOT NULL,
                          ALTER COLUMN "product_sku" SET NOT NULL,
                          ALTER COLUMN "product_category" SET NOT NULL;

-- 2. no foreign keys into another service's data
ALTER TABLE "cart_items" DROP CONSTRAINT "cart_items_product_id_fkey";
ALTER TABLE "order_items" DROP CONSTRAINT "order_items_product_id_fkey";

-- 3. the products now belong to the catalog service
DROP TABLE "products";
