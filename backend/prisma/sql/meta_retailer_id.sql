-- Migración idempotente: Retailer ID del catálogo de Meta (WhatsApp Commerce).
-- Se aplica con scripts/apply-meta-retailer-migration.sh (no con prisma migrate).
-- Meta exige como `product_retailer_id` el Retailer ID de su catálogo, que no
-- coincide con el SKU interno (`product_variants.sku`). La columna es nullable:
-- solo se llena para las variantes publicadas en el catálogo de Meta.
-- `meta_mapping_locked` marca los mapeos manuales que el sync/backfill no
-- deben proponer ni sobrescribir.

ALTER TABLE product_variants
  ADD COLUMN IF NOT EXISTS meta_retailer_id TEXT;

ALTER TABLE product_variants
  ADD COLUMN IF NOT EXISTS meta_mapping_locked BOOLEAN NOT NULL DEFAULT FALSE;

-- El Retailer ID debe ser único (comparación case-insensitive, como la API).
-- Se usa un índice funcional para que variantes sin mapeo (NULL) no colisionen.
DROP INDEX IF EXISTS product_variants_meta_retailer_id_idx;

CREATE UNIQUE INDEX IF NOT EXISTS product_variants_meta_retailer_id_key
  ON product_variants (LOWER(TRIM(meta_retailer_id)));
