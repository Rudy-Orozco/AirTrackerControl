/** The built-in procedures for `airport` (public/procedures/<CODE>.json, made by scripts/build_procedures.py), or null if it has none. */
export async function fetchBuiltInProcedures(airport: string): Promise<unknown> {
  const res = await fetch(`/procedures/${airport}.json`)
  return res.ok ? res.json() : null
}
