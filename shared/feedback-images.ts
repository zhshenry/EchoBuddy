import type { FeedbackImageType } from './feedback';

export const feedbackImageLimit = 5;
export const feedbackImageBytes = 5 * 1024 * 1024;
export const feedbackOnlineImageNote = '图片已保存在本机反馈中，并会写入反馈包。当前在线通道只提交文字和诊断，不传送图片。可改为内网转交，或先保存反馈包。';
export const feedbackOnlineImageDraftNote = '所选图片会写入反馈包。当前在线通道只提交文字和诊断，不传送图片。可改为内网转交，或先保存反馈包。';
export const feedbackWelinkImageNote = '图片在反馈包内。发给维护人的摘要只写附件数量和文件名，不包含图片本身。';
export const feedbackLocalImageNote = '图片会保存在本机反馈包中。';

export type FeedbackImageSource = 'file' | 'paste';
export type FeedbackImageKind = 'png' | 'jpeg' | 'webp' | 'gif' | 'bmp' | 'unknown';
export type FeedbackImageInput = { key?: string; name: string; source: FeedbackImageSource; data: Uint8Array };
export type FeedbackImageDraft = {
  key: string;
  base: string;
  /** Name the user chose or the clipboard supplied, before the package filename is assigned. */
  originalName: string;
  name: string;
  label: string;
  type: FeedbackImageType;
  source: FeedbackImageSource;
  data: Uint8Array;
  url?: string;
};

const mime: Record<Exclude<FeedbackImageKind, 'bmp' | 'unknown'>, FeedbackImageType> = {
  png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
};

export function describeFeedbackImage(data: Uint8Array): FeedbackImageKind {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
    && data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a) return 'png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpeg';
  if (data.length >= 6 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38
    && (data[4] === 0x37 || data[4] === 0x39) && data[5] === 0x61) return 'gif';
  if (data.length >= 12 && data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46
    && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) return 'webp';
  if (data.length >= 14 && data[0] === 0x42 && data[1] === 0x4d) return 'bmp';
  return 'unknown';
}

export function isFeedbackClipboardImage(file: { name: string; type: string }): boolean {
  return file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name);
}

/** Files win over duplicate clipboard items. Null means this paste has no image and text should pass through. */
export function feedbackClipboardImages<T extends { name: string; type: string }>(files: readonly T[], items: readonly T[]): T[] | null {
  const chosen = files.filter(isFeedbackClipboardImage);
  const images = chosen.length ? chosen : items.filter(isFeedbackClipboardImage);
  return images.length ? [...images] : null;
}

export function feedbackImageExtension(type: FeedbackImageType): 'png' | 'jpg' | 'webp' | 'gif' {
  if (type === 'image/jpeg') return 'jpg';
  if (type === 'image/webp') return 'webp';
  if (type === 'image/gif') return 'gif';
  return 'png';
}

export function feedbackImageBase(filename: string, source: FeedbackImageSource): string {
  const leaf = filename.split(/[/\\]/).pop() ?? '';
  const stem = leaf.replace(/\.[^.]+$/u, '');
  const clean = [...stem.normalize('NFKC').replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^[-._]+|[-._]+$/gu, '')].slice(0, 40).join('').replace(/[\uD800-\uDBFF]$/u, '');
  const generic = !clean || /^(image|img|blob|pasted|clipboard|file)(?:-\d+)?$/i.test(clean);
  if (source === 'paste' && generic) return 'pasted';
  return clean || 'image';
}

export function feedbackImageRejection(kind: 'count' | 'size' | 'type' | 'empty' | 'bitmap', name: string): string {
  const label = `「${name.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 80) || '未命名图片'}」`;
  if (kind === 'count') return `最多 5 张图片，${label}未添加。`;
  if (kind === 'size') return `${label}超过 5 MB，未添加。`;
  if (kind === 'empty') return `${label}是空文件，未添加。`;
  if (kind === 'bitmap') return `无法把剪贴板图片保存为 PNG，${label}未添加。`;
  return `${label}不是 PNG、JPEG、WebP 或 GIF，未添加。`;
}

function displayName(name: string, source: FeedbackImageSource): string {
  const leaf = name.split(/[/\\]/).pop()?.replace(/[\r\n\t]+/g, ' ').trim() ?? '';
  if (leaf) return [...leaf].slice(0, 80).join('');
  return source === 'paste' ? '粘贴的图片' : '未命名图片';
}

function fileLabel(name: string): string {
  const leaf = name.split(/[/\\]/).pop() ?? '';
  const stem = leaf.replace(/\.[^.]+$/u, '').replace(/[\r\n\t]+/g, ' ').trim();
  return [...stem].slice(0, 40).join('').replace(/[\uD800-\uDBFF]$/u, '') || '图片';
}

export function indexFeedbackImages<T extends FeedbackImageDraft>(images: readonly T[]): T[] {
  let paste = 0;
  return images.map((item, index) => {
    const name = `${String(index + 1).padStart(2, '0')}-${item.base}.${feedbackImageExtension(item.type)}`;
    if (item.source !== 'paste' || item.base !== 'pasted') return { ...item, name };
    paste += 1;
    return { ...item, name, label: paste === 1 ? '粘贴的图片' : `粘贴的图片 ${paste}` };
  });
}

export function takeFeedbackImages(current: readonly FeedbackImageDraft[], incoming: readonly FeedbackImageInput[]): { images: FeedbackImageDraft[]; error: string } {
  const images: FeedbackImageDraft[] = current.map(item => ({ ...item }));
  const errors: string[] = [];
  for (const item of incoming) {
    const shown = displayName(item.name || '', item.source);
    if (images.length >= feedbackImageLimit) {
      errors.push(feedbackImageRejection('count', shown));
      continue;
    }
    if (!(item.data instanceof Uint8Array) || item.data.length === 0) {
      errors.push(feedbackImageRejection('empty', shown));
      continue;
    }
    if (item.data.length > feedbackImageBytes) {
      errors.push(feedbackImageRejection('size', shown));
      continue;
    }
    const kind = describeFeedbackImage(item.data);
    if (kind === 'bmp' || kind === 'unknown') {
      errors.push(feedbackImageRejection(kind === 'bmp' && item.source === 'paste' ? 'bitmap' : 'type', shown));
      continue;
    }
    const base = feedbackImageBase(item.name || '', item.source);
    images.push({
      key: item.key || `${images.length + 1}-${base}`,
      base, originalName: item.name || '', name: '', label: fileLabel(item.name || ''),
      type: mime[kind], source: item.source, data: item.data,
    });
  }
  return { images: indexFeedbackImages(images), error: errors.join('') };
}

export function removeFeedbackImage(images: readonly FeedbackImageDraft[], key: string): FeedbackImageDraft[] {
  return indexFeedbackImages(images.filter(item => item.key !== key));
}

export function feedbackImageTransportNote(channel: 'online' | 'welink' | 'unavailable' | undefined, count: number, saved: boolean): string {
  if (count < 1) return '';
  if (channel === 'online') return saved ? feedbackOnlineImageNote : feedbackOnlineImageDraftNote;
  if (channel === 'welink') return feedbackWelinkImageNote;
  return feedbackLocalImageNote;
}
