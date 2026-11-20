import { ArrowUpRight, DownloadSimple, Waveform, X } from '@phosphor-icons/react';
import type { UpdateStatus } from '../../shared/desktop';

export function UpdateSettings({ update, blocked }: { update: UpdateStatus; blocked: string }) {
  const ready = update.phase === 'ready';
  const checking = update.phase === 'checking';
  const downloading = update.phase === 'downloading';
  const action = ready ? '重启并安装' : checking ? '检查中…' : downloading ? update.progress + '%' : '检查更新';
  const desktop = window.echoBuddy;
  return <section className="update" aria-label="版本更新" data-update={update.phase}>
    <div className="row">
      <strong className="update-brand">
        <Waveform size={17} weight="bold" aria-hidden="true" />
        EchoBuddy {update.current && <small>v{update.current}</small>}
      </strong>
      <button className={'update-action' + (ready ? ' install' : '')}
        disabled={!update.enabled || checking || downloading || (ready && !!blocked)}
        onClick={() => void (ready ? desktop.installUpdate() : desktop.checkUpdate())}>{action}</button>
    </div>
    <div className="row update-meta">
      <span role="status">{update.message}</span>
      <button className="release-link" onClick={() => void desktop.releases()} title="打开 GitHub Releases">发布页 <ArrowUpRight size={13} /></button>
    </div>
    {downloading && <progress aria-label="更新下载进度" value={update.progress} max={100} />}
    {ready && blocked && <p className="update-hold">{blocked}</p>}
  </section>;
}

export function UpdateNotice({ version, open, dismiss }: { version: string; open: () => void; dismiss: () => void }) {
  return <div className="update-notice">
    <DownloadSimple size={17} weight="bold" aria-hidden="true" />
    <span role="status">v{version} 已下载</span>
    <button onClick={open}>查看更新</button>
    <button className="dismiss-update" aria-label="收起更新提示" onClick={dismiss}><X size={14} /></button>
  </div>;
}
