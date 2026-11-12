-- Migración idempotente: precio con 4 decimales e IVA por variante.
-- Se aplica con scripts/apply-variant-price-iva-migration.sh (no con prisma migrate).
--
-- Contifico admite hasta 6 decimales en pvp1; el ERP necesita 4 para precios
-- unitarios de muebles (ej. 123.4567). El IVA se guarda por variante para
-- enviarlo como porcentaje_iva al producto plano de Contifico.

ALTER TABLE product_variants
  ALTER COLUMN precio_usd TYPE NUMERIC(14, 4)
  USING precio_usd::numeric(14, 4);

ALTER TABLE product_variants
  ADD COLUMN IF NOT EXISTS porcentaje_iva SMALLINT NOT NULL DEFAULT 15;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'product_variants_porcentaje_iva_check'
      AND conrelid = 'public.product_variants'::regclass
  ) THEN
    ALTER TABLE product_variants
      ADD CONSTRAINT product_variants_porcentaje_iva_check
      CHECK (porcentaje_iva BETWEEN 0 AND 100) NOT VALID;
  END IF;
END $$;

-- Columnas calculadas: precio_usd es el subtotal sin IVA (el que se envía a
-- Contifico como pvp1). Estas columnas se recalculan automáticamente cuando
-- cambia precio_usd o porcentaje_iva, sin triggers ni lógica en la aplicación.
ALTER TABLE product_variants
  ADD COLUMN IF NOT EXISTS iva_usd NUMERIC(14, 4)
  GENERATED ALWAYS AS (
    CASE
      WHEN precio_usd IS NULL THEN NULL
      ELSE ROUND(precio_usd * porcentaje_iva / 100.0, 4)
    END
  ) STORED;

ALTER TABLE product_variants
  ADD COLUMN IF NOT EXISTS precio_con_iva NUMERIC(14, 4)
  GENERATED ALWAYS AS (
    CASE
      WHEN precio_usd IS NULL THEN NULL
      ELSE ROUND(precio_usd * (1 + porcentaje_iva / 100.0), 4)
    END
  ) STORED;

COMMENT ON COLUMN product_variants.precio_usd IS
  'Precio unitario sin IVA; se envía a Contifico como pvp1';
COMMENT ON COLUMN product_variants.porcentaje_iva IS
  'Porcentaje de IVA aplicado a la variante (0-100)';
COMMENT ON COLUMN product_variants.iva_usd IS
  'IVA calculado en USD (columna generada)';
COMMENT ON COLUMN product_variants.precio_con_iva IS
  'Precio unitario con IVA (columna generada)';
