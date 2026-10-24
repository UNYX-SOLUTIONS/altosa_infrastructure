-- Migración idempotente: Retailer ID del catálogo de Meta (WhatsApp Commerce).
-- Se aplica con scripts/apply-meta-retailer-migration.sh (no con prisma migrate).
-- Meta exige como `product_retailer_id` el Retailer ID de su catálogo, que no
-- coincide con el SKU interno (`product_variants.sku`). La columna es nullable:
-- solo se llena para las variantes publicadas en el catálogo de Meta.

ALTER TABLE product_variants
  ADD COLUMN IF NOT EXISTS meta_retailer_id TEXT;

CREATE INDEX IF NOT EXISTS product_variants_meta_retailer_id_idx
  ON product_variants (meta_retailer_id);
