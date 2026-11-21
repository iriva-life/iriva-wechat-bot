import test from "node:test";
import assert from "node:assert/strict";
import { StateStore } from "../src/policy/index.js";
import { bindDirectoryAdmins } from "../src/admin-directory.js";

test("admin whitelist resolves only unique real directory aliases, not display names or self", () => {
  const state = new StateStore(":memory:", {
    adminAliases: ["quietfire1", "EnRomantice"],
  });
  try {
    assert.equal(
      bindDirectoryAdmins(
        state,
        {
          users: {
            wxid_fake: { nickname: "quietfire1", display: "EnRomantice" },
            wxid_bot: { alias: "quietfire1" },
            "123@chatroom": { alias: "quietfire1" },
          },
        },
        "wxid_bot",
      ),
      0,
    );
    assert.equal(
      bindDirectoryAdmins(
        state,
        {
          users: {
            wxid_one: { alias: "quietfire1" },
            wxid_two: { alias: "quietfire1" },
          },
        },
        "wxid_bot",
      ),
      0,
    );
    assert.equal(
      bindDirectoryAdmins(
        state,
        {
          users: {
            wxid_real: { alias: "QuietFire1" },
          },
        },
        "wxid_bot",
      ),
      1,
    );
    assert.equal(state.roleFor("wxid_real"), "admin");
    assert.equal(state.roleFor("wxid_fake"), "other");
    assert.equal(
      bindDirectoryAdmins(
        state,
        {
          users: {
            wxid_changed: { alias: "quietfire1" },
          },
        },
        "wxid_bot",
      ),
      0,
    );
    assert.equal(state.roleFor("wxid_changed"), "other");
  } finally {
    state.close();
  }
});
