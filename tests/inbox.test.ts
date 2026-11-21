import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Inbox } from "../src/inbox.js";

test("inbound replay cannot repeat completed or outcome-unknown work", () => {
  const dir = mkdtempSync(join(tmpdir(), "iriva-inbox-"));
  try {
    let store = new Inbox(join(dir, "db"));
    assert.equal(store.claim("a"), true);
    assert.equal(store.claim("a"), false);
    store.close();
    store = new Inbox(join(dir, "db"));
    assert.equal(store.status("a"), "uncertain");
    assert.equal(store.claim("a"), false);
    assert.equal(store.claim("b"), true);
    store.finish("b", "completed");
    assert.equal(store.claim("b"), false);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
