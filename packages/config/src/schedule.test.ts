import assert from "node:assert/strict";
import test from "node:test";

import { CHECK_TIMES, TIME_ZONE } from "./schedule.ts";

test("uses the twelve approved Asia/Shanghai check times", () => {
  assert.equal(TIME_ZONE, "Asia/Shanghai");
  assert.deepEqual(CHECK_TIMES, [
    "03:30",
    "09:30",
    "10:30",
    "11:30",
    "12:30",
    "13:30",
    "14:30",
    "15:30",
    "16:30",
    "17:30",
    "18:30",
    "22:30"
  ]);
});
