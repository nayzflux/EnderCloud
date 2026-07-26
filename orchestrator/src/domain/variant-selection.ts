export interface VariantCandidate {
  readonly id: string;
  readonly weight: number;
  readonly warmCount: number;
}

export function selectVariant(
  candidates: readonly VariantCandidate[],
  random: () => number = Math.random,
): VariantCandidate {
  if (candidates.length === 0) throw new Error("No enabled variant is available");
  const bestRatio = Math.min(
    ...candidates.map((candidate) => candidate.warmCount / candidate.weight),
  );
  const balanced = candidates.filter(
    (candidate) => candidate.warmCount / candidate.weight === bestRatio,
  );
  const totalWeight = balanced.reduce((sum, candidate) => sum + candidate.weight, 0);
  let cursor = random() * totalWeight;
  for (const candidate of balanced) {
    cursor -= candidate.weight;
    if (cursor < 0) return candidate;
  }
  return balanced.at(-1)!;
}
