import { BrowserWindow, screen, type Point } from 'electron';
import type { SavedPreferences } from './preferences';

const width = 368;
const minHeight = 88;

export function createOverlay(
  preload: string, icon: string, saved: SavedPreferences['position'], remember: (position: Point) => void,
): { window: BrowserWindow; resize: (height: number) => void } {
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
    screen.off('display-removed', place);
    screen.off('display-metrics-changed', place);
  });
  return {
    window,
    resize(value) {
      if (!Number.isFinite(value)) return;
      const next = Math.min(450, Math.max(minHeight, Math.ceil(value)));
      if (next !== height) { height = next; place(); }
    },
  };
}
