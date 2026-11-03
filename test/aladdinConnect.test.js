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
  };
  api.adapter = async (config) => {
    const url = config.url;
    const target = config.headers?.["X-Amz-Target"] ?? "";
    const body =
      typeof config.data === "string"
        ? JSON.parse(config.data || "{}")
        : config.data;
    api.calls.push({ method: config.method, url, flow: body?.AuthFlow });
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
      return reply(api.authStatus, {
        AuthenticationResult: {
          AccessToken: `token-${api.calls.length}`,
          IdToken: "x.eyJjb2duaXRvOnVzZXJuYW1lIjoidXNlci1zdWIifQ.x",
          RefreshToken: "refresh-1",
          ExpiresIn: api.expiresIn,
          TokenType: "Bearer",
        },
      });
    }
    if (url.endsWith("/devices")) {
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

beforeEach(() => {
  api = fakeApi();
  client = new AladdinConnect(log, {
    username: "me@example.com",
    password: "secret",
  });
  client.session.defaults.adapter = api.adapter;
});

const count = (pred) => api.calls.filter(pred).length;
const logins = () => count((c) => c.url.includes("cognito-idp"));
const deviceFetches = () => count((c) => c.url.endsWith("/devices"));

test("access token is reused for its lifetime instead of logging in on every call", async () => {
  api.expiresIn = 60; // 30 s usable lifetime after the 30 s safety margin
  await client.getAllDoors();
  await new Promise((r) => setTimeout(r, 50));
  await client.getAllDoors();
  assert.equal(logins(), 1);
});

test("door status is cached for the configured number of seconds", async () => {
  await client.getAllDoors();
  await new Promise((r) => setTimeout(r, 50));
  await client.getAllDoors();
  assert.equal(deviceFetches(), 1);
});

test("a command invalidates the cached door status", async () => {
  const [d] = await client.getAllDoors();
  await client.setDoorStatus(d, 1);
  api.doorStatus = 2;
  const [after] = await client.getAllDoors();
  assert.equal(deviceFetches(), 2);
  assert.equal(after.status, 2);
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
