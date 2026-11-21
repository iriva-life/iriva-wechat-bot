const segmenter = new Intl.Segmenter("zh", { granularity: "grapheme" });
export function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (part) => part.segment);
}
export function splitBubbles(text: string, maxLength = 220): string[] {
  if (!Number.isInteger(maxLength) || maxLength < 1 || maxLength > 4000)
    throw new Error("Invalid bubble length");
  const chars = graphemes(text.trim());
  const result: string[] = [];
  while (chars.length) {
    let cut = Math.min(chars.length, maxLength);
    if (chars.length > maxLength) {
      for (let i = maxLength - 1; i >= Math.floor(maxLength / 2); i--) {
        if (/[\n。！？!?；;]/.test(chars[i]!)) {
          cut = i + 1;
          break;
        }
      }
    }
    result.push(chars.splice(0, cut).join(""));
  }
  return result;
}
export interface PacingOptions {
  baseDelayMs?: number;
  perGraphemeMs?: number;
  maxDelayMs?: number;
  jitterMs?: number;
}
export function bubbleDelay(
  text: string,
  options: PacingOptions = {},
  random: () => number = Math.random,
): number {
  const base = options.baseDelayMs ?? 500,
    per = options.perGraphemeMs ?? 35;
  const max = options.maxDelayMs ?? 12_000,
    jitter = options.jitterMs ?? 250;
  if ([base, per, max, jitter].some((n) => !Number.isFinite(n) || n < 0))
    throw new Error("Invalid pacing settings");
  const draw = random();
  if (!Number.isFinite(draw) || draw < 0 || draw > 1)
    throw new Error("Invalid random source");
  return Math.round(
    Math.max(
      0,
      Math.min(
        max,
        base + graphemes(text).length * per + (draw * 2 - 1) * jitter,
      ),
    ),
  );
}
