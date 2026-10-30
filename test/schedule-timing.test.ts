import assert from "node:assert/strict";
import { test } from "node:test";
import { describeWhen, nextRun, parseWhen, shortestGapMinutes, upcomingRuns, wallClock } from "../src/schedules/when.ts";

const iso = (dates: Date[]) => dates.map((date) => date.toISOString());

test("cron times are wall-clock times in the schedule's time zone", () => {
  const from = new Date("2026-10-30T12:34:56Z"); // a Friday
  const weekdays = parseWhen("0 9 * * 1-5");
  assert.deepEqual(iso(upcomingRuns(weekdays, "Asia/Seoul", from, from, 3)), ["2026-11-02T00:00:00.000Z", "2026-11-03T00:00:00.000Z", "2026-11-04T00:00:00.000Z"]);
  assert.equal(describeWhen(weekdays, "Asia/Seoul"), "every weekday at 09:00 Asia/Seoul");
  assert.deepEqual(iso(upcomingRuns(parseWhen("*/15 * * * *"), "UTC", from, from, 2)), ["2026-10-30T12:45:00.000Z", "2026-10-30T13:00:00.000Z"]);
  assert.deepEqual(iso(upcomingRuns(parseWhen("0 9,17 * * mon,thu"), "Europe/London", from, from, 3)), ["2026-11-02T09:00:00.000Z", "2026-11-02T17:00:00.000Z", "2026-11-05T09:00:00.000Z"]);
  assert.equal(describeWhen(parseWhen("0 9,17 * * mon,thu"), "Europe/London"), "every Monday and Thursday at 09:00 and 17:00 Europe/London");
  assert.equal(nextRun(parseWhen("0 0 29 2 *"), "UTC", from)!.toISOString(), "2028-02-29T00:00:00.000Z");
  assert.equal(describeWhen(parseWhen("@weekly"), "UTC"), "every Sunday at 00:00 UTC");
  assert.equal(describeWhen(parseWhen("15 * * * *"), "UTC"), "every hour at :15");
  // Day of month and day of week both restricted: either one will do, as in cron.
  assert.deepEqual(iso(upcomingRuns(parseWhen("0 12 13 * 5"), "UTC", from, from, 2)), ["2026-11-06T12:00:00.000Z", "2026-11-13T12:00:00.000Z"]);
});

test("a clock going back for daylight saving doesn't run a schedule twice", () => {
  // New York leaves summer time at 02:00 on 1 November 2026, so 01:30 happens twice.
  const runs = upcomingRuns(parseWhen("30 1 * * *"), "America/New_York", new Date("2026-10-31T12:00:00Z"), new Date(), 2);
  assert.deepEqual(iso(runs), ["2026-11-01T05:30:00.000Z", "2026-11-02T06:30:00.000Z"]);
  assert.deepEqual(runs.map((run) => wallClock(run, "America/New_York")), ["2026-11-01 01:30", "2026-11-02 01:30"]);
  // ...and a time skipped when the clock goes forward is skipped that day.
  const spring = upcomingRuns(parseWhen("30 2 * * *"), "America/New_York", new Date("2027-03-13T12:00:00Z"), new Date(), 2);
  assert.deepEqual(spring.map((run) => wallClock(run, "America/New_York")), ["2027-03-15 02:30", "2027-03-16 02:30"]);
});

test("intervals count from when the schedule was made", () => {
  const made = new Date("2026-10-30T10:00:00Z");
  const every6h = parseWhen("every 6h");
  assert.equal(nextRun(every6h, "UTC", made, made)!.toISOString(), "2026-10-30T16:00:00.000Z");
  assert.equal(nextRun(every6h, "UTC", new Date("2026-10-31T05:00:00Z"), made)!.toISOString(), "2026-10-31T10:00:00.000Z");
  assert.equal(describeWhen(every6h, "UTC"), "every 6 hours");
  assert.equal(describeWhen(parseWhen("every week"), "UTC"), "every week");
  assert.equal(describeWhen(parseWhen("every 90 minutes"), "UTC"), "every 90 minutes");
  assert.equal(shortestGapMinutes(parseWhen("every 2d"), "UTC"), 2880);
  assert.equal(shortestGapMinutes(parseWhen("*/5 9 * * *"), "UTC"), 5);
  assert.equal(shortestGapMinutes(parseWhen("0 9 * * *"), "UTC"), 1440);
});

test("bad timings say what's wrong", () => {
  const problems: [string, RegExp][] = [
    ["* * *", /five cron fields/],
    ["61 * * * *", /out of range for the minute field/],
    ["0 25 * * *", /out of range for the hour field/],
    ["0 0 * * 8", /day of the week/],
    ["every 0m", /at least 1/],
    ["every fortnight", /isn't an interval/],
    ["@often", /Unknown shortcut/],
    ["a b c d e", /isn't a valid minute/],
    ["*/0 * * * *", /bad step/],
  ];
  for (const [text, message] of problems) assert.throws(() => parseWhen(text), message, text);
  assert.equal(nextRun(parseWhen("0 0 31 2 *"), "UTC", new Date()), null, "February 31st never comes");
});
