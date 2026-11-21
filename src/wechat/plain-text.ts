/** Render common model Markdown as WeChat text, preserving literal code. */
export function wechatPlainText(input: string): string {
  const literals: string[] = [];
  const hold = (text: string) => `\u0000${literals.push(text) - 1}\u0000`;
  let text = input.replace(/\r\n/g, "\n");
  text = text.replace(/^ *(`{3,}|~{3,})[^\n]*\n([\s\S]*?)^ *\1 *$/gm,
    (_all, _fence, code: string) => hold(code.replace(/\n$/, "")));
  text = text.replace(/(`+)([^\n]*?)\1/g, (_all, _ticks, code: string) => hold(code));
  text = text
    .replace(/!?\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1（$2）")
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?$/gm, "$1")
    .replace(/^[ \t]*>[ \t]?/gm, "")
    .replace(/^[ \t]*[-+*][ \t]+(?:\[[ xX]\][ \t]*)?/gm, "• ")
    .replace(/^[ \t]*(\d+)[.)][ \t]+/gm, "$1、")
    .replace(/\*\*([^\n]+?)\*\*/g, "$1")
    .replace(/__([^\n]+?)__/g, "$1")
    .replace(/~~([^\n]+?)~~/g, "$1")
    .replace(/(?<![\w*])\*([^*\n]+?)\*(?!\w)/g, "$1")
    .replace(/(?<!\w)_([^_\n]+?)_(?!\w)/g, "$1")
    .replace(/^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)+\|?[ \t]*$/gm, "")
    .replace(/^[ \t]*\|(.+)\|[ \t]*$/gm, (_all, row: string) => row.split("|").map(s => s.trim()).join("；"))
    .replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, "")
    .replace(/\\([\\`*_[\]{}()#+.!>~-])/g, "$1")
    .replace(/\n{3,}/g, "\n\n");
  return text.replace(/\u0000(\d+)\u0000/g, (_all, i: string) => literals[Number(i)] ?? "").trim();
}
