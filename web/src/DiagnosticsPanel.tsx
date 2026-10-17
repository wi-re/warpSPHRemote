import type { Diagnostic, DiagnosticMetric } from "./types";
import { metricDefinitions } from "./metrics";
import { formatNumber } from "./data";
export function DiagnosticsPanel({
  current,
  metrics,
  onChange,
  onSelect,
}: {
  current: Diagnostic | undefined;
  metrics: DiagnosticMetric[];
  onChange: (keys: DiagnosticMetric[]) => void;
  onSelect: (key: DiagnosticMetric) => void;
}) {
  return (
    <section className="inspector-section metric-panel">
      <div className="section-heading">
        <span>FLUID DIAGNOSTICS</span>
        <details className="metric-adder">
          <summary aria-label="Add diagnostic metric">+</summary>
          <div role="group" aria-label="Available metrics">
            {Object.entries(metricDefinitions)
              .filter(([id]) => !metrics.includes(id as DiagnosticMetric))
              .map(([id, info]) => (
                <button
                  aria-label={`Add ${info.label}`}
                  key={id}
                  onClick={(e) => {
                    onChange([...metrics, id as DiagnosticMetric]);
                    const details = e.currentTarget.closest("details");
                    if (details) details.open = false;
                  }}
                >
                  + {info.label}
                </button>
              ))}
          </div>
        </details>
      </div>
      <div className="metric-cards">
        {metrics.map((id) => (
          <div className="metric-card" key={id}>
            <button className="metric-value" onClick={() => onSelect(id)}>
              <span>{metricDefinitions[id].label}</span>
              <strong>
                {current?.[id] != null ? formatNumber(current[id]!, 6) : "—"}
              </strong>
              <small>{metricDefinitions[id].formula}</small>
            </button>
            <button
              className="remove-metric"
              aria-label={`Remove ${metricDefinitions[id].label}`}
              onClick={() => onChange(metrics.filter((key) => key !== id))}
            >
              −
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
