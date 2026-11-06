-- Migración idempotente: palabras clave/sinónimos comerciales editables.
-- Se guarda un arreglo JSON en texto para no alterar el resto del esquema.
--
-- NULL  = el producto nunca tuvo palabras clave propias; el ERP muestra
--         sugerencias derivadas de nombre/categoría/variantes.
-- '[]'  = el usuario borró todas las palabras clave.
-- '["..."]' = palabras clave guardadas.

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS palabras_clave TEXT;

COMMENT ON COLUMN products.palabras_clave IS
  'Arreglo JSON de palabras clave/sinónimos comerciales editables del producto.';
