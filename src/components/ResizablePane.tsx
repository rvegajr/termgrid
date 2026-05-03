import { JSX } from "solid-js";
import type { PaneLayout } from "../types/layout";

export interface EdgeOffsets {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export const ZERO_OFFSETS: EdgeOffsets = { left: 0, top: 0, right: 0, bottom: 0 };

const SNAP_THRESHOLD_PCT = 2.5; // release within ±2.5% snaps back to preset
const MIN_SIZE_PCT = 8;

interface Props {
  paneId: string;
  base: PaneLayout | (() => PaneLayout);
  offsets: EdgeOffsets | (() => EdgeOffsets);
  container: () => HTMLElement | undefined;
  onOffsetsChange: (id: string, next: EdgeOffsets) => void;
  onResetEdge?: (id: string, edge: keyof EdgeOffsets) => void;
  children: JSX.Element;
}

function resolve<T>(v: T | (() => T)): T {
  return typeof v === "function" ? (v as () => T)() : v;
}

export function ResizablePane(props: Props) {
  const rect = () => {
    const b = resolve(props.base);
    const o = resolve(props.offsets);
    return {
      left: b.x + o.left,
      top: b.y + o.top,
      width: Math.max(MIN_SIZE_PCT, b.width - o.left + o.right),
      height: Math.max(MIN_SIZE_PCT, b.height - o.top + o.bottom),
    };
  };

  function startDrag(edge: keyof EdgeOffsets, e: PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    const host = props.container();
    if (!host) return;
    const hostRect = host.getBoundingClientRect();
    const start = { ...resolve(props.offsets) };
    const startX = e.clientX;
    const startY = e.clientY;

    const onMove = (ev: PointerEvent) => {
      const dxPct = ((ev.clientX - startX) / hostRect.width) * 100;
      const dyPct = ((ev.clientY - startY) / hostRect.height) * 100;
      const next: EdgeOffsets = { ...start };
      if (edge === "left") next.left = start.left + dxPct;
      if (edge === "right") next.right = start.right + dxPct;
      if (edge === "top") next.top = start.top + dyPct;
      if (edge === "bottom") next.bottom = start.bottom + dyPct;
      props.onOffsetsChange(props.paneId, next);
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      // Snap back to preset if released close to origin on this edge
      const cur = resolve(props.offsets);
      const snapped: EdgeOffsets = { ...cur };
      (["left", "top", "right", "bottom"] as const).forEach((k) => {
        if (Math.abs(snapped[k]) < SNAP_THRESHOLD_PCT) snapped[k] = 0;
      });
      props.onOffsetsChange(props.paneId, snapped);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function resetEdge(edge: keyof EdgeOffsets, e: MouseEvent) {
    e.stopPropagation();
    props.onResetEdge?.(props.paneId, edge);
  }

  const r = rect;

  return (
    <div
      class="pane"
      style={{
        position: "absolute",
        left: `${r().left}%`,
        top: `${r().top}%`,
        width: `${r().width}%`,
        height: `${r().height}%`,
      }}
    >
      {props.children}
      <div
        class="edge edge-n"
        title="Drag to resize top edge • double-click to snap back to layout"
        onPointerDown={(e) => startDrag("top", e)}
        onDblClick={(e) => resetEdge("top", e)}
      />
      <div
        class="edge edge-s"
        title="Drag to resize bottom edge • double-click to snap back to layout"
        onPointerDown={(e) => startDrag("bottom", e)}
        onDblClick={(e) => resetEdge("bottom", e)}
      />
      <div
        class="edge edge-w"
        title="Drag to resize left edge • double-click to snap back to layout"
        onPointerDown={(e) => startDrag("left", e)}
        onDblClick={(e) => resetEdge("left", e)}
      />
      <div
        class="edge edge-e"
        title="Drag to resize right edge • double-click to snap back to layout"
        onPointerDown={(e) => startDrag("right", e)}
        onDblClick={(e) => resetEdge("right", e)}
      />
    </div>
  );
}
