import assert from "node:assert/strict";
import { orbioProvider } from "../../src/proxy/providers/orbio.js";
import { openrouterProvider } from "../../src/proxy/providers/openrouter.js";
import { resolveProvider, UnknownProviderError, DEFAULT_PROVIDER_NAME } from "../../src/proxy/providers/registry.js";

function testRegistryResolvesKnownProviders(): void {
  assert.equal(resolveProvider("orbio"), orbioProvider);
  assert.equal(resolveProvider("openrouter"), openrouterProvider);
  assert.equal(DEFAULT_PROVIDER_NAME, "orbio");
}

function testRegistryFailsClosedOnUnknownName(): void {
  assert.throws(() => resolveProvider("openai"), UnknownProviderError);
  assert.throws(() => resolveProvider("bogus-provider"), UnknownProviderError);
  try {
    resolveProvider("bogus-provider");
    assert.fail("expected resolveProvider to throw");
  } catch (error) {
    assert.ok(error instanceof UnknownProviderError);
    assert.match((error as Error).message, /Unknown SENTINEL_PROVIDER "bogus-provider"/);
    assert.match((error as Error).message, /orbio/);
    assert.match((error as Error).message, /openrouter/);
  }
}

// Both providers key real cost off usage.cost today, but each has its own
// implementation (see the comments in orbio.ts / openrouter.ts) -- this test
// exercises each provider's own function, not a shared helper, so a future
// divergence between the two is caught here rather than assumed away.
function testReadExactCostUsd(): void {
  for (const provider of [orbioProvider, openrouterProvider]) {
    assert.equal(provider.readExactCostUsd({ cost: 0.000123 }), 0.000123, `${provider.name}: reads a numeric cost`);
    assert.equal(provider.readExactCostUsd({ cost: 0 }), 0, `${provider.name}: zero cost is a real exact value, not absence`);
    assert.equal(provider.readExactCostUsd(undefined), null, `${provider.name}: no usage object at all`);
    assert.equal(provider.readExactCostUsd({}), null, `${provider.name}: usage present but no cost field`);
    assert.equal(provider.readExactCostUsd({ cost: "0.01" }), null, `${provider.name}: a string cost is never trusted as exact`);
    assert.equal(provider.readExactCostUsd({ cost: NaN }), null, `${provider.name}: NaN is rejected`);
    assert.equal(provider.readExactCostUsd({ cost: Infinity }), null, `${provider.name}: Infinity is rejected`);
  }
}

function testAuthHeadersAndKeyEnvVar(): void {
  assert.deepEqual(orbioProvider.authHeaders("k-orbio"), { authorization: "Bearer k-orbio" });
  assert.deepEqual(openrouterProvider.authHeaders("k-or"), { authorization: "Bearer k-or" });
  assert.equal(orbioProvider.apiKeyEnvVar, "ORBIO_API_KEY");
  assert.equal(openrouterProvider.apiKeyEnvVar, "OPENROUTER_API_KEY");
}

function testCostReportingIsExactForBoth(): void {
  // Both are wired as "exact" today (§3 steps 1-2). This is the property the
  // whole task is organised around never blurring: a provider that cannot back
  // this up with a real reported figure must be "estimated", not "exact".
  assert.equal(orbioProvider.costReporting, "exact");
  assert.equal(openrouterProvider.costReporting, "exact");
}

function testStaticPricesAreProviderOwned(): void {
  assert.notEqual(orbioProvider.staticPrices, openrouterProvider.staticPrices, "each provider owns its own price table object");
  assert.ok(Object.keys(orbioProvider.staticPrices).length > 0);
  assert.ok(Object.keys(openrouterProvider.staticPrices).length > 0);
}

testRegistryResolvesKnownProviders();
testRegistryFailsClosedOnUnknownName();
testReadExactCostUsd();
testAuthHeadersAndKeyEnvVar();
testCostReportingIsExactForBoth();
testStaticPricesAreProviderOwned();
console.log("Provider adapter tests passed");
