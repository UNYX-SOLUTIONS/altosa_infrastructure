-- Migración idempotente: plantillas de Kommo y asociación a productos.
-- Se aplica con scripts/apply-kommo-migration.sh (no con prisma migrate).

CREATE TABLE IF NOT EXISTS kommo_templates (
  id          TEXT PRIMARY KEY,
  kommo_id    INTEGER NOT NULL,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'amocrm',
  content     TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS kommo_templates_kommo_id_key
  ON kommo_templates (kommo_id);

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS kommo_template_id TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'products_kommo_template_id_fkey'
  ) THEN
    ALTER TABLE products
      ADD CONSTRAINT products_kommo_template_id_fkey
      FOREIGN KEY (kommo_template_id)
      REFERENCES kommo_templates (id)
      ON DELETE SET NULL
      ON UPDATE CASCADE;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS products_kommo_template_id_idx
  ON products (kommo_template_id);

ALTER TABLE product_variants
  ADD COLUMN IF NOT EXISTS kommo_template_id TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'product_variants_kommo_template_id_fkey'
  ) THEN
    ALTER TABLE product_variants
      ADD CONSTRAINT product_variants_kommo_template_id_fkey
      FOREIGN KEY (kommo_template_id)
      REFERENCES kommo_templates (id)
      ON DELETE SET NULL
      ON UPDATE CASCADE;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS product_variants_kommo_template_id_idx
  ON product_variants (kommo_template_id);
