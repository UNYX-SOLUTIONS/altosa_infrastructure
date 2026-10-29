-- Migración idempotente: referencia plana a Contifico por variante.
-- Se aplica con scripts/apply-contifico-migration.sh (no con prisma migrate).
--
-- En Altosa una variante pertenece a un producto padre; en Contifico cada
-- variante es un producto independiente (código/SKU propio). Guardamos ambos
-- datos: el id del producto en Contifico y su código para búsquedas/reportes.

ALTER TABLE product_variants
  ADD COLUMN IF NOT EXISTS contifico_id TEXT;

ALTER TABLE product_variants
  ADD COLUMN IF NOT EXISTS contifico_sku TEXT;

-- Un producto de Contifico no puede estar mapeado a dos variantes de Altosa.
-- Índice funcional para comparar sin espacios ni mayúsculas; NULL no colisiona.
DROP INDEX IF EXISTS product_variants_contifico_id_idx;

CREATE UNIQUE INDEX IF NOT EXISTS product_variants_contifico_id_key
  ON product_variants (LOWER(TRIM(contifico_id)))
  WHERE contifico_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS product_variants_contifico_sku_idx
  ON product_variants (contifico_sku);
