import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

export type WriteResult = 'written' | 'moved' | 'partial' | 'unavailable';

export class WindowsInput {
  private child?: ChildProcessWithoutNullStreams;
  private finish?: (value: string) => void;
  private requests = Promise.resolve('ok');

  constructor(private readonly executable: string) {}

  async capture(shortcut?: string): Promise<boolean> {
    if (!shortcut) return await this.ask('capture') === 'captured';
    const parts = shortcut.split('+');
    const key = parts.pop()!;
    const code = key === 'Space' ? 0x20 : key.length > 1 ? 0x6f + Number(key.slice(1)) : key.charCodeAt(0);
    // Win32 MOD_ALT, MOD_CONTROL, MOD_SHIFT, MOD_WIN.
    const modifiers = Number(parts.includes('Alt')) | (Number(parts.includes('Ctrl')) << 1) |
      (Number(parts.includes('Shift')) << 2) | (Number(parts.includes('Win')) << 3);
    return await this.ask(`capture ${code} ${modifiers}`) === 'captured';
  }
  async insert(text: string, original: boolean): Promise<WriteResult> {
    const command = original ? 'insert' : 'current';
    const value = await this.ask(command + ' ' + Buffer.from(text, 'utf16le').toString('hex'));
    return value === 'written' || value === 'moved' || value === 'partial' ? value : 'unavailable';
  }
  clear(): void { if (this.child) void this.ask('clear'); }

  close(): void {
    const child = this.child;
    this.child = undefined;
    if (child) child.kill();
    this.finish?.('unavailable');
  }

  private ask(command: string): Promise<string> {
    const result = this.requests.then(() => new Promise<string>(resolve => {
      const child = this.child ?? this.start();
      const timeout = setTimeout(() => this.close(), 4000);
      this.finish = value => {
        this.finish = undefined;
        clearTimeout(timeout);
        resolve(value);
      };
      child.stdin.write(command + '\n', error => {
        if (error && this.child === child) this.close();
      });
    }));
    this.requests = result.catch(() => 'unavailable');
    return this.requests;
  }

  private start(): ChildProcessWithoutNullStreams {
    const child = spawn(this.executable, [String(process.pid)], { windowsHide: true });
    this.child = child;
    child.stderr.resume();
    createInterface({ input: child.stdout }).on('line', line => {
      if (this.child === child) this.finish?.(line.trim());
    });
    const lost = () => { if (this.child === child) this.close(); };
    child.on('exit', lost);
    child.on('error', lost);
    child.stdin.on('error', lost);
    return child;
  }
}
