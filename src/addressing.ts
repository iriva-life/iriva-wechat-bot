export interface Addressing {
  name?: string;
  refused: boolean;
  asked: boolean;
}
export function validAddressName(name: string): boolean {
  return (
    name.trim() === name &&
    Array.from(name).length >= 1 &&
    Array.from(name).length <= 24 &&
    !/[\n\r\t\u0000-\u001f<>`*#[\]{}:：，。！？!?]/u.test(name)
  );
}
/** Only explicit first-person instructions; quoted third-party names are not identity evidence. */
export function explicitAddressing(
  text: string,
  asked: boolean,
): { name?: string; refused: boolean; evidence: string } | undefined {
  const input = text.trim().replace(/^(?:@[^\s]+\s*)+/, "");
  const match = input.match(
    /^(?:(?:请|以后|那就|可以|你可以|你就|你|就)\s*)?(?:叫我|称呼我|喊我|我叫|我的名字是|我的称呼是)\s*([^\n，。！？!?]{1,32})/u,
  );
  if (match) {
    const name = match[1]
      .trim()
      .replace(/(?:就好|就行|好了|吧)$/u, "")
      .trim();
    if (validAddressName(name))
      return { name, refused: false, evidence: match[0] };
  }
  if (
    /^(?:请)?(?:别问|不要问|不用问|不必问)(?:我)?(?:的)?(?:名字|称呼|怎么称呼|叫什么)/u.test(
      input,
    ) ||
    /^(?:我)?(?:不想|不愿意|不方便|拒绝)(?:说|提供|透露|告诉)?.*(?:名字|称呼)/u.test(
      input,
    ) ||
    (asked &&
      /^(?:我)?(?:不想说|不方便(?:说|透露)?|不想告诉你|不告诉你|不用了|不用问了|不需要|不愿意|不想透露|随便|不用称呼)[。！!\s]*$/u.test(
        input,
      ))
  )
    return { refused: true, evidence: input };
}
export function addressReply(
  text: string,
  preference: Addressing,
): { text: string; asked: boolean } {
  const name = preference.name;
  if (name) {
    const body = text.trim();
    return {
      text:
        body.startsWith(name + "，") || body.startsWith(name + ",")
          ? body
          : `${name}，${body}`,
      asked: false,
    };
  }
  if (!preference.refused && !preference.asked)
    return {
      text: `你好，方便告诉我怎么称呼你吗？\n\n${text.trim()}`,
      asked: true,
    };
  return {
    text: /^你好[，,！!。]/u.test(text.trim())
      ? text.trim()
      : `你好，${text.trim()}`,
    asked: false,
  };
}
