import type { Rectangle } from 'electron';
import type { DockPlacement, DockSide } from '../shared/desktop';

export const overlayWidth = 368;
export const overlayMinHeight = 88;

export function fitOverlay(bounds: Rectangle, area: Rectangle): Rectangle {
  const width = Math.min(bounds.width, area.width);
  const height = Math.min(bounds.height, area.height);
  return {
    x: Math.round(Math.max(area.x, Math.min(bounds.x, area.x + area.width - width))),
    y: Math.round(Math.max(area.y, Math.min(bounds.y, area.y + area.height - height))),
    width,
    height,
  };
}

export function dockAfterDrag(bounds: Rectangle, display: { id: number; workArea: Rectangle },
  previous?: DockPlacement): DockPlacement | undefined {
  const area = display.workArea;
  // The expanded window has a 12 px horizontal and 16 px vertical shadow gutter.
  const distances: Record<DockSide, number> = {
    left: Math.max(0, bounds.x + 12 - area.x),
    right: Math.max(0, area.x + area.width - (bounds.x + bounds.width - 12)),
    top: Math.max(0, bounds.y + 16 - area.y),
  };
  const nearest = (Object.keys(distances) as DockSide[]).sort((a, b) => distances[a] - distances[b])[0];
  const side = distances[nearest] <= 24 ? nearest
    : previous?.displayId === display.id && distances[previous.side] <= 48 ? previous.side : undefined;
  if (!side) return undefined;
  const offset = side === 'top' ? (bounds.x + bounds.width / 2 - area.x) / area.width
    : (bounds.y + overlayMinHeight / 2 - area.y) / area.height;
  return { side, displayId: display.id, offset: Math.max(0, Math.min(1, offset)) };
}

export function dockBounds(area: Rectangle, dock: DockPlacement, expandedHeight: number, compact: boolean): Rectangle {
  const top = dock.side === 'top';
  const width = compact ? (top ? 144 : 44) : overlayWidth;
  const height = compact ? (top ? 44 : 110) : expandedHeight;
  const x = top ? area.x + area.width * dock.offset - width / 2
    : dock.side === 'right' ? area.x + area.width - width : area.x;
  const y = top ? area.y : area.y + area.height * dock.offset - (compact ? height : overlayMinHeight) / 2;
  return fitOverlay({ x, y, width, height }, area);
}
