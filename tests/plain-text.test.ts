import test from "node:test";
import assert from "node:assert/strict";
import { wechatPlainText } from "../src/wechat/plain-text.js";

test("WeChat renders Markdown without losing prices, URLs, or command operators", () => {
  const source = '# **价格**\n\n- 母语档：**1980**，原价 ~~2980~~\n- [详情](https://example.com/faq)\n\n```bash\nprintf "%s" "$HOME"; ls *.md | sort\n```\n\n路径 `faq/pricing`，账号 wxid_test_user。';
  assert.equal(wechatPlainText(source), '价格\n\n• 母语档：1980，原价 2980\n• 详情（https://example.com/faq）\n\nprintf "%s" "$HOME"; ls *.md | sort\n\n路径 faq/pricing，账号 wxid_test_user。');
});

test("plain output preserves literal code and converts table/list formatting", () => {
  const plain = '当前账号是管理员。\n2 * 3 = 6\nfoo_bar_baz\nhttps://example.com/a_b';
  assert.equal(wechatPlainText(plain), plain);
  assert.equal(wechatPlainText('1. **权限**\n> 可用\n\n| 角色 | 工具 |\n| --- | --- |\n| admin | Bash |'), '1、权限\n可用\n\n角色；工具\n\nadmin；Bash');
});
