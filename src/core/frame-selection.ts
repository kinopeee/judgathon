import { hammingDistance } from '../media/phash.js';

/**
 * §41.4 frame selection. Pure functions; all ordering is deterministic.
 *
 * Frame records carry the system-issued frame_id, integer timestamp_ms and a
 * 64-bit pHash as bigint. `source` groups streams (Phase 0 has exactly one
 * source per run: screen or camera).
 */

export interface FrameCandidate {
  frame_id: string;
  timestamp_ms: number;
  phash: bigint;
  source: string;
}

export interface FrameSelectionResult {
  input_frame_ids: string[];
  selected_frame_ids: string[];
  frame_reference_overflow: boolean;
  /** evidence source id -> ids that could not be shown to the judge */
  unshown_source_ids: Record<string, string[]>;
}

function cmpFrames(a: FrameCandidate, b: FrameCandidate): number {
  if (a.timestamp_ms !== b.timestamp_ms) return a.timestamp_ms - b.timestamp_ms;
  return a.frame_id < b.frame_id ? -1 : a.frame_id > b.frame_id ? 1 : 0;
}

/** Step 1: drop frames within Hamming distance 8 of the last KEPT frame, per source. */
export function dedupeCandidates(
  frames: FrameCandidate[],
  threshold = 8,
): FrameCandidate[] {
  const bySource = new Map<string, FrameCandidate[]>();
  for (const f of frames) {
    const list = bySource.get(f.source) ?? [];
    list.push(f);
    bySource.set(f.source, list);
  }
  const kept: FrameCandidate[] = [];
  for (const list of bySource.values()) {
    list.sort(cmpFrames);
    let lastKept: FrameCandidate | null = null;
    for (const f of list) {
      if (lastKept === null || hammingDistance(f.phash, lastKept.phash) > threshold) {
        kept.push(f);
        lastKept = f;
      }
    }
  }
  return kept.sort(cmpFrames);
}

/** Step 2: cap the extraction candidates at maxCount via even spacing. */
export function capCandidates(frames: FrameCandidate[], maxCount = 120): FrameCandidate[] {
  const sorted = [...frames].sort(cmpFrames);
  const n = sorted.length;
  if (n <= maxCount) return sorted;
  const picked: FrameCandidate[] = [];
  for (let i = 0; i < maxCount; i++) {
    picked.push(sorted[Math.floor((i * (n - 1)) / (maxCount - 1))]!);
  }
  return picked;
}

function evenlySpaced<T>(items: T[], k: number): T[] {
  const n = items.length;
  if (k <= 0 || n === 0) return [];
  if (n <= k) return [...items];
  if (k === 1) return [items[Math.floor((n - 1) / 2)]!];
  const out: T[] = [];
  for (let i = 0; i < k; i++) {
    out.push(items[Math.floor((i * (n - 1)) / (k - 1))]!);
  }
  return out;
}

/**
 * Steps 3–5: pick at most maxPerPitch frames for the judge.
 *
 * Order: evidence-referenced frames first (timestamp/id order). If they alone
 * exceed the cap, 24 are chosen by even spacing (divisor 23) and
 * frame_reference_overflow is set — the evidence's original sources are kept
 * untouched and the judge prompt lists the unshown ids per evidence item.
 *
 * Otherwise remaining slots are filled by scene-change candidates — unselected
 * frames whose pHash distance to the previous extraction-candidate frame is
 * >8 (the first frame of a source has distance 0) — ordered by distance desc
 * then timestamp/id; finally any still-unselected candidates are filled in
 * evenly spaced from the time-ordered list.
 */
export function selectJudgeFrames(
  candidates: FrameCandidate[],
  evidenceItems: Array<{ id: string; sourceIds: string[] }>,
  maxPerPitch = 24,
): FrameSelectionResult {
  const sorted = [...candidates].sort(cmpFrames);
  const inputIds = sorted.map((f) => f.frame_id);
  const byId = new Map(sorted.map((f) => [f.frame_id, f]));

  const referenced = sorted.filter((f) =>
    evidenceItems.some((e) => e.sourceIds.includes(f.frame_id)),
  );

  const result: FrameSelectionResult = {
    input_frame_ids: inputIds,
    selected_frame_ids: [],
    frame_reference_overflow: false,
    unshown_source_ids: {},
  };

  let selected: FrameCandidate[];
  if (referenced.length > maxPerPitch) {
    selected = evenlySpaced(referenced, maxPerPitch);
    result.frame_reference_overflow = true;
    const selectedSet = new Set(selected.map((f) => f.frame_id));
    for (const e of evidenceItems) {
      const unshown = e.sourceIds.filter((id) => {
        const f = byId.get(id);
        return f !== undefined && !selectedSet.has(id);
      });
      if (unshown.length > 0) result.unshown_source_ids[e.id] = unshown;
    }
  } else {
    const chosen = new Map<string, FrameCandidate>();
    for (const f of referenced) chosen.set(f.frame_id, f);

    // Scene-change candidates: distance to the previous extraction-candidate
    // frame (within the same source) > 8. First frame of a source has
    // distance 0, so it never qualifies via this rule.
    const prevOf = new Map<string, FrameCandidate | null>();
    for (const f of sorted) {
      const prior = sorted.filter(
        (x) => x.source === f.source && cmpFrames(x, f) < 0,
      );
      prevOf.set(f.frame_id, prior.length > 0 ? prior[prior.length - 1]! : null);
    }
    const sceneChanges = sorted
      .filter((f) => !chosen.has(f.frame_id))
      .map((f) => {
        const prev = prevOf.get(f.frame_id) ?? null;
        const dist = prev === null ? 0 : hammingDistance(f.phash, prev.phash);
        return { f, dist };
      })
      .filter((x) => x.dist > 8)
      .sort((a, b) => (b.dist !== a.dist ? b.dist - a.dist : cmpFrames(a.f, b.f)));

    for (const { f } of sceneChanges) {
      if (chosen.size >= maxPerPitch) break;
      chosen.set(f.frame_id, f);
    }

    if (chosen.size < maxPerPitch) {
      const remaining = sorted.filter((f) => !chosen.has(f.frame_id));
      for (const f of evenlySpaced(remaining, maxPerPitch - chosen.size)) {
        chosen.set(f.frame_id, f);
      }
    }
    selected = [...chosen.values()];
  }

  selected.sort(cmpFrames);
  result.selected_frame_ids = selected.map((f) => f.frame_id);
  return result;
}
