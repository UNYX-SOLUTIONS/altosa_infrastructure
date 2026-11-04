-- Migración idempotente: nombre completo visible de la variante.
-- Se aplica con scripts/apply-variant-nombre-migration.sh (no con prisma migrate).
--
-- `color` sigue siendo el atributo de color/acabado (puede ser NULL en bases).
-- `nombre` es el texto que se muestra en el ERP, por ejemplo:
--   "La Silla Sandy Gris", "La Silla Nicole Blanco con gris",
--   "Base Redonda 45 × 77 × 43 cm".
--
-- La columna es nullable para permitir el despliegue sin bloquear la API;
-- el backfill (backfill:variant-names) la llena para las variantes existentes
-- y las altas nuevas la generan desde producto + color.

ALTER TABLE product_variants
  ADD COLUMN IF NOT EXISTS nombre TEXT;

CREATE INDEX IF NOT EXISTS product_variants_nombre_idx
  ON product_variants (nombre);
