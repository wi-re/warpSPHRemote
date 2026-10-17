import { useRef, useState, type InputHTMLAttributes } from "react";
import { dragNumber } from "./numberDrag";
type Props = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type" | "onChange" | "value"
> & {
  value: number;
  onValueChange: (value: number) => void;
};
export function NumberControl({
  value,
  onValueChange,
  step,
  min,
  max,
  disabled,
  ...props
}: Props) {
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{
    pointer: number;
    x: number;
    y: number;
    time: number;
    value: number;
    start: number;
    step: number;
  } | null>(null);
  const unit = () =>
    step === "any"
      ? Math.max(0.000001, Math.abs(value) * 0.01 || 0.01)
      : Number(step ?? 1);
  const lower = min === undefined ? -Infinity : Number(min),
    upper = max === undefined ? Infinity : Number(max);
  const label =
    props["aria-label"] ?? props.id?.replaceAll("-", " ") ?? "value";
  const end = (cancel = false) => {
    if (cancel && drag.current) onValueChange(drag.current.start);
    drag.current = null;
    setDragging(false);
  };
  return (
    <span className={`number-control ${dragging ? "is-dragging" : ""}`}>
      <input
        {...props}
        type="number"
        step={step}
        min={min}
        max={max}
        disabled={disabled}
        value={value}
        onChange={(e) => {
          if (e.target.value !== "" && Number.isFinite(e.target.valueAsNumber))
            onValueChange(e.target.valueAsNumber);
        }}
      />
      <button
        type="button"
        className="number-drag-handle"
        disabled={disabled}
        aria-label={`Drag to adjust ${label}`}
        title="Drag up/down to adjust. Move farther sideways or drag faster to accelerate. Shift for precision; Escape cancels. You can also type directly."
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.currentTarget.focus();
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = {
            pointer: e.pointerId,
            x: e.clientX,
            y: e.clientY,
            time: e.timeStamp,
            value,
            start: value,
            step: unit(),
          };
          setDragging(true);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d || d.pointer !== e.pointerId) return;
          const next = dragNumber(
            d.value,
            e.clientY - d.y,
            e.clientX - d.x,
            e.timeStamp - d.time,
            d.step,
            lower,
            upper,
            e.shiftKey,
          );
          d.value = next.accumulator;
          d.y = e.clientY;
          d.time = e.timeStamp;
          onValueChange(Math.max(lower, Math.min(upper, next.value)));
        }}
        onPointerUp={() => end()}
        onPointerCancel={() => end(true)}
        onLostPointerCapture={() => end()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            end(true);
            return;
          }
          const direction =
            e.key === "ArrowUp" || e.key === "PageUp"
              ? 1
              : e.key === "ArrowDown" || e.key === "PageDown"
                ? -1
                : 0;
          if (direction) {
            e.preventDefault();
            onValueChange(
              Math.max(
                lower,
                Math.min(
                  upper,
                  value +
                    direction * unit() * (e.key.startsWith("Page") ? 10 : 1),
                ),
              ),
            );
          }
        }}
      >
        ↕
      </button>
    </span>
  );
}
