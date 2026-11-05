// Accessory tests with real HAP characteristics and a stand-in for the Genie client.
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const hap = require("@homebridge/hap-nodejs");
const {
  GenieAladdinConnectGarageDoorAccessory,
} = require("../dist/platformAccessory");

const { Characteristic, Service, Accessory, uuid } = hap;
const { CurrentDoorState: Current, TargetDoorState: Target } = Characteristic;
const S = { UNKNOWN: 0, OPEN: 1, OPENING: 2, CLOSED: 4, CLOSING: 5 };

let genie;
let accessory;
let service;
let warnings;

function report(status) {
  genie.listener({ ...genie.door, status, fault: false, batteryPercent: null });
}

beforeEach(() => {
  warnings = [];
  const log = {
    debug() {},
    info() {},
    warn: (...a) => warnings.push(a),
    error() {},
  };
  const door = {
    deviceId: 42,
    index: 1,
    id: "ABCDEF123456_1",
    name: "Garage Door",
    hasBatteryLevel: false,
  };
  genie = {
    door,
    commands: [],
    fail: false,
    subscribe(_door, fn) {
      this.listener = fn;
    },
    async setDoorStatus(_door, desired) {
      if (this.fail) throw new Error("boom");
      this.commands.push(desired);
      return Date.now() + 60 * 1000;
    },
  };
  const platformAccessory = new Accessory("Garage Door", uuid.generate("test"));
  platformAccessory.context = { door };
  const platform = {
    log,
    api: { hap },
    aladdinConnect: genie,
    config: {},
    Service,
    Characteristic,
  };
  new GenieAladdinConnectGarageDoorAccessory(platform, platformAccessory);
  accessory = platformAccessory;
  service = accessory.getService(Service.GarageDoorOpener);
});

const target = () => service.getCharacteristic(Target).value;
const current = () => service.getCharacteristic(Current).value;
const tapTarget = (v) => service.getCharacteristic(Target).handleSetRequest(v);

test("reflects the door position reported by Genie", () => {
  report(S.CLOSED);
  assert.equal(current(), Current.CLOSED);
  assert.equal(target(), Target.CLOSED);
  report(S.OPEN);
  assert.equal(current(), Current.OPEN);
  assert.equal(target(), Target.OPEN);
});

test("the Home app toggle does not flip back while Genie catches up after a command", async () => {
  report(S.CLOSED);
  await tapTarget(Target.OPEN);
  assert.deepEqual(genie.commands, [1]);
  report(S.CLOSED); // Genie has not noticed yet
  assert.equal(target(), Target.OPEN);
  report(S.OPENING);
  assert.equal(target(), Target.OPEN);
  report(S.OPEN);
  assert.equal(target(), Target.OPEN);
});

test("a command the door never acts on is given up after the timeout", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  report(S.CLOSED);
  await tapTarget(Target.OPEN);
  t.mock.timers.tick(61 * 1000);
  report(S.CLOSED);
  assert.equal(target(), Target.CLOSED);
  assert.equal(warnings.length, 1);
});

test("the target is let go at the client's deadline, when fast polling stops", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  genie.setDoorStatus = async () => Date.now() + 5000; // client gives up after 5 s
  report(S.CLOSED);
  await tapTarget(Target.OPEN);
  t.mock.timers.tick(5000);
  report(S.CLOSED);
  assert.equal(target(), Target.CLOSED);
});

test("a failed command puts the toggle back and reports an error to HomeKit", async () => {
  report(S.CLOSED);
  genie.fail = true;
  await assert.rejects(tapTarget(Target.OPEN));
  await new Promise((r) => setImmediate(r));
  assert.equal(target(), Target.CLOSED);
  // ...and a later retry is not swallowed as a duplicate
  genie.fail = false;
  await tapTarget(Target.OPEN);
  assert.deepEqual(genie.commands, [1]);
});

test("an unknown door status does not throw and keeps the last target", () => {
  report(S.OPEN);
  assert.doesNotThrow(() => report(S.UNKNOWN));
  assert.doesNotThrow(() => report(99));
  assert.equal(current(), Current.STOPPED);
  assert.equal(target(), Target.OPEN);
});

test("reading the target before the first status update does not fail", async () => {
  const value = await service.getCharacteristic(Target).handleGetRequest();
  assert.ok([Target.OPEN, Target.CLOSED].includes(value));
});
