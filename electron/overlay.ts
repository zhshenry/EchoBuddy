import { BrowserWindow, screen, type Point } from 'electron';
import type { SavedPreferences } from './preferences';

const width = 368;
const minHeight = 88;

export function createOverlay(
  preload: string, icon: string, saved: SavedPreferences['position'], remember: (position: Point) => void,
) {
  const display = saved ? screen.getDisplayNearestPoint(saved) : screen.getPrimaryDisplay();
  let anchor = saved ?? { x: display.workArea.x + display.workArea.width - width - 20, y: display.workArea.y + 68 };
  let height = minHeight;
  let placed: Point | undefined;
  let timer: NodeJS.Timeout | undefined;

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

  // Windows handles pointer events over native drag regions before Chromium sees them.
  let trackingPointer = false;
  let pointerTimer: NodeJS.Timeout | undefined;
  function syncPointerTracking() {
    clearTimeout(pointerTimer);
    if (!trackingPointer || !window.isVisible()) return;
    let previous: Point | null | undefined;
    let previousHeight = 0;
    function sample() {
      const cursor = screen.getCursorScreenPoint(), bounds = window.getContentBounds();
      const x = cursor.x - bounds.x, y = cursor.y - bounds.y;
      let point: Point | null = null;
      if (x >= 0 && y >= 0 && x < bounds.width && y < bounds.height) {
        const zoom = window.webContents.getZoomFactor();
        point = { x: x / zoom, y: y / zoom };
      }
      if (previous === undefined || previous?.x !== point?.x || previous?.y !== point?.y || (point && bounds.height !== previousHeight)) {
        window.webContents.send('overlay:pointer', point);
      }
      previous = point;
      previousHeight = bounds.height;
      pointerTimer = setTimeout(sample, point ? 32 : 100);
    }
    sample();
  }
  function trackPointer(enabled: boolean) {
    trackingPointer = enabled;
    syncPointerTracking();
  }
  window.on('show', syncPointerTracking);
  window.on('hide', () => clearTimeout(pointerTimer));
  window.webContents.on('did-start-loading', () => trackPointer(false));

  function place() {
    const { workArea } = screen.getDisplayNearestPoint({ x: anchor.x + width / 2, y: anchor.y + minHeight / 2 });
    placed = {
      x: Math.max(workArea.x, Math.min(anchor.x, workArea.x + workArea.width - width)),
      y: Math.max(workArea.y, Math.min(anchor.y, workArea.y + workArea.height - height)),
    };
    window.setBounds({ ...placed, width, height });
  }
  place();
  window.on('move', () => {
    const [x, y] = window.getPosition();
    if (placed && x === placed.x && y === placed.y) return;
    anchor = { x, y };
    clearTimeout(timer);
    timer = setTimeout(() => remember(anchor), 250);
  });
  screen.on('display-removed', place);
  screen.on('display-metrics-changed', place);
  window.on('closed', () => {
    clearTimeout(timer);
    clearTimeout(pointerTimer);
    screen.off('display-removed', place);
    screen.off('display-metrics-changed', place);
  });
  return {
    window, trackPointer,
    resize(value: number) {
      if (!Number.isFinite(value)) return;
      const next = Math.min(450, Math.max(minHeight, Math.ceil(value)));
      if (next !== height) { height = next; place(); }
    },
  };
}
