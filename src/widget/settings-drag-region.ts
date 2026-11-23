const passes = new WeakMap<DragRegionTarget, number>();

export interface DragRegionTarget {
  readonly offsetWidth: number;
  readonly offsetHeight: number;
  style: {
    width: string;
    setProperty(property: string, value: string): void;
    removeProperty(property: string): string;
  };
}

function republish(header: DragRegionTarget): void {
  const width = header.style.width;
  header.style.setProperty('-webkit-app-region', 'no-drag');
  try {
    // Blink publishes these hit regions from layout, and app-region alone does
    // not invalidate it. Pin the current border-box width so the forced layout
    // does not move or resize the title bar, then drop the inline overrides.
    const same = `${header.offsetWidth}px`;
    header.style.width = width === same ? `${header.offsetWidth + 1}px` : same;
    void header.offsetHeight;
  } finally {
    header.style.width = width;
    header.style.removeProperty('-webkit-app-region');
    void header.offsetHeight;
  }
}

/**
 * Republish the settings title bar now, and once more on the next frame in
 * case the restored viewport arrives after the first layout. Stylesheet
 * `drag` / `no-drag` rules are left in place, including the button rules.
 */
export function refreshSettingsDragRegion(header: DragRegionTarget, schedule: (run: () => void) => void): void {
  const pass = (passes.get(header) ?? 0) + 1;
  passes.set(header, pass);
  republish(header);
  schedule(() => {
    if (passes.get(header) !== pass) return;
    republish(header);
  });
}
