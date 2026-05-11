export type AnalysisMode = "best" | "practical" | "training";

export type EngineScore =
  | { type: "cp"; value: number }
  | { type: "mate"; value: number };

export type CandidateMove = {
  multipv: number;
  depth: number;
  move: string;
  score: EngineScore;
  pv: string[];
};

export type RecommendationResult = {
  candidate: CandidateMove | null;
  mode: AnalysisMode;
  evaluationLoss: number | null;
  usedFallback: boolean;
};

const MATE_SCORE = 100000;

function scoreForSideToMove(score: EngineScore) {
  if (score.type === "cp") {
    return score.value;
  }

  if (score.value > 0) {
    return MATE_SCORE - Math.abs(score.value) * 100;
  }

  return -MATE_SCORE + Math.abs(score.value) * 100;
}

function isLosingMate(score: EngineScore) {
  return score.type === "mate" && score.value < 0;
}

function evaluationLossFromBest(best: CandidateMove, candidate: CandidateMove) {
  return Math.max(
    0,
    scoreForSideToMove(best.score) - scoreForSideToMove(candidate.score),
  );
}

function sortCandidates(candidates: CandidateMove[]) {
  return [...candidates].sort((a, b) => a.multipv - b.multipv);
}

function isSafeCandidate(
  best: CandidateMove,
  candidate: CandidateMove,
  maxLoss: number,
) {
  if (evaluationLossFromBest(best, candidate) > maxLoss) {
    return false;
  }

  if (!isLosingMate(best.score) && isLosingMate(candidate.score)) {
    return false;
  }

  return true;
}

function weightedSelect(
  candidates: CandidateMove[],
  weightsByRank: Record<number, number>,
  random: () => number,
) {
  const weightedCandidates = candidates
    .map((candidate) => ({
      candidate,
      weight: weightsByRank[candidate.multipv] ?? 0,
    }))
    .filter(({ weight }) => weight > 0);

  const totalWeight = weightedCandidates.reduce(
    (sum, { weight }) => sum + weight,
    0,
  );

  if (!totalWeight) {
    return candidates[0] ?? null;
  }

  let threshold = random() * totalWeight;
  for (const { candidate, weight } of weightedCandidates) {
    threshold -= weight;
    if (threshold <= 0) {
      return candidate;
    }
  }

  return weightedCandidates.at(-1)?.candidate ?? candidates[0] ?? null;
}

function recommendationForCandidate(
  candidate: CandidateMove | null,
  best: CandidateMove | null,
  mode: AnalysisMode,
  usedFallback = false,
): RecommendationResult {
  return {
    candidate,
    mode,
    evaluationLoss: candidate && best ? evaluationLossFromBest(best, candidate) : null,
    usedFallback,
  };
}

function selectPracticalMove(
  sortedCandidates: CandidateMove[],
  random: () => number,
  usedFallback = false,
) {
  const best = sortedCandidates[0] ?? null;
  if (!best) {
    return recommendationForCandidate(null, null, "practical", usedFallback);
  }

  const safeCandidates = sortedCandidates.filter((candidate) =>
    isSafeCandidate(best, candidate, 120),
  );
  const preferredCandidates = safeCandidates.filter(
    (candidate) => candidate.multipv >= 2 && candidate.multipv <= 4,
  );

  if (preferredCandidates.length) {
    const occasionalBest =
      safeCandidates.find((candidate) => candidate.multipv === 1) ?? null;
    const pool = occasionalBest
      ? [...preferredCandidates, occasionalBest]
      : preferredCandidates;
    const selected = weightedSelect(
      pool,
      { 1: 0.08, 2: 0.55, 3: 0.28, 4: 0.09 },
      random,
    );

    return recommendationForCandidate(selected, best, "practical", usedFallback);
  }

  return recommendationForCandidate(best, best, "practical", true);
}

function selectTrainingMove(sortedCandidates: CandidateMove[], random: () => number) {
  const best = sortedCandidates[0] ?? null;
  if (!best) {
    return recommendationForCandidate(null, null, "training");
  }

  const safeCandidates = sortedCandidates.filter((candidate) =>
    isSafeCandidate(best, candidate, 250),
  );
  const preferredCandidates = safeCandidates.filter(
    (candidate) => candidate.multipv >= 3 && candidate.multipv <= 6,
  );

  if (preferredCandidates.length) {
    const selected = weightedSelect(
      preferredCandidates,
      { 3: 0.4, 4: 0.3, 5: 0.2, 6: 0.1 },
      random,
    );

    return recommendationForCandidate(selected, best, "training");
  }

  return selectPracticalMove(sortedCandidates, random, true);
}

export function selectRecommendedMove(
  candidates: CandidateMove[],
  mode: AnalysisMode,
  random: () => number = Math.random,
): RecommendationResult {
  const sortedCandidates = sortCandidates(candidates);
  const best = sortedCandidates[0] ?? null;

  if (mode === "best") {
    return recommendationForCandidate(best, best, "best");
  }

  if (mode === "training") {
    return selectTrainingMove(sortedCandidates, random);
  }

  return selectPracticalMove(sortedCandidates, random);
}

export function getEvaluationLoss(
  best: CandidateMove | null,
  candidate: CandidateMove | null,
) {
  return best && candidate ? evaluationLossFromBest(best, candidate) : null;
}
