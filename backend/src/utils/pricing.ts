export const DEFAULT_IVA_PERCENTAGE = 15;

function finiteNumber(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function ivaPercentage(porcentajeIva: number | null | undefined): number {
  return porcentajeIva === null || porcentajeIva === undefined
    ? DEFAULT_IVA_PERCENTAGE
    : porcentajeIva;
}

export function computeIvaUsd(
  precioUsd: number | null | undefined,
  porcentajeIva: number | null | undefined
): number | null {
  const base = finiteNumber(precioUsd);
  if (base === null) return null;
  return Math.round(base * ivaPercentage(porcentajeIva) * 100) / 10000;
}

export function computePrecioConIva(
  precioUsd: number | null | undefined,
  porcentajeIva: number | null | undefined
): number | null {
  const base = finiteNumber(precioUsd);
  if (base === null) return null;
  return Math.round(base * (1 + ivaPercentage(porcentajeIva) / 100) * 10000) / 10000;
}

export function computePrecioSinIva(
  precioConIva: number | null | undefined,
  porcentajeIva: number | null | undefined
): number | null {
  const total = finiteNumber(precioConIva);
  if (total === null) return null;
  return Math.round((total / (1 + ivaPercentage(porcentajeIva) / 100)) * 10000) / 10000;
}
