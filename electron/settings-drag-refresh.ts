export type SettingsDragWindow = {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  onMinimize(listener: () => void): void;
  onRestore(listener: () => void): void;
  onShow(listener: () => void): void;
};

/**
 * Windows leaves `-webkit-app-region` hit testing stale after a frameless
 * transparent window is restored from the taskbar: the title bar stops dragging
 * and the buttons inside it stop receiving clicks. Schedule a single refresh
 * once the window is shown again. The title-bar button, the title-bar system
 * menu, and the taskbar menu all minimize the same window, so they share this path.
 * The refresh waits until the current turn finishes, so a page change that
 * restores the window can apply its bounds first.
 */
export function watchSettingsDragRefresh(
  win: SettingsDragWindow,
  refresh: () => void,
  schedule: (run: () => void) => void = run => { setTimeout(run, 0); },
): void {
  let minimized = false;
  let scheduled = false;
  const kick = () => {
    if (!minimized || scheduled) return;
    scheduled = true;
    schedule(() => {
      scheduled = false;
      if (!minimized || win.isDestroyed() || win.isMinimized()) return;
      minimized = false;
      refresh();
    });
  };
  win.onMinimize(() => { minimized = true; });
  win.onRestore(kick);
  win.onShow(kick);
}
