import { describe, it } from "node:test";
import assert from "node:assert";
import { reactVersionMismatch } from "../scripts/check-react-versions.mjs";

describe("reactVersionMismatch", () => {
  it("returns null when react and react-dom declare the same version", () => {
    assert.equal(
      reactVersionMismatch({
        dependencies: { react: "19.2.3", "react-dom": "19.2.3" },
      }),
      null
    );
  });

  it("flags mismatched declared versions", () => {
    const message = reactVersionMismatch({
      dependencies: { react: "19.2.3", "react-dom": "19.2.2" },
    });
    assert.ok(message);
    assert.match(message, /react is "19\.2\.3"/);
    assert.match(message, /react-dom is "19\.2\.2"/);
  });

  it("flags differing version specifiers even at the same version", () => {
    const message = reactVersionMismatch({
      dependencies: { react: "^19.2.3", "react-dom": "19.2.3" },
    });
    assert.ok(message);
  });

  it("flags a missing react or react-dom declaration", () => {
    assert.ok(
      reactVersionMismatch({ dependencies: { react: "19.2.3" } })
    );
    assert.ok(
      reactVersionMismatch({ dependencies: { "react-dom": "19.2.3" } })
    );
    assert.ok(reactVersionMismatch({}));
  });
});
