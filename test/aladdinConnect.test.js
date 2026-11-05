// Tests run against the compiled plugin in dist/ with a fake Genie/Cognito API plugged in as the
// axios adapter, so the real retry and caching behaviour is exercised without network access.
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { AxiosError } = require("axios");
const { AladdinConnect } = require("../dist/aladdinConnect");

const log = { debug() {}, info() {}, warn() {}, error() {} };

function door(status = 4) {
  return {
    id: "ABCDEF123456_1",
    door_index: 1,
    name: "Garage Door",
    status,
    link_status: 3,
    battery_level: 0,
    fault: 0,
  };
}

function fakeApi() {
  const api = {
    calls: [],
    doorStatus: 4,
    authStatus: 200,
    devicesStatus: 200,
    expiresIn: 3600,
    refreshStatus: 200,
    rejectTokens: [],
  };
  api.adapter = async (config) => {
    const url = config.url;
    const target = config.headers?.["X-Amz-Target"] ?? "";
    const body =
      typeof config.data === "string"
        ? JSON.parse(config.data || "{}")
        : config.data;
    api.calls.push({
      method: config.method,
      url,
      flow: body?.AuthFlow,
      body,
      auth: config.headers?.Authorization,
    });
    const reply = (status, data) => {
      const response = {
        status,
        statusText: String(status),
        headers: {},
        config,
        data,
      };
      if (status >= 400) {
        throw new AxiosError(
          `HTTP ${status}`,
          AxiosError.ERR_BAD_RESPONSE,
          config,
          null,
          response,
        );
      }
      return response;
    };
    if (url.includes("cognito-idp") && target.endsWith("InitiateAuth")) {
      if (body.AuthFlow === "REFRESH_TOKEN_AUTH" && api.refreshStatus !== 200) {
        return reply(
          api.refreshStatus,
          api.refreshStatus === 400
            ? { __type: "NotAuthorizedException", message: "Invalid Refresh Token" }
            : {},
        );
      }
      return reply(api.authStatus, {
        AuthenticationResult: {
          AccessToken: `token-${api.calls.length}`,
          IdToken: "x.eyJjb2duaXRvOnVzZXJuYW1lIjoidXNlci1zdWIifQ.x",
          RefreshToken:
            body.AuthFlow === "REFRESH_TOKEN_AUTH" ? undefined : "refresh-1",
          ExpiresIn: api.expiresIn,
          TokenType: "Bearer",
        },
      });
    }
    if (url.endsWith("/devices")) {
      if (
        api.rejectTokens.length &&
        api.rejectTokens.includes(config.headers?.Authorization)
      ) {
        return reply(401, { message: "Unauthorized" });
      }
      return reply(api.devicesStatus, {
        devices: [
          {
            id: 42,
            serial_number: "ABCDEF123456",
            ownership: "owned",
            doors: [door(api.doorStatus)],
          },
        ],
      });
    }
    if (url.includes("/command/")) {
      return reply(200, {});
    }
    return reply(404, {});
  };
  return api;
}

let api;
let client;

const PubSub = require("pubsub-js");

beforeEach(() => {
  PubSub.clearAllSubscriptions();
  api = fakeApi();
  client = new AladdinConnect(log, {
    username: "me@example.com",
    password: "secret",
  });
  client.session.defaults.adapter = api.adapter;
  // Never let a real poll timer outlive its test.
  client.scheduled = [];
  client.schedulePoll = (ms) => {
    client.scheduled.push(ms);
    client.pollTimer = null;
  };
});

const count = (pred) => api.calls.filter(pred).length;
const logins = () => count((c) => c.url.includes("cognito-idp"));
const deviceFetches = () => count((c) => c.url.endsWith("/devices"));

test("access token is reused for its lifetime instead of logging in on every call", async () => {
  api.expiresIn = 120; // 60 s usable lifetime after the 60 s safety margin
  await client.getAllDoors();
  await new Promise((r) => setTimeout(r, 50));
  await client.getAllDoors();
  assert.equal(deviceFetches(), 2);
  assert.equal(logins(), 1);
});

test("every status request goes to Genie (there is no status cache)", async () => {
  await client.getAllDoors();
  api.doorStatus = 2;
  const [d] = await client.getAllDoors();
  assert.equal(deviceFetches(), 2);
  assert.equal(d.status, 2);
});

test("a rejected login is not retried", async () => {
  api.authStatus = 400;
  await assert.rejects(client.getAllDoors());
  assert.equal(logins(), 1);
});

test("server errors are retried", async () => {
  let failures = 1;
  const inner = api.adapter;
  client.session.defaults.adapter = async (config) => {
    if (config.url.endsWith("/devices") && failures-- > 0) {
      const response = {
        status: 503,
        statusText: "503",
        headers: {},
        config,
        data: {},
      };
      throw new AxiosError(
        "HTTP 503",
        AxiosError.ERR_BAD_RESPONSE,
        config,
        null,
        response,
      );
    }
    return inner(config);
  };
  const doors = await client.getAllDoors();
  assert.equal(doors.length, 1);
});

test("an expired access token is renewed with the refresh token, not the password", async () => {
  api.expiresIn = 60; // expires immediately once the 60 s safety margin is applied
  await client.getAllDoors();
  await client.getAllDoors();
  const flows = api.calls.filter((c) => c.flow).map((c) => c.flow);
  assert.deepEqual(flows, ["USER_PASSWORD_AUTH", "REFRESH_TOKEN_AUTH"]);
  const refresh = api.calls.find((c) => c.flow === "REFRESH_TOKEN_AUTH").body
    .AuthParameters;
  assert.equal(refresh.REFRESH_TOKEN, "refresh-1");
  assert.equal(refresh.PASSWORD, undefined);
  // The secret hash for refreshes is computed from Cognito's username (from the ID token).
  const { createHmac } = require("crypto");
  const expected = createHmac(
    "sha256",
    "7bokto0ep96055k42fnrmuth84k7jdcjablestb7j53o8lp63v5",
  )
    .update("user-sub" + "27iic8c3bvslqngl3hso83t74b")
    .digest("base64");
  assert.equal(refresh.SECRET_HASH, expected);
});

test("a refresh token Cognito rejects falls back to a password login", async () => {
  api.expiresIn = 60;
  api.refreshStatus = 400;
  await client.getAllDoors();
  await client.getAllDoors();
  const flows = api.calls.filter((c) => c.flow).map((c) => c.flow);
  assert.deepEqual(flows, [
    "USER_PASSWORD_AUTH",
    "REFRESH_TOKEN_AUTH",
    "USER_PASSWORD_AUTH",
  ]);
});

test("a refresh that fails for another reason keeps the refresh token and skips the password", async () => {
  api.expiresIn = 60;
  await client.getAllDoors();
  api.refreshStatus = 503; // outlasts the retries
  await assert.rejects(client.getAllDoors());
  api.refreshStatus = 200;
  await client.getAllDoors();
  const flows = api.calls.filter((c) => c.flow).map((c) => c.flow);
  assert.equal(flows.filter((f) => f === "USER_PASSWORD_AUTH").length, 1);
  assert.equal(flows.at(-1), "REFRESH_TOKEN_AUTH");
});

test("a token rejected by Genie (401) is replaced and the request retried once", async () => {
  await client.getAllDoors();
  api.rejectTokens = [api.calls.find((c) => c.auth)?.auth];
  const doors = await client.getAllDoors();
  assert.equal(doors.length, 1);
  assert.equal(logins(), 2);
});

// Poll scheduling: replace the timer with a recorder and drive poll() by hand.
function recordPolls() {
  const scheduled = client.scheduled;
  const sub = client.subscribe(
    { deviceId: 42, index: 1, name: "Garage Door" },
    (info) => (sub.last = info),
  );
  return { scheduled, sub };
}

test("polls every 15 s while the door is still", async () => {
  const { scheduled } = recordPolls();
  await client.poll();
  assert.equal(scheduled.at(-1), 15000);
});

test("polls every 3 s while the door is moving", async () => {
  const { scheduled } = recordPolls();
  api.doorStatus = 2; // OPENING
  await client.poll();
  assert.equal(scheduled.at(-1), 3000);
});

test("uses the configured poll interval while the door is still", async () => {
  client.config.doorStatusPollInterval = 5000;
  const { scheduled } = recordPolls();
  await client.poll();
  assert.equal(scheduled.at(-1), 5000);
});

test("polls fast right after a command, before Genie reports movement", async () => {
  const { scheduled } = recordPolls();
  const [d] = await client.getAllDoors();
  await client.setDoorStatus(d, 1);
  assert.equal(scheduled.at(-1), 1000);
  await client.poll(); // Genie still says CLOSED
  assert.equal(scheduled.at(-1), 3000);
});

test("stops fast polling as soon as the door reaches the commanded position", async () => {
  const { scheduled } = recordPolls();
  const [d] = await client.getAllDoors();
  await client.setDoorStatus(d, 1); // OPEN
  api.doorStatus = 2; // OPENING
  await client.poll();
  assert.equal(scheduled.at(-1), 3000);
  api.doorStatus = 1; // OPEN
  await client.poll();
  assert.equal(scheduled.at(-1), 15000);
});

test("stops fast polling when Genie reports a timeout", async () => {
  const { scheduled } = recordPolls();
  const [d] = await client.getAllDoors();
  await client.setDoorStatus(d, 1);
  api.doorStatus = 3; // TIMEOUT_OPENING
  await client.poll();
  assert.equal(scheduled.at(-1), 15000);
});

test("a retry after a timeout keeps fast polling until the door moves or times out again", async () => {
  const { scheduled } = recordPolls();
  api.doorStatus = 3; // TIMEOUT_OPENING from the failed first attempt
  const [d] = await client.getAllDoors();
  await client.setDoorStatus(d, 1); // OPEN again
  await client.poll(); // Genie still shows the old timeout
  assert.equal(scheduled.at(-1), 3000);
  api.doorStatus = 2; // OPENING
  await client.poll();
  api.doorStatus = 3; // timed out again
  await client.poll();
  assert.equal(scheduled.at(-1), 15000);
});

test("a leftover timeout from the other direction does not end fast polling", async () => {
  const { scheduled } = recordPolls();
  api.doorStatus = 3; // TIMEOUT_OPENING from an earlier open
  const [d] = await client.getAllDoors();
  await client.setDoorStatus(d, 0); // CLOSE; Genie hasn't caught up yet
  await client.poll();
  assert.equal(scheduled.at(-1), 3000);
});

test("stops fast polling when a command the door never acts on times out", async (t) => {
  const { scheduled } = recordPolls();
  const [d] = await client.getAllDoors();
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  await client.setDoorStatus(d, 1); // Genie keeps saying CLOSED
  await client.poll();
  assert.equal(scheduled.at(-1), 3000);
  t.mock.timers.tick(60 * 1000);
  await client.poll();
  assert.equal(scheduled.at(-1), 15000);
});

test("backs off while Genie is unreachable and recovers", async () => {
  const { scheduled } = recordPolls();
  api.devicesStatus = 503;
  await client.poll();
  await client.poll();
  assert.deepEqual(scheduled.slice(-2), [30000, 60000]);
  api.devicesStatus = 200;
  await client.poll();
  assert.equal(scheduled.at(-1), 15000);
});
