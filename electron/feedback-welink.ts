import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

export function resolveFeedbackCli(roots: string[], env = process.env): string | undefined {
  const paths = [...roots.map(root => join(root, 'welink', 'welink-cli.exe')),
    String.raw`C:\Program Files\WeClaw Desktop\resources\bundled\opencode\welink-cli.exe`,
    ...(env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean).map(root => join(root.replace(/^"|"$/g, ''), 'welink-cli.exe'))];
  return paths.find(path => existsSync(path));
}
type CommandResult = { code: number | string | null; stdout: string; stderr: string };
type Runner = (exe: string, args: string[], timeout: number) => Promise<CommandResult>;
const run: Runner = (exe, args, timeout) => new Promise(resolve => {
  execFile(exe, args, { windowsHide: true, timeout, maxBuffer: 256 * 1024 }, (error, stdout, stderr) =>
    resolve({ code: error?.code ?? (error ? null : 0), stdout: String(stdout), stderr: String(stderr) }));
});
export type WelinkResult = { state: 'sent' | 'failed' | 'unknown'; error?: string };
export class FeedbackWelink {
  constructor(private readonly executable: () => string | undefined, private readonly runner: Runner = run) {}
  available(): boolean { return !!this.executable(); }
  async check(): Promise<string | undefined> {
    const exe = this.executable();
    if (!exe) return '未找到 WeLink 命令行工具。可复制摘要并打开 WeLink，将反馈包交给维护人。';
    try {
      const result = await this.runner(exe, ['auth', 'status'], 10000);
      const raw = stripVTControlCharacters(result.stdout);
      if (result.code === 0 && !/cannot connect to WeLink PC/i.test(raw) &&
        (/^[ \t]*User Token:[ \t]*valid\b/im.test(raw) || /^[ \t]*Refresh Token:[ \t]*valid\b/im.test(raw) || /^[ \t]*Status:[ \t]*authenticated\b/im.test(raw))) return;
    } catch { /* Do not expose CLI output, which may contain account credentials. */ }
    return 'WeLink 命令行尚未登录或客户端不可用。请先登录，或复制摘要后手动发送。';
  }
  async send(receiver: string, summary: string): Promise<WelinkResult> {
    const exe = this.executable();
    if (!exe) return { state: 'failed', error: '未找到 WeLink 命令行工具，请复制摘要后手动发送。' };
    try {
      const result = await this.runner(exe, ['im', 'send-to-user', '--receiver', receiver, '--text', summary], 30000);
      if (result.code !== 0) {
        if (/sign\/nonce\/timestamp|用户未登录|cannot connect to WeLink PC|not allow to send messages to self|proxy failed/i.test(result.stdout + result.stderr))
          return { state: 'failed', error: 'WeLink 未接收摘要，请确认客户端和命令行登录的是同一个账号，或手动发送给维护人。' };
        return { state: 'unknown' };
      }
      const receipt = JSON.parse(stripVTControlCharacters(result.stdout).trim());
      const code = receipt?.code ?? receipt?.resultCode ?? receipt?.error?.error_code;
      if (receipt?.ok === false || receipt?.success === false || code !== undefined && !['0', '200'].includes(String(code)))
        return { state: 'failed', error: 'WeLink 未接收摘要，可稍后重试或手动发送给维护人。' };
      if (receipt && typeof receipt === 'object' && (receipt.ok === true || receipt.success === true || ['0', '200'].includes(String(code)))) return { state: 'sent' };
    } catch { /* A timeout or unreadable receipt cannot prove whether the message arrived. */ }
    return { state: 'unknown' };
  }
}
