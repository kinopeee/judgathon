/**
 * Judge-input team-name masking (§41.6). When `judges[0].name_masking` is
 * enabled, occurrences of `チーム<Name>` / `Team <Name>` in the transcript
 * segments and evidence descriptions sent to the judge are replaced with
 * deterministic letter labels. Persisted artifacts stay verbatim.
 */

export const TEAM_NAME_PATTERNS: readonly RegExp[] = [
  /チーム([A-Za-z0-9ァ-ヴー][A-Za-z0-9ァ-ヴー_-]*)/g,
  /\bTeam ([A-Za-z][A-Za-z0-9_-]*)/gi,
];

/** Excel-style label: 0 -> A, 25 -> Z, 26 -> AA, 27 -> AB. */
function labelFor(index: number): string {
  let n = index;
  let s = '';
  for (;;) {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
    if (n < 0) return s;
  }
}

/**
 * Build the replacement table from `texts` scanned in order. The key is the
 * full matched string as written (e.g. `チームGoogle`, `Team Phoenix`); the
 * value is the written prefix plus the label assigned to the captured name
 * (case-sensitive, first-occurrence order).
 */
export function buildNameMaskMap(texts: string[]): Map<string, string> {
  const map = new Map<string, string>();
  const labels = new Map<string, string>();
  for (const text of texts) {
    for (const pattern of TEAM_NAME_PATTERNS) {
      const re = new RegExp(pattern.source, pattern.flags);
      for (const m of text.matchAll(re)) {
        const full = m[0];
        const name = m[1]!;
        if (map.has(full)) continue;
        let label = labels.get(name);
        if (label === undefined) {
          label = labelFor(labels.size);
          labels.set(name, label);
        }
        map.set(full, full.slice(0, full.length - name.length) + label);
      }
    }
  }
  return map;
}

/** Apply a table built by buildNameMaskMap; unknown matches pass through. */
export function applyNameMask(text: string, map: Map<string, string>): string {
  if (map.size === 0) return text;
  let out = text;
  for (const pattern of TEAM_NAME_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    out = out.replace(re, (full) => map.get(full) ?? full);
  }
  return out;
}
