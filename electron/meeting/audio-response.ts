import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';

export async function meetingAudio(request: Request, path: string): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 });
  const info = await stat(path).catch(() => null);
  if (!info?.isFile() || info.size < 46) return new Response(null, { status: 404 });
  const { size } = info;
  const headers = new Headers({ 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
  const range = request.headers.get('range');
  const match = range?.match(/^bytes=(\d*)-(\d*)$/);
  const start = match && match[1] === '' ? Math.max(0, size - Number(match[2])) : Number(match?.[1] ?? 0);
  const end = match?.[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  if (range && (!match || (!match[1] && !match[2]) || start >= size || end < start)) {
    headers.set('Content-Range', 'bytes */' + size);
    return new Response(null, { status: 416, headers });
  }
  if (range) headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
  headers.set('Content-Length', String(end - start + 1));
  const stream = request.method === 'HEAD' ? null
    : Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream<Uint8Array>;
  return new Response(stream, { status: range ? 206 : 200, headers });
}
