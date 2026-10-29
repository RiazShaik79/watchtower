import type { Severity } from "@/lib/types";

const STYLES: Record<Severity, string> = {
  critical: "bg-critical-soft text-critical",
  high: "bg-high-soft text-high",
  medium: "bg-medium-soft text-medium",
  low: "bg-low-soft text-low",
};

const LABELS: Record<Severity, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };

export function SeverityBadge({ severity }: { severity: Severity }) {
  return <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${STYLES[severity]}`}>{LABELS[severity]}</span>;
}
