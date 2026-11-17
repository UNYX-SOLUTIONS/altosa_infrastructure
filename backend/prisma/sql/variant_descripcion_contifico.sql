-- Descripción exclusiva para Contifico. La descripción comercial/IA sigue en
-- product_variants.descripcion. Si esta columna queda vacía, Contifico recibe
-- el producto sin descripción.

ALTER TABLE product_variants
  ADD COLUMN IF NOT EXISTS descripcion_contifico TEXT;

COMMENT ON COLUMN product_variants.descripcion IS
  'Descripción comercial usada por IA/catálogo; no se envía a Contifico';
COMMENT ON COLUMN product_variants.descripcion_contifico IS
  'Descripción que se envía a Contifico; vacía = sin descripción';
