import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { authenticate, BUG_ENABLED } from "../src/auth.js";

describe("authenticate", () => {
  it("accepts valid credentials when bug is fixed", () => {
    if (BUG_ENABLED) {
      const result = authenticate({ username: "demo", password: "demo123" });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.status, 500);
      return;
    }
    const result = authenticate({ username: "demo", password: "demo123" });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.redirectTo, "/dashboard");
  });

  it("rejects invalid credentials when bug is fixed", () => {
    if (BUG_ENABLED) return;
    const result = authenticate({ username: "nope", password: "wrong" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.status, 401);
  });
});
