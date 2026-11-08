import { test } from "node:test";
import assert from "node:assert/strict";
import { TerminalService } from "../src/terminal.js";

test("terminal writeRaw delivers bytes as-is; subscribe disposer really removes the listener", async () => {
  const svc = new TerminalService();
  // Stub the PTY backend session (no real node-pty needed).
  const written = [];
  const listeners = new Set();
  const fake = {
    motd: "",
    write: (t) => { written.push(t); for (const fn of [...listeners]) fn("x"); },
    onData: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    close: async () => {},
  };
  svc.sessions.set("term-test01", { backend: null, session: fake, owner: "u", output: "", listeners: new Set() });
  let got = 0;
  const off = svc.subscribe("term-test01", "u", () => { got++; });
  svc.writeRaw("term-test01", "u", "l");
  svc.writeRaw("term-test01", "u", "s");
  assert.deepEqual(written, ["l", "s"]); // no newline appended per keystroke
  assert.equal(got, 2);
  off();
  svc.writeRaw("term-test01", "u", "x");
  assert.equal(got, 2); // listener removed
  assert.throws(() => svc.writeRaw("term-test01", "other", "z"), /owned by another/);
});
