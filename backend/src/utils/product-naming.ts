export function normalizeLooseText(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Nombre plano para catálogos externos (Meta/Contifico): producto padre +
 * color/variante, salvo que la variante no aporte un sufijo real.
 */
export function buildFlatName(productName: string, variantColor: string | null): string {
  const base = productName.trim();
  const suffix = variantColor?.trim();
  if (!suffix || /^est[aá]ndar$/i.test(suffix)) {
    return base;
  }
  return normalizeLooseText(base).includes(normalizeLooseText(suffix))
    ? base
    : `${base} ${suffix}`;
}

/**
 * Heurística para agrupar ítems planos ("Silla Sandy Azul" -> "Silla Sandy").
 * El nombre plano externo no distingue padre/variante; se quita la última
 * palabra cuando hay 3+ tokens y se usa el resto como producto padre.
 */
export function inferBaseName(name: string): string {
  const tokens = name.trim().split(/\s+/).filter(Boolean);
  return tokens.length >= 3 ? tokens.slice(0, -1).join(' ') : name.trim();
}

export function inferVariantColor(name: string, baseName: string): string {
  const trimmed = name.trim();
  const base = baseName.trim();
  if (!base) {
    return trimmed;
  }
  return trimmed.toLowerCase().startsWith(base.toLowerCase())
    ? trimmed.slice(base.length).trim() || trimmed
    : trimmed;
}
