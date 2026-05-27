import { defineConfig } from "vitest/config";

// Tests need a short blip TTL so we don't wait 5 s per assertion. NODE_ENV
// keeps logPrivate quiet, and LOG_PRIVATE_ROOMS=false silences the dev
// trace lines. These can't live in the test file itself because ES module
// imports are hoisted above any top-level assignments to process.env.
export default defineConfig({
  test: {
    env: {
      PRIVATE_ROOM_BLIP_MS: "200",
      NODE_ENV: "test",
      LOG_PRIVATE_ROOMS: "false",
    },
    testTimeout: 20_000,
  },
});
