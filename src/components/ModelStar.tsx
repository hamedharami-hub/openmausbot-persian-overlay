import { Star } from "lucide-react";
import { modelStarKey, toggleModelStar, useModelStars } from "@/lib/model-stars";

export function ModelStar({ instanceId, modelId, label }: { instanceId: string; modelId: string; label: string }) {
  const starred = useModelStars().has(modelStarKey(instanceId, modelId));
  return <button type="button" aria-label={`${starred ? "Unstar" : "Star"} ${label}`} aria-pressed={starred}
    className="shrink-0 rounded p-2 text-ink-tertiary hover:text-accent focus-visible:outline focus-visible:outline-accent"
    onClick={() => toggleModelStar(instanceId, modelId)}>
    <Star size={14} fill={starred ? "currentColor" : "none"} aria-hidden="true" />
  </button>;
}
