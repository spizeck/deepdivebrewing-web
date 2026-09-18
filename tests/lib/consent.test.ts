import { describe, it } from "node:test";
import assert from "node:assert";
import {
  CONSENT_DEFAULTS,
  CONSENT_POLICY_VERSION,
  CONSENT_SERVICES,
  CONSENT_STORAGE_NAME,
  buildGtmInitScript,
  buildKlaroConfig,
  consentUpdateFromStates,
} from "../../lib/consent";

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
  it("pushes consent defaults BEFORE gtm.start so no tag evaluates pre-consent", () => {
    const script = buildGtmInitScript();
    assert.match(script, /dataLayer=window\.dataLayer\|\|\[\]/);
    const consentIndex = script.indexOf('"consent","default"');
    const startIndex = script.indexOf("gtm.start");
    assert.ok(consentIndex !== -1, "consent default command missing");
    assert.ok(
      consentIndex < startIndex,
      "consent defaults must precede gtm.start"
    );
    assert.match(script, /"analytics_storage":"denied"/);
    assert.match(script, /"ad_user_data":"denied"/);
    // The gtag stub exists so later consent updates serialize onto the
    // same queue the container drains.
    assert.match(script, /window\.gtag=/);
    assert.match(script, /'gtm\.start':Date\.now\(\),event:'gtm\.js'/);
  });
});

describe("CONSENT_SERVICES registry", () => {
  it("contains only services the site actually uses", () => {
    const names = CONSENT_SERVICES.map((s) => s.name);
    assert.deepEqual(names, [
      "consent-preferences",
      "google-analytics",
      "vercel-analytics",
    ]);
  });

  it("marks the consent store itself as required (cannot be declined)", () => {
    const required = CONSENT_SERVICES.filter((s) => s.required);
    assert.deepEqual(
      required.map((s) => s.name),
      ["consent-preferences"]
    );
  });

  it("gates only Google Analytics behind an optional consent toggle", () => {
    const optional = CONSENT_SERVICES.filter(
      (s) => s.consentManaged !== false && !s.required
    );
    assert.deepEqual(
      optional.map((s) => s.name),
      ["google-analytics"]
    );
    // Vercel Analytics is declared for transparency but is cookieless —
    // it must not become a switchable service.
    const vercel = CONSENT_SERVICES.find((s) => s.name === "vercel-analytics");
    assert.equal(vercel?.consentManaged, false);
    assert.equal(vercel?.consentSignals, undefined);
  });

  it("grants no advertising Consent Mode signals to any service", () => {
    for (const service of CONSENT_SERVICES) {
      for (const signal of Object.keys(service.consentSignals ?? {})) {
        assert.ok(
          !signal.startsWith("ad_"),
          `${service.name} must not grant ${signal} — the site has no ads`
        );
      }
    }
  });
});

describe("consentUpdateFromStates", () => {
  it("keeps analytics denied when the visitor has not consented", () => {
    const update = consentUpdateFromStates({});
    assert.equal(update.analytics_storage, "denied");
    assert.equal(update.security_storage, "granted");
  });

  it("keeps analytics denied when analytics is explicitly declined", () => {
    const update = consentUpdateFromStates({
      "consent-preferences": true,
      "google-analytics": false,
    });
    assert.equal(update.analytics_storage, "denied");
  });

  it("grants analytics_storage when analytics is accepted", () => {
    const update = consentUpdateFromStates({
      "consent-preferences": true,
      "google-analytics": true,
    });
    assert.equal(update.analytics_storage, "granted");
    // Advertising signals stay denied regardless — no ad services exist.
    assert.equal(update.ad_storage, "denied");
    assert.equal(update.ad_user_data, "denied");
    assert.equal(update.ad_personalization, "denied");
  });
});

describe("buildKlaroConfig", () => {
  it("is fully local — no vendor id, no remote service configuration", () => {
    const config = buildKlaroConfig();
    const serialized = JSON.stringify(config);
    assert.ok(!serialized.includes("http"), serialized);
    assert.ok(!serialized.includes("cbid"), serialized);
  });

  it("embeds the consent policy version in the storage name", () => {
    const config = buildKlaroConfig();
    assert.equal(config.storageName, CONSENT_STORAGE_NAME);
    assert.ok(CONSENT_STORAGE_NAME.includes(`v${CONSENT_POLICY_VERSION}`));
    assert.equal(typeof CONSENT_POLICY_VERSION, "number");
  });

  it("defaults every optional service to off (no preselected consent)", () => {
    const config = buildKlaroConfig();
    assert.equal(config.default, false);
    for (const service of config.services) {
      assert.equal(service.default, false);
    }
    assert.ok(config.services.some((s) => s.required === true));
  });

  it("offers accept-all and decline-all without a forced modal", () => {
    const config = buildKlaroConfig();
    assert.equal(config.acceptAll, true);
    assert.equal(config.hideDeclineAll, false);
    assert.equal(config.mustConsent, false);
    assert.equal(config.noticeAsModal, false);
  });

  it("labels every consent action in plain language", () => {
    const config = buildKlaroConfig();
    const en = config.translations.en as Record<string, unknown>;
    assert.equal(en.ok, "Allow analytics");
    assert.equal(en.decline, "No thanks");
    assert.equal(en.acceptAll, "Allow analytics");
    assert.equal(en.acceptSelected, "Save preferences");
    const notice = en.consentNotice as Record<string, string>;
    assert.equal(notice.title, "Cookies. Sadly, not the beer kind.");
    assert.equal(notice.learnMore, "Manage preferences");
  });

  it("themes the widget with the site's light palette tokens", () => {
    const config = buildKlaroConfig();
    assert.deepEqual(config.styling.theme, ["light"]);
    // Paper surfaces, ink primary text/actions, stone borders.
    assert.equal(config.styling.dark1, "#FAFAF8");
    assert.equal(config.styling.light1, "#0B0F14");
    assert.equal(config.styling.dark2, "#E6E7E3");
    // Notice heading enabled; vendor "powered by" footer disabled (Klaro
    // is credited in docs — BSD-3 requires no UI attribution).
    assert.equal(config.showNoticeTitle, true);
    assert.equal(config.disablePoweredBy, true);
  });

  it("lists only consent-managed services in the Klaro config", () => {
    const config = buildKlaroConfig();
    const names = config.services.map((s) => s.name);
    assert.deepEqual(names, ["consent-preferences", "google-analytics"]);
    assert.ok(!names.includes("vercel-analytics"));
  });
});
