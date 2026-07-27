export interface VariantCandidate {
  readonly id: string;
  readonly weight: number;
  readonly warmCount: number;
}

// Choose the least represented enabled variant while respecting selection weights.
export function selectVariant(
  candidates: readonly VariantCandidate[],
  random: () => number = Math.random,
): VariantCandidate {
  if (candidates.length === 0) throw new Error("No enabled variant is available");
  // Normalize by weight so a variant configured with twice the weight may keep twice the warm count.
  const bestRatio = Math.min(
    ...candidates.map((candidate) => candidate.warmCount / candidate.weight),
  );
  // Random choice is limited to equally underrepresented variants.
  const balanced = candidates.filter(
    (candidate) => candidate.warmCount / candidate.weight === bestRatio,
  );
  const totalWeight = balanced.reduce((sum, candidate) => sum + candidate.weight, 0);
  // Walk a weighted interval instead of choosing uniformly among tied variants.
  let cursor = random() * totalWeight;
  for (const candidate of balanced) {
    // Each candidate owns an interval proportional to its configured weight.
    cursor -= candidate.weight;
    if (cursor < 0) return candidate;
  }
  return balanced.at(-1)!;
}
