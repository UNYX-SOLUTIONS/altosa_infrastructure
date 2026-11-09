ALTER TABLE categories
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE categories
  ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE categories
  ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;

ALTER TABLE subcategories
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE subcategories
  ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE subcategories
  ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;

DO $$
DECLARE
  otros_id INTEGER;
BEGIN
  SELECT id_categoria INTO otros_id
  FROM categories
  WHERE lower(nombre) = 'otros'
  LIMIT 1;

  IF otros_id IS NULL THEN
    SELECT id_categoria INTO otros_id
    FROM categories
    WHERE lower(nombre) = 'otro'
    LIMIT 1;

    IF otros_id IS NOT NULL THEN
      UPDATE categories
      SET nombre = 'Otros', updated_at = now()
      WHERE id_categoria = otros_id;
    END IF;
  END IF;

  IF otros_id IS NULL THEN
    INSERT INTO categories (nombre, is_active, is_system, sort_order, created_at, updated_at)
    VALUES ('Otros', TRUE, TRUE, 5, now(), now())
    RETURNING id_categoria INTO otros_id;
  END IF;

  UPDATE categories
  SET is_system = TRUE, is_active = TRUE, updated_at = now()
  WHERE id_categoria = otros_id;

  IF NOT EXISTS (
    SELECT 1 FROM subcategories
    WHERE id_categoria = otros_id AND lower(nombre) = 'otros'
  ) THEN
    UPDATE subcategories
    SET nombre = 'Otros', is_system = TRUE, is_active = TRUE, updated_at = now()
    WHERE id_categoria = otros_id AND lower(nombre) = 'otro';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM subcategories
    WHERE id_categoria = otros_id AND lower(nombre) = 'otros'
  ) THEN
    INSERT INTO subcategories (id_categoria, nombre, is_active, is_system, sort_order, created_at, updated_at)
    VALUES (otros_id, 'Otros', TRUE, TRUE, 1, now(), now());
  END IF;

  UPDATE subcategories
  SET is_system = TRUE, is_active = TRUE, updated_at = now()
  WHERE id_categoria = otros_id AND lower(nombre) = 'otros';
END $$;

UPDATE categories
SET is_active = FALSE, is_system = TRUE, updated_at = now()
WHERE lower(nombre) = 'otro';

UPDATE subcategories
SET is_active = FALSE, is_system = TRUE, updated_at = now()
WHERE lower(nombre) = 'otro';

UPDATE categories
SET
  sort_order = CASE lower(nombre)
    WHEN 'sillas' THEN 1
    WHEN 'taburetes' THEN 2
    WHEN 'bases' THEN 3
    WHEN 'mesas' THEN 4
    WHEN 'otros' THEN 5
    ELSE sort_order
  END,
  is_system = CASE
    WHEN lower(nombre) = 'otros' THEN TRUE
    WHEN lower(nombre) IN ('sillas', 'taburetes', 'bases', 'mesas') THEN FALSE
    ELSE is_system
  END,
  is_active = CASE
    WHEN lower(nombre) = 'otros' THEN TRUE
    ELSE is_active
  END,
  updated_at = now()
WHERE lower(nombre) IN ('sillas', 'taburetes', 'bases', 'mesas', 'otros');

UPDATE subcategories s
SET
  sort_order = CASE lower(s.nombre)
    WHEN 'sillas tapizadas' THEN 1
    WHEN 'sillas de plastico' THEN 2
    WHEN 'sillas de oficina' THEN 3
    WHEN 'sillas bistro y exterior' THEN 4
    ELSE s.sort_order
  END,
  is_system = FALSE,
  updated_at = now()
FROM categories c
WHERE s.id_categoria = c.id_categoria
  AND lower(c.nombre) = 'sillas'
  AND lower(s.nombre) IN (
    'sillas tapizadas',
    'sillas de plastico',
    'sillas de oficina',
    'sillas bistro y exterior'
  );

UPDATE subcategories s
SET sort_order = 1, is_system = FALSE, updated_at = now()
FROM categories c
WHERE s.id_categoria = c.id_categoria
  AND lower(c.nombre) = 'taburetes'
  AND lower(s.nombre) = 'taburetes';

UPDATE subcategories s
SET sort_order = 1, is_system = FALSE, updated_at = now()
FROM categories c
WHERE s.id_categoria = c.id_categoria
  AND lower(c.nombre) = 'bases'
  AND lower(s.nombre) = 'bases';

UPDATE subcategories s
SET sort_order = 1, is_system = FALSE, updated_at = now()
FROM categories c
WHERE s.id_categoria = c.id_categoria
  AND lower(c.nombre) = 'mesas'
  AND lower(s.nombre) = 'mesas';

UPDATE subcategories s
SET sort_order = 1, is_system = TRUE, is_active = TRUE, updated_at = now()
FROM categories c
WHERE s.id_categoria = c.id_categoria
  AND lower(c.nombre) = 'otros'
  AND lower(s.nombre) = 'otros';

CREATE UNIQUE INDEX IF NOT EXISTS categories_nombre_lower_key
  ON categories (lower(nombre));

CREATE UNIQUE INDEX IF NOT EXISTS subcategories_categoria_nombre_lower_key
  ON subcategories (id_categoria, lower(nombre));
