export type {
  AiAnalysisResult,
  AiAnalyzer,
  AnalysisEvidenceBundle,
  IssueClassification,
} from "./types.js";
export {
  AiAnalysisResultSchema,
  IssueClassificationSchema,
} from "./types.js";
export { HeuristicAiAnalyzer } from "./heuristic-analyzer.js";

import { HeuristicAiAnalyzer } from "./heuristic-analyzer.js";
import type { AiAnalyzer } from "./types.js";

/** Factory — Phase 2 uses local heuristics only (no cloud). */
export function createAiAnalyzer(_options?: {
  provider?: string;
}): AiAnalyzer {
  // Future: local OpenAI-compatible endpoint could be plugged here.
  // Phase 2 deliberately does not call remote cloud services.
  return new HeuristicAiAnalyzer();
}
