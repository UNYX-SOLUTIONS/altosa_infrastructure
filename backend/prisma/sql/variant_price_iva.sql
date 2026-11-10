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
