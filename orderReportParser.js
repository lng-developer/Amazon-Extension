export function parseTSV(value) {
  const lines = String(value || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim());
  return { rows: lines.slice(1) };
}
