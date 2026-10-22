import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Redis } from "ioredis";
import { getRateLimitTier } from "../config/rateLimit.js";
import { UserRole } from "../types/index.js";
import {
  authRateLimiter,
  apiRateLimiter,
  createSlidingWindowRateLimiter,
  MemorySlidingWindowStore,
  RedisSlidingWindowStore,
} from "../middleware/rateLimiter.js";

describe("Rate-Limiting & DDoS Mitigation Middleware", () => {
  it("should block auth requests exceeding strict limit with 429 Too Many Requests", async () => {
    const app = express();
    app.set("trust proxy", true);
    app.post("/auth/login", authRateLimiter, (_req, res) => {
      res.status(200).json({ success: true });
    });

    const server = app.listen(0);
    const address = server.address() as any;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      let lastStatus = 200;
      // Make 10 rapid login attempts (max allowed is 5)
      for (let i = 0; i < 10; i++) {
        const res = await fetch(`${baseUrl}/auth/login`, {
          method: "POST",
          headers: { "X-Forwarded-For": "203.0.113.195" },
        });
        lastStatus = res.status;
      }

      assert.strictEqual(lastStatus, 429);
    } finally {
      server.close();
    }
  });

  it("should differentiate client IPs using X-Forwarded-For header", async () => {
    const app = express();
    app.set("trust proxy", true);
    app.get("/api/test", apiRateLimiter, (_req, res) => {
      res.status(200).json({ success: true });
    });

    const server = app.listen(0);
    const address = server.address() as any;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const res1 = await fetch(`${baseUrl}/api/test`, {
        headers: { "X-Forwarded-For": "198.51.100.1" },
      });
      const res2 = await fetch(`${baseUrl}/api/test`, {
        headers: { "X-Forwarded-For": "198.51.100.2" },
      });

      assert.strictEqual(res1.status, 200);
      assert.strictEqual(res2.status, 200);
    } finally {
      server.close();
    }
  });

  it("expires requests at the sliding-window boundary and reports retry timing", async () => {
    let now = 1_000;
    const store = new MemorySlidingWindowStore(() => now);
    const bucket = [{ key: "one-client", limit: 2 }];

    assert.equal((await store.consume(bucket, 1_000)).allowed, true);
    now = 1_500;
    assert.equal((await store.consume(bucket, 1_000)).allowed, true);
    now = 1_999;
    const blocked = await store.consume(bucket, 1_000);
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.remaining, 0);
    assert.equal(blocked.resetAfterMs, 1);

    now = 2_000;
    assert.equal((await store.consume(bucket, 1_000)).allowed, true);
  });

  it("enforces concurrent requests atomically in the in-memory fallback", async () => {
    const store = new MemorySlidingWindowStore(() => 10_000);
    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        store.consume([{ key: "burst", limit: 10 }], 60_000)
      )
    );
    assert.equal(results.filter((result) => result.allowed).length, 10);
  });

  it("uses one Redis Lua evaluation for all identity buckets in a request", async () => {
    const calls: unknown[][] = [];
    const redis = {
      eval: async (...args: unknown[]) => {
        calls.push(args);
        return [1, 4, 30_000, 5];
      },
    };
    const store = new RedisSlidingWindowStore(redis as unknown as Redis);
    const result = await store.consume(
      [
        { key: "user-key", limit: 5 },
        { key: "ip-key", limit: 10 },
      ],
      60_000
    );

    assert.equal(calls.length, 1);
    assert.equal(result.allowed, true);
    assert.equal(result.limit, 5);
    assert.equal(result.remaining, 4);
    assert.equal(result.resetAfterMs, 30_000);
    assert.deepEqual(calls[0].slice(1, 3), [2, "user-key"]);
  });

  it("returns 429 with the configured headers when a route group limit is exceeded", async () => {
    const app = express();
    app.set("trust proxy", true);
    app.get(
      "/api/custom",
      createSlidingWindowRateLimiter({
        store: new MemorySlidingWindowStore(),
        routeGroups: [
          {
            name: "custom",
            prefixes: ["/api/custom"],
            tiers: {
              anonymous: { limit: 1, windowMs: 60_000 },
              authenticated: { limit: 5, windowMs: 60_000 },
              webhook: { limit: 10, windowMs: 60_000 },
            },
          },
        ],
      }),
      (_req, res) => res.status(200).end()
    );
    const server = app.listen(0);
    const address = server.address() as any;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      await fetch(`${baseUrl}/api/custom`, {
        headers: { "X-Forwarded-For": "192.0.2.24" },
      });
      const blocked = await fetch(`${baseUrl}/api/custom`, {
        headers: { "X-Forwarded-For": "192.0.2.24" },
      });
      assert.equal(blocked.status, 429);
      assert.equal(blocked.headers.get("x-ratelimit-limit"), "1");
      assert.equal(blocked.headers.get("x-ratelimit-remaining"), "0");
      assert.equal(blocked.headers.get("retry-after"), "60");
    } finally {
      server.close();
    }
  });

  it("applies both per-user and shared per-IP limits to authenticated requests", async () => {
    const app = express();
    app.set("trust proxy", true);
    app.use((req, _res, next) => {
      const userId = req.header("x-test-user");
      if (userId) {
        req.user = {
          id: userId,
          email: `${userId}@example.test`,
          username: userId,
          role: UserRole.USER,
        };
      }
      next();
    });
    app.get(
      "/api/custom",
      createSlidingWindowRateLimiter({
        store: new MemorySlidingWindowStore(),
        routeGroups: [
          {
            name: "custom",
            prefixes: ["/api/custom"],
            tiers: {
              anonymous: { limit: 2, windowMs: 60_000 },
              authenticated: { limit: 5, ipLimit: 2, windowMs: 60_000 },
              webhook: { limit: 10, windowMs: 60_000 },
            },
          },
        ],
      }),
      (_req, res) => res.status(200).end()
    );
    const server = app.listen(0);
    const address = server.address() as any;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const first = await fetch(`${baseUrl}/api/custom`, {
        headers: { "X-Forwarded-For": "192.0.2.25", "X-Test-User": "user-one" },
      });
      const second = await fetch(`${baseUrl}/api/custom`, {
        headers: { "X-Forwarded-For": "192.0.2.25", "X-Test-User": "user-two" },
      });
      const third = await fetch(`${baseUrl}/api/custom`, {
        headers: { "X-Forwarded-For": "192.0.2.25", "X-Test-User": "user-two" },
      });

      assert.equal(first.status, 200);
      assert.equal(second.status, 200);
      assert.equal(third.status, 429);
    } finally {
      server.close();
    }
  });

  it("assigns webhook thresholds only to verified callers on webhook routes", () => {
    assert.equal(getRateLimitTier("/api/webhooks/stellar", false), "anonymous");
    assert.equal(getRateLimitTier("/api/webhooks/stellar", false, true), "webhook");
    assert.equal(getRateLimitTier("/api/players", false, true), "anonymous");
    assert.equal(getRateLimitTier("/api/players", true), "authenticated");
  });
});
