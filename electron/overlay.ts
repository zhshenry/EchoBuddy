import { BrowserWindow, screen, systemPreferences, type Point } from 'electron';
import type { DockMotion, DockPlacement, OverlayDock, OverlayPointer } from '../shared/desktop';
import type { SavedPreferences } from './preferences';
import { dockAfterDrag, dockBounds, fitOverlay, overlayMinHeight as minHeight, overlayWidth as width } from './overlay-position';

export function createOverlay(
  preload: string, icon: string, saved: Pick<SavedPreferences, 'position' | 'dock' | 'dockOnEdge'>,
  remember: (position: Point, dock?: DockPlacement) => void,
) {
  const display = saved.position ? screen.getDisplayNearestPoint(saved.position) : screen.getPrimaryDisplay();
  let anchor = saved.position ?? { x: display.workArea.x + display.workArea.width - width - 20, y: display.workArea.y + 68 };
  let height = minHeight;
  let dockOnEdge = saved.dockOnEdge;
  let dock = dockOnEdge ? saved.dock : undefined;
  let compact = !!dock;
  let dragging = false;
  let collapseArmed = false;
  let outsideSince: number | undefined;
  let panelOpen = false;
  let needsAttention = false;
  let motion: DockMotion | undefined;
  let motionTimer: NodeJS.Timeout | undefined;
  let motionId = 0;

  const window = new BrowserWindow({
    x: anchor.x, y: anchor.y, width, height, minWidth: width, minHeight,
    show: false, frame: false, transparent: true, resizable: false, fullscreenable: false, maximizable: false,
    alwaysOnTop: true, focusable: false, skipTaskbar: true, hasShadow: false, title: 'EchoBuddy', icon,
    webPreferences: {
      preload, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false,
      backgroundThrottling: false,
    },
  });
  window.setAlwaysOnTop(true, 'floating');

  function snapshot(): OverlayDock {
    if (!dock) return null;
    if (motion) return { side: dock.side, compact, motion };
    return { side: dock.side, compact, ...(compact && { compactBounds: dockFrame(dock).compact }) };
  }
  function publishDock() { window.webContents.send('overlay:dock', snapshot()); }

  function dockDisplay() {
    return screen.getAllDisplays().find(item => item.id === dock?.displayId) ?? screen.getPrimaryDisplay();
  }

  function dockFrame(placement: DockPlacement) {
    const { workArea } = dockDisplay();
    const small = dockBounds(workArea, placement, height, true);
    const large = dockBounds(workArea, placement, height, false);
    const x = Math.min(small.x, large.x), y = Math.min(small.y, large.y);
    const frameWidth = Math.max(small.x + small.width, large.x + large.width) - x;
    const frameHeight = Math.max(small.y + small.height, large.y + large.height) - y;
    return {
      frame: { x, y, width: frameWidth, height: frameHeight },
      compact: { ...small, x: small.x - x, y: small.y - y },
      expanded: { ...large, x: large.x - x, y: large.y - y },
    };
  }

  function place() {
    clearTimeout(motionTimer);
    motion = undefined;
    const activeDisplay = dock ? dockDisplay()
      : screen.getDisplayNearestPoint({ x: anchor.x + width / 2, y: anchor.y + minHeight / 2 });
    const { workArea } = activeDisplay;
    if (dock && activeDisplay.id !== dock.displayId) {
      dock = { ...dock, displayId: activeDisplay.id };
      remember(anchor, dock);
    }
    const bounds = dock ? dockBounds(workArea, dock, height, compact) : fitOverlay({ ...anchor, width, height }, workArea);
    window.setMinimumSize(bounds.width, compact ? bounds.height : Math.min(minHeight, bounds.height));
    window.setBounds(bounds);
  }

  function finishDockMotion(id: number) {
    if (motion?.id !== id) return;
    place();
    publishDock();
    syncPointerTracking();
  }

  function setCompact(next: boolean) {
    if (!dock || next === compact) return;
    compact = next;
    collapseArmed = false;
    outsideSince = undefined;
    if (window.isVisible() && !systemPreferences.getAnimationSettings().prefersReducedMotion) {
      const id = ++motionId;
      if (motion) motion = { ...motion, id };
      else {
        const { frame, ...layouts } = dockFrame(dock);
        motion = { id, ...layouts };
        // Leave room for both shapes until the renderer finishes the transition.
        window.setMinimumSize(frame.width, Math.min(minHeight, frame.height));
        window.setBounds(frame);
      }
      clearTimeout(motionTimer);
      motionTimer = setTimeout(() => finishDockMotion(id), 450);
    } else place();
    publishDock();
    syncPointerTracking();
  }

  // Windows handles pointer events over native drag regions before Chromium sees them.
  let trackingPointer = false;
  let pointerTimer: NodeJS.Timeout | undefined;
  function syncPointerTracking() {
    clearTimeout(pointerTimer);
    if ((!trackingPointer && (!dock || compact)) || !window.isVisible()) return;
    let previous: Point | null | undefined;
    let previousHeight = 0;
    let previousInside: boolean | undefined;
    function sample() {
      const cursor = screen.getCursorScreenPoint(), bounds = window.getContentBounds();
      const x = cursor.x - bounds.x, y = cursor.y - bounds.y;
      const inside = x >= 0 && y >= 0 && x < bounds.width && y < bounds.height;
      let point: OverlayPointer = null;
      if (trackingPointer && inside) {
        const zoom = window.webContents.getZoomFactor();
        point = { x: x / zoom, y: y / zoom };
      }
      if (trackingPointer && (previous === undefined || previous?.x !== point?.x || previous?.y !== point?.y ||
        (point && bounds.height !== previousHeight))) {
        window.webContents.send('overlay:pointer', point);
      }
      previous = point;
      previousHeight = bounds.height;

      // The pointer may already be over the window when it expands.
      if (previousInside === false && inside && dock && !compact) collapseArmed = true;
      previousInside = inside;
      if (!dock || compact || motion || dragging || inside || !collapseArmed || panelOpen || needsAttention) outsideSince = undefined;
      else {
        const now = Date.now();
        outsideSince ??= now;
        if (now - outsideSince >= 300) { setCompact(true); return; }
      }
      pointerTimer = setTimeout(sample, trackingPointer && inside ? 32 : 100);
    }
    sample();
  }
  function trackPointer(enabled: boolean) {
    trackingPointer = enabled;
    syncPointerTracking();
  }
  window.on('show', syncPointerTracking);
  window.on('hide', () => {
    if (motion) finishDockMotion(motion.id);
    clearTimeout(pointerTimer);
  });
  window.webContents.on('did-start-loading', () => {
    if (motion) finishDockMotion(motion.id);
    panelOpen = false;
    trackPointer(false);
  });

  place();
  window.on('will-move', () => { dragging = true; outsideSince = undefined; });
  window.on('moved', () => {
    if (!dragging) return;
    dragging = false;
    const bounds = window.getBounds();
    anchor = { x: bounds.x, y: bounds.y };
    dock = dockOnEdge ? dockAfterDrag(bounds, screen.getDisplayMatching(bounds), dock) : undefined;
    compact = false;
    collapseArmed = !!dock;
    outsideSince = undefined;
    place();
    remember(anchor, dock);
    publishDock();
    syncPointerTracking();
  });
  function displayChanged() {
    if (motion) finishDockMotion(motion.id);
    else {
      place();
      if (dock && compact) publishDock();
    }
  }
  screen.on('display-removed', displayChanged);
  screen.on('display-metrics-changed', displayChanged);
  window.on('closed', () => {
    clearTimeout(pointerTimer);
    clearTimeout(motionTimer);
    screen.off('display-removed', displayChanged);
    screen.off('display-metrics-changed', displayChanged);
  });
  return {
    window, trackPointer, snapshot, finishDockMotion,
    expand() {
      collapseArmed = false;
      outsideSince = undefined;
      setCompact(false);
      if (!window.isVisible()) window.showInactive();
    },
    setPanelOpen(open: boolean) { panelOpen = open; outsideSince = undefined; },
    setAttention(value: boolean) {
      if (needsAttention === value) return;
      needsAttention = value;
      outsideSince = undefined;
      if (needsAttention) setCompact(false);
    },
    setDockOnEdge(enabled: boolean) {
      dockOnEdge = enabled;
      if (enabled || !dock) return;
      const bounds = dockBounds(dockDisplay().workArea, dock, height, false);
      anchor = { x: bounds.x, y: bounds.y };
      dock = undefined;
      compact = false;
      outsideSince = undefined;
      place();
      remember(anchor);
      publishDock();
      syncPointerTracking();
    },
    resize(value: number) {
      if (!Number.isFinite(value)) return;
      const next = Math.min(480, Math.max(minHeight, Math.ceil(value)));
      if (next !== height) {
        height = next;
        if (!compact && !dragging && !motion) place();
      }
    },
  };
}
