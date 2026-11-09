import assert from "node:assert/strict";
import test from "node:test";
import { clientAddress, createRateLimiter } from "../../server/rate-limit.mjs";

test("a burst is allowed, then refused until tokens refill", () => {
  let time = 0;
  const limiter = createRateLimiter({ perSecond: 2, burst: 3, now: () => time });
  assert.deepEqual([1, 2, 3].map(() => limiter.check("a")), [0, 0, 0]);
  assert.equal(limiter.check("a"), 1);
  time = 1000;
  assert.equal(limiter.check("a"), 0);
});

test("each address has its own allowance", () => {
  const limiter = createRateLimiter({ perSecond: 1, burst: 1, now: () => 0 });
  assert.equal(limiter.check("a"), 0);
  assert.equal(limiter.check("b"), 0);
  assert.ok(limiter.check("a") > 0);
});

test("forged forwarding entries are ignored", () => {
  const socket = { remoteAddress: "10.0.0.9" };
  const headers = { "x-forwarded-for": "1.1.1.1, 2.2.2.2, 3.3.3.3" };
  assert.equal(clientAddress({ headers, socket }, 0), "10.0.0.9");
  assert.equal(clientAddress({ headers, socket }, 1), "3.3.3.3");
  assert.equal(clientAddress({ headers, socket }, 2), "2.2.2.2");
  assert.equal(clientAddress({ headers: {}, socket }, 1), "10.0.0.9");
});
