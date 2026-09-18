import { describe, it } from "node:test";
import assert from "node:assert";
import { CONSENT_DEFAULTS, buildGtmInitScript } from "../../lib/consent";

describe("CONSENT_DEFAULTS", () => {
  it("denies every optional storage signal by default", () => {
    for (const signal of [
      "analytics_storage",
      "ad_storage",
      "ad_user_data",
      "ad_personalization",
      "functionality_storage",
      "personalization_storage",
    ] as const) {
      assert.equal(CONSENT_DEFAULTS[signal], "denied");
    }
    assert.equal(CONSENT_DEFAULTS.security_storage, "granted");
    assert.equal(CONSENT_DEFAULTS.wait_for_update, 500);
  });
});

describe("buildGtmInitScript", () => {
  it("always pushes gtm.start onto an ensured dataLayer", () => {
    for (const script of [
      buildGtmInitScript(),
      buildGtmInitScript("cbid-123"),
    ]) {
      assert.match(script, /dataLayer=window\.dataLayer\|\|\[\]/);
      assert.match(script, /'gtm\.start':Date\.now\(\),event:'gtm\.js'/);
    }
  });

  it("pushes consent defaults BEFORE gtm.start when a Cookiebot id is configured", () => {
    const script = buildGtmInitScript("cbid-123");
    const consentIndex = script.indexOf('"consent","default"');
    const startIndex = script.indexOf("gtm.start");
    assert.ok(consentIndex !== -1, "consent default command missing");
    assert.ok(
      consentIndex < startIndex,
      "consent defaults must precede gtm.start so no tag evaluates pre-consent"
    );
    assert.match(script, /"analytics_storage":"denied"/);
    assert.match(script, /"ad_user_data":"denied"/);
    // The gtag stub exists so Cookiebot's later consent updates serialize
    // onto the same queue.
    assert.match(script, /window\.gtag=/);
  });

  it("emits no consent commands when no Cookiebot id is configured", () => {
    const script = buildGtmInitScript();
    assert.ok(!script.includes("consent"), script);
    assert.ok(!script.includes("window.gtag"), script);
  });
});
