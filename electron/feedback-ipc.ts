import { app, clipboard, dialog, ipcMain, net, shell, type WebContents } from 'electron';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import type { FeedbackChannel, FeedbackProduct } from '../shared/feedback';
import { FeedbackService, recordFeedbackEvent } from './feedback-service';
import { FeedbackNetwork, FEEDBACK_MAINTAINER } from './feedback-network';
import { FeedbackWelink, resolveFeedbackCli } from './feedback-welink';

export function registerFeedbackIpc(product: FeedbackProduct, contents: () => WebContents | undefined, rendererUrl: string): void {
  let service: FeedbackService | undefined;
  const directory = join(app.getPath('userData'), 'feedback');
  const welink = new FeedbackWelink(() => resolveFeedbackCli([process.resourcesPath, join(app.getAppPath(), 'vendor')]));
  const request: typeof fetch = (url, init) => net.fetch(url instanceof URL ? url.href : url, init);
  const network = new FeedbackNetwork(directory, request, () => welink.available());
  void network.read().catch(() => {});
  const getService = () => service ??= new FeedbackService(directory, product, app.getVersion(), request);
  try { getService(); } catch { /* A damaged feedback file must not prevent the application from starting. */ }
  const methods = {
    prepare: (description: string, page: string) => getService().prepare(description, page),
    list: () => getService().list(),
    delivery: (force = false) => network.read(force === true),
    setMode: (mode: unknown) => network.setMode(mode),
    send: async (id: string, channel: FeedbackChannel) => {
      const record = getService().list().find(item => item.payload.feedbackId === id);
      if (!record) throw new Error('找不到本机反馈记录。');
      if (record.status !== 'local') {
        if (channel !== 'online') throw new Error('这条反馈已经在线发送，请查询原反馈状态。');
        return getService().send(id);
      }
      const delivery = await network.read();
      if (channel !== delivery.channel) throw new Error('反馈方式已变化，请核对发送位置后再确认。');
      if (channel === 'welink') return getService().handoff(id, app.getPath('downloads'), FEEDBACK_MAINTAINER, welink);
      if (channel === 'online') return getService().send(id);
      throw new Error('暂时没有可用的反馈通道。请保存反馈包，或手动选择反馈方式。');
    },
    refresh: (id: string) => getService().refresh(id),
    copy: (id: string) => { clipboard.writeText(getService().payload(id)); },
    copyWelink: async (id: string) => {
      const record = await getService().savePackage(id, app.getPath('downloads'), FEEDBACK_MAINTAINER);
      clipboard.writeText(getService().summary(id, FEEDBACK_MAINTAINER));
      let opened = false;
      try { await shell.openExternal('welink://'); opened = true; } catch { /* Keep the summary and package available for manual delivery. */ }
      return { record, opened };
    },
    export: async (id: string) => {
      const payload = getService().payload(id);
      const result = await dialog.showSaveDialog({ title: '保存反馈包', defaultPath: join(app.getPath('downloads'), `${product}-feedback-${id}.json`), filters: [{ name: '反馈包', extensions: ['json'] }] });
      if (result.canceled || !result.filePath) return false;
      await writeFile(result.filePath, payload, { mode: 0o600 });
      return true;
    },
  };
  for (const [name, handler] of Object.entries(methods)) ipcMain.handle('feedback:' + name, (event, ...args) => {
    const url = new URL(event.senderFrame?.url ?? 'about:blank');
    const allowed = new URL(rendererUrl);
    url.search = ''; url.hash = ''; allowed.search = ''; allowed.hash = '';
    if (event.sender !== contents() || event.senderFrame !== event.sender.mainFrame || url.href !== allowed.href) throw new Error('仅应用设置窗口可操作反馈。');
    return (handler as (...values: unknown[]) => unknown)(...args);
  });
  app.on('child-process-gone', (_event, detail) => recordFeedbackEvent({ stage: 'child-process', status: detail.reason, errorCode: String(detail.exitCode) }));
  app.on('web-contents-created', (_event, target) => target.on('render-process-gone', (_gone, detail) => {
    if (target === contents()) recordFeedbackEvent({ stage: 'renderer-process', status: detail.reason, errorCode: String(detail.exitCode) });
  }));
  return;
}
