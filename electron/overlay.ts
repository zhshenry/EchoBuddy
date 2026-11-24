import { BrowserWindow, screen, systemPreferences, type Point } from 'electron';
import type { DockPlacement, OverlayDock, OverlayPointer } from '../shared/desktop';
import type { SavedPreferences } from './preferences';
import { dockAfterDrag, dockBounds, dockWindowLayout, fitOverlay, overlayMinHeight as minHeight, overlayWidth as width } from './overlay-position';

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
  let compactDrag: { update: () => void; timer: NodeJS.Timeout } | undefined;
  let collapseArmed = false;
  let outsideSince: number | undefined;
  let panelOpen = false;
  let needsAttention = false;
  let layout: ReturnType<typeof dockWindowLayout> | undefined;
  let motion: number | undefined;
  let motionTimer: NodeJS.Timeout | undefined;
  let motionId = 0;
  let needsRestoreRefresh = false;
  let restoreRefreshTask: NodeJS.Immediate | undefined;

  const window = new BrowserWindow({
    x: anchor.x, y: anchor.y, width, height, minWidth: width, minHeight,
    show: false, frame: false, transparent: true, resizable: false, fullscreenable: false, maximizable: false,
    focusable: false, skipTaskbar: true, hasShadow: false, title: 'EchoBuddy', icon,
    webPreferences: {
      preload, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false,
      backgroundThrottling: false,
    },
  });
  // The work area keeps the overlay clear of the taskbar. Placing the window
  // directly behind the taskbar can demote it when the taskbar isn't topmost.
  window.setAlwaysOnTop(true, 'pop-up-menu');

  function snapshot(): OverlayDock {
    return dock && layout ? { side: dock.side, compact, layout: { compact: layout.compact, expanded: layout.expanded }, motion } : null;
  }
  function publishDock() { window.webContents.send('overlay:dock', snapshot()); }

  function overlayDisplay() {
    return dock ? screen.getAllDisplays().find(item => item.id === dock?.displayId) ?? screen.getPrimaryDisplay()
      : screen.getDisplayNearestPoint({ x: anchor.x + width / 2, y: anchor.y + minHeight / 2 });
  }

  function windowRegion() {
    return layout && (motion ? undefined : compact ? layout.compact : layout.expanded);
  }

  function applyShape() {
    if (window.isMinimized()) return;
    const region = windowRegion(), frame = layout?.frame;
    // Keep the transparent viewport in place between poses. Resizing it here can
    // expose a frame with the old layout before Chromium repaints.
    window.setShape(region && frame && (region.width !== frame.width || region.height !== frame.height) ? [region] : []);
  }

  function place() {
    clearTimeout(motionTimer);
    motion = undefined;
    const activeDisplay = overlayDisplay();
    const { workArea } = activeDisplay;
    if (dock && activeDisplay.id !== dock.displayId) {
      dock = { ...dock, displayId: activeDisplay.id };
      remember(anchor, dock);
    }
    const wasDocked = !!layout;
    layout = dock ? dockWindowLayout(workArea, dock, height) : undefined;
    const bounds = layout?.frame ?? fitOverlay({ ...anchor, width, height }, workArea);
    window.setMinimumSize(bounds.width, Math.min(minHeight, bounds.height));
    window.setBounds(bounds);
    if (layout || wasDocked) applyShape();
  }

  function finishDockMotion(id: number) {
    if (motion !== id) return;
    clearTimeout(motionTimer);
    motion = undefined;
    applyShape();
    publishDock();
    syncPointerTracking();
  }

  function setCompact(next: boolean) {
    if (!next) stopCompactDrag();
    if (!dock || next === compact) return;
    compact = next;
    collapseArmed = false;
    outsideSince = undefined;
    if (window.isVisible() && !systemPreferences.getAnimationSettings().prefersReducedMotion) {
      const id = ++motionId;
      motion = id;
      clearTimeout(motionTimer);
      motionTimer = setTimeout(() => finishDockMotion(id), 450);
    } else {
      clearTimeout(motionTimer);
      motion = undefined;
    }
    applyShape();
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
      const region = windowRegion() ?? { x: 0, y: 0, width: bounds.width, height: bounds.height };
      const inside = x >= region.x && y >= region.y && x < region.x + region.width && y < region.y + region.height;
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
  function pausePointerTracking() {
    stopCompactDrag();
    if (motion) finishDockMotion(motion);
    collapseArmed = false;
    outsideSince = undefined;
    clearTimeout(pointerTimer);
  }
  function refreshAfterRestore() {
    if (!needsRestoreRefresh || restoreRefreshTask) return;
    restoreRefreshTask = setImmediate(() => {
      restoreRefreshTask = undefined;
      if (window.isDestroyed() || window.isMinimized() || !window.isVisible()) return;
      needsRestoreRefresh = false;
      // showInactive can leave Chromium's mouse input child hidden on Windows.
      const bounds = window.getBounds();
      window.setBounds({ ...bounds, width: bounds.width + 1 });
      window.setBounds(bounds);
    });
  }
  window.on('hide', pausePointerTracking);
  window.on('minimize', () => {
    needsRestoreRefresh = process.platform === 'win32';
    pausePointerTracking();
  });
  window.on('show', () => {
    syncPointerTracking();
    refreshAfterRestore();
  });
  window.on('restore', () => {
    applyShape();
    syncPointerTracking();
    refreshAfterRestore();
  });
  window.webContents.on('did-start-loading', () => {
    stopCompactDrag();
    if (motion) finishDockMotion(motion);
    panelOpen = false;
    trackPointer(false);
  });

  function settleDrag() {
    const frame = window.getBounds(), expanded = layout?.expanded;
    const region = compact ? layout?.compact : expanded;
    const bounds = region ? { ...region, x: frame.x + region.x, y: frame.y + region.y } : frame;
    anchor = { x: frame.x + (expanded?.x ?? 0), y: frame.y + (expanded?.y ?? 0) };
    dock = dockOnEdge ? dockAfterDrag(bounds, screen.getDisplayMatching(bounds), dock, compact) : undefined;
    compact = compact && !!dock;
    collapseArmed = !!dock && !compact;
    outsideSince = undefined;
    place();
    remember(anchor, dock);
    publishDock();
    syncPointerTracking();
  }

  function stopCompactDrag(sampleDrop = false) {
    if (!compactDrag) return;
    clearInterval(compactDrag.timer);
    if (sampleDrop) compactDrag.update();
    compactDrag = undefined;
    settleDrag();
  }

  function dragCompact(point: OverlayPointer) {
    if (!point) { stopCompactDrag(true); return; }
    if (!compact || motion || compactDrag || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    const content = window.getContentBounds(), zoom = window.webContents.getZoomFactor();
    const [x, y] = window.getPosition();
    const grab = { x: content.x - x + point.x * zoom, y: content.y - y + point.y * zoom };
    let lastX = x, lastY = y;
    const update = () => {
      const cursor = screen.getCursorScreenPoint();
      const nextX = Math.round(cursor.x - grab.x), nextY = Math.round(cursor.y - grab.y);
      if (lastX === nextX && lastY === nextY) return;
      window.setPosition(nextX, nextY);
      lastX = nextX;
      lastY = nextY;
    };
    compactDrag = { update, timer: setInterval(update, 16) };
    update();
  }

  place();
  window.on('will-move', () => { dragging = true; outsideSince = undefined; });
  window.on('moved', () => {
    if (!dragging) return;
    dragging = false;
    settleDrag();
  });
  function displayChanged() {
    place();
    if (dock) publishDock();
    syncPointerTracking();
  }
  screen.on('display-removed', displayChanged);
  screen.on('display-metrics-changed', displayChanged);
  window.on('closed', () => {
    clearImmediate(restoreRefreshTask);
    clearTimeout(pointerTimer);
    clearTimeout(motionTimer);
    clearInterval(compactDrag?.timer);
    screen.off('display-removed', displayChanged);
    screen.off('display-metrics-changed', displayChanged);
  });
  return {
    window, trackPointer, snapshot, finishDockMotion, dragCompact,
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
      stopCompactDrag();
      if (!dock) return;
      const bounds = dockBounds(overlayDisplay().workArea, dock, height, false);
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
      if (motion || !Number.isFinite(value)) return;
      const next = Math.min(480, Math.max(minHeight, Math.ceil(value)));
      if (next !== height) {
        height = next;
        if (!compact && !dragging) {
          place();
          if (dock) publishDock();
        }
      }
      const { workArea } = overlayDisplay();
      const bar = dock ? dockWindowLayout(workArea, dock, minHeight) : undefined;
      const inset = bar?.expanded.y ?? 0;
      const y = bar ? bar.frame.y + inset : fitOverlay({ ...anchor, width, height: minHeight }, workArea).y;
      return { room: workArea.y + workArea.height - y, inset };
    },
  };
}
