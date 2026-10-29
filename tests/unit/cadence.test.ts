import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { accrueAwake, isActiveHour, localHour, monthKey, parseActiveHours, projectMonth, shouldPollHealth } from "@/lib/cadence";

const TZ = "Asia/Kolkata"; // UTC+5:30

describe("health cadence (ADR 0002)", () => {
  test("local hour in the configured timezone", () => {
    assert.equal(localHour(new Date("2026-10-29T03:30:00Z"), TZ), 9);
    assert.equal(localHour(new Date("2026-10-29T18:29:00Z"), TZ), 23);
  });

  test("active hours parse, with a safe default", () => {
    assert.deepEqual(parseActiveHours("07-23"), { start: 7, end: 23 });
    assert.deepEqual(parseActiveHours("garbage"), { start: 7, end: 23 });
    assert.ok(isActiveHour(23, { start: 22, end: 6 }));
    assert.ok(isActiveHour(3, { start: 22, end: 6 }));
    assert.ok(!isActiveHour(12, { start: 22, end: 6 }));
  });

  test("every tick during active hours", () => {
    const noonIst = new Date("2026-10-29T06:30:00Z");
    assert.ok(shouldPollHealth(noonIst, TZ, "07-23", new Date(noonIst.getTime() - 5 * 60_000)));
  });

  test("overnight only when the last poll is ~an hour old", () => {
    const threeAmIst = new Date("2026-10-28T21:30:00Z");
    assert.ok(!shouldPollHealth(threeAmIst, TZ, "07-23", new Date(threeAmIst.getTime() - 30 * 60_000)));
    assert.ok(shouldPollHealth(threeAmIst, TZ, "07-23", new Date(threeAmIst.getTime() - 56 * 60_000)));
    assert.ok(shouldPollHealth(threeAmIst, TZ, "07-23", null));
  });
});

describe("free-hours estimate", () => {
  const t = new Date("2026-10-29T10:00:00Z");
  test("waking a sleeping app costs 15 min awake plus 1 min spin-up", () => {
    assert.equal(accrueAwake(null, t).addedMinutes, 16);
  });
  test("a poll while still awake only adds the extension", () => {
    const first = accrueAwake(null, t);
    const second = accrueAwake(first.awakeUntil, new Date(t.getTime() + 10 * 60_000));
    assert.equal(second.addedMinutes, 10);
  });
  test("15-min polls all day cost ~24 h a day (why active hours exist)", () => {
    let awake: Date | null = null;
    let minutes = 0;
    for (let i = 0; i < 96; i++) {
      const r = accrueAwake(awake, new Date(t.getTime() + i * 15 * 60_000));
      minutes += r.addedMinutes;
      awake = r.awakeUntil;
    }
    assert.ok(minutes / 60 > 23.9 && minutes / 60 < 24.1);
  });
  test("month key and projection", () => {
    assert.equal(monthKey(t), "2026-10");
    const mid = new Date("2026-10-16T12:00:00Z");
    assert.ok(Math.abs(projectMonth(250, mid) - 500) < 10);
  });
});
