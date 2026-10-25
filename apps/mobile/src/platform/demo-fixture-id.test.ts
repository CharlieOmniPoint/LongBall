import { describe, expect, it } from "vitest";
import { demoFixtureId, type DemoFixtureIdContext } from "./demo-fixture-id";

const uuid = "842fab71-e9d1-4c3b-8ad7-524b655fc975";
const demo: DemoFixtureIdContext = {
  environment: "development",
  allowSynthetic: true,
  connectionMode: "synthetic",
  platform: "web",
  principal: { issuer: "urn:longball:synthetic" },
};

describe("new fixture IDs for the explicit demo browser", () => {
  it.each(["development", "fictional"])(
    "keeps the UUID and adds only the demo prefix in %s",
    (environment) => {
      expect(demoFixtureId(uuid, { ...demo, environment })).toBe(
        `synthetic-${uuid}`,
      );
    },
  );

  it.each<Partial<DemoFixtureIdContext>>([
    { environment: "production" },
    { environment: "test" },
    { environment: undefined },
    { environment: "" },
    { allowSynthetic: false },
    { allowSynthetic: undefined },
    { connectionMode: "oidc" },
    { platform: "ios" },
    { platform: "android" },
    { principal: null },
    { principal: { issuer: "https://identity.example.test" } },
    { principal: { issuer: "urn:longball:synthetic-unverified" } },
  ])("preserves ordinary UUIDs when any demo prerequisite is missing: %j", (change) => {
    expect(demoFixtureId(uuid, { ...demo, ...change })).toBe(uuid);
  });

  it("does not infer demo provenance from a URL, team ID or data marker", () => {
    const unverified = {
      ...demo,
      principal: null,
      url: "https://longball-demo.example.test",
      teamId: "synthetic-roma-u10",
      synthetic: true,
    };
    expect(demoFixtureId(uuid, unverified)).toBe(uuid);
  });

  it("leaves the supplied context and verified principal unchanged", () => {
    const principal = Object.freeze({ issuer: "urn:longball:synthetic" });
    const context = Object.freeze({ ...demo, principal });
    expect(demoFixtureId(uuid, context)).toBe(`synthetic-${uuid}`);
    expect(context).toEqual(demo);
    expect(context.principal).toBe(principal);
  });
});
