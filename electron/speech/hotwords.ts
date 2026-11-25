import { hotwordKey, type Hotword } from '../../shared/hotwords';

export function hotwordSpelling(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').toUpperCase()
    .replace(/\+/g, ' PLUS ').replace(/(?<=[A-Z])#(?=\s|$)/g, ' SHARP ').replace(/’/g, "'")
    .replace(/[^\p{Script=Han}A-Z0-9']/gu, ' ').replace(/\s+/gu, ' ').trim();
}

function parts(text: string) {
  return Array.from(text.matchAll(/\p{Script=Han}|[\p{Script=Latin}\p{N}\p{M}]+(?:['’][\p{Script=Latin}\p{N}\p{M}]+)*/gu), match => ({
    start: match.index, end: match.index + match[0].length,
    key: hotwordKey(match[0].normalize('NFKD').replace(/\p{M}/gu, '').replace(/’/g, "'")),
  }));
}

type Part = ReturnType<typeof parts>[number];
const isHan = (part: Part) => /^\p{Script=Han}$/u.test(part.key);
const repeatsHan = (part: Part, index: number, all: Part[]) => isHan(part) && part.key === all[index - 1]?.key;

function matches(parts: Part[], offset: number, wanted: Part[]): boolean {
  return offset >= 0 && wanted.every((part, index) => part.key === parts[offset + index]?.key);
}

function findOriginal(parts: Part[], before: Part[], after: Part[], length: number) {
  let range: { start: number; end: number } | undefined;
  for (let start = 0; start < parts.length; start++) {
    if (before.length ? !matches(parts, start - before.length, before) : start !== 0) continue;
    for (let end = start + 1; end <= Math.min(parts.length, start + length + 2); end++) {
      if (after.length ? !matches(parts, end, after) : end !== parts.length) continue;
      if (range) return;
      range = { start: parts[start].start, end: parts[end - 1].end };
    }
  }
  return range;
}

function findHanRange(parts: Part[], before: Part[], after: Part[], length: number) {
  let range: { start: number; end: number } | undefined;
  for (let start = 0; start + length <= parts.length; start++) {
    const end = start + length;
    const matchesBefore = before.length === 3 && matches(parts, start - 3, before);
    const matchesAfter = after.length === 3 && matches(parts, end, after);
    if ((!matchesBefore && !matchesAfter) || !parts.slice(start, end).every(isHan)) continue;
    if (range) return;
    range = { start: parts[start].start, end: parts[end - 1].end };
  }
  return range;
}

export function applyHotwords(original: string, biased: string, hotwords: readonly Hotword[]): string {
  if (!original || !hotwords.length) return original;
  const decoded = parts(biased);
  const withoutRepeats = decoded.filter((part, index) => !repeatsHan(part, index, decoded));
  let text = original;
  for (const word of hotwords) {
    const wanted = parts(hotwordSpelling(word.text));
    const hanName = wanted.length > 1 && wanted.every(isHan);
    // The contextual decoder can repeat characters. Collapse those repeats for matching a Chinese phrase.
    const candidate = hanName && !wanted.some(repeatsHan) ? withoutRepeats : decoded;
    if (!wanted.length || wanted.length > candidate.length) continue;
    for (let start = 0; start + wanted.length <= candidate.length; start++) {
      if (!matches(candidate, start, wanted)) continue;
      const end = start + wanted.length;
      const before = candidate.slice(Math.max(0, start - 3), start);
      const after = candidate.slice(end, end + 3);
      const plain = parts(text);
      // Without surrounding words, both decoders must have found the same number of speech units.
      if (wanted.length === candidate.length && plain.length !== wanted.length) continue;
      const range = findOriginal(plain, before, after, wanted.length)
        ?? (hanName ? findHanRange(plain, before, after, wanted.length) : undefined);
      if (!range) continue;
      const leading = word.text.match(/^[^\p{L}\p{N}]+/u)?.[0] ?? '';
      const trailing = word.text.match(/[^\p{L}\p{N}]+$/u)?.[0] ?? '';
      const from = text.slice(0, range.start).endsWith(leading) ? range.start - leading.length : range.start;
      const to = text.startsWith(trailing, range.end) ? range.end + trailing.length : range.end;
      text = text.slice(0, from) + word.text + text.slice(to);
    }
  }

  const spellings = new Map(hotwords.flatMap(({ text, aliases }) => [text, ...aliases].map(value => [value, text] as const)));
  const boundary = '[\\p{Script=Latin}\\p{N}_]';
  const latin = /[\p{Script=Latin}\p{N}_]/u;
  const variants = [...spellings.keys()].sort((a, b) => b.length - a.length).map(value => {
    const literal = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return (latin.test(value[0]) ? `(?<!${boundary})` : '') + literal + (latin.test(value.at(-1)!) ? `(?!${boundary})` : '');
  });
  const byKey = new Map([...spellings].map(([value, spelling]) => [hotwordKey(value), spelling]));
  return text.replace(new RegExp(variants.join('|'), 'giu'), value => byKey.get(hotwordKey(value)) ?? value);
}
