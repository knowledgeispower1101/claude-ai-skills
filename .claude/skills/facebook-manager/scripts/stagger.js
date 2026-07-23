const { z } = require("zod");

// Seconds to wait between Pages, picked at random from [min, max].
// Posting/sharing to many Pages in one burst reads as coordinated spam, so the
// default staggers them; pass {min:0,max:0} only for a single Page.
const DelayRangeSchema = z
  .object({ min: z.number().min(0), max: z.number().min(0) })
  .refine((r) => r.max >= r.min, {
    message: "delayRange.max must be >= delayRange.min",
  });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function randomDelaySeconds({ min, max }) {
  return min + Math.random() * (max - min);
}

function timeLabel(date = new Date()) {
  return date.toLocaleTimeString("vi-VN", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Ho_Chi_Minh",
  });
}

function formatWait(seconds) {
  const whole = Math.round(seconds);
  if (whole < 60) return `${whole}s`;
  const mins = Math.floor(whole / 60);
  const secs = whole % 60;
  return secs ? `${mins}p${secs}s` : `${mins}p`;
}

function formatRemaining(seconds) {
  const mins = Math.round(seconds / 60);
  if (mins < 1) return "sắp xong";
  if (mins < 60) return `còn ~${mins} phút`;
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  return rest ? `còn ~${hours} giờ ${rest} phút` : `còn ~${hours} giờ`;
}

// Timeline-style progress: one clustered report per Page, so a long staggered
// run stays legible while it streams.
function reportProgress(result, results, totalPages, delayRange, next) {
  const line = result.success
    ? `${timeLabel()}  ✅  ${(result.name || result.pageId).trim()}`
    : `${timeLabel()}  ❌  ${(result.name || result.pageId).trim()} — ${result.error}`;

  const done = results.length;
  const ok = results.filter((r) => r.success).length;
  const failed = done - ok;

  // Remaining time is dominated by the pauses, not the API calls.
  const avgDelay = (delayRange.min + delayRange.max) / 2;
  const remainingSeconds = next
    ? next.waitSeconds + (totalPages - done - 1) * avgDelay
    : 0;

  const tail = next ? ` · ${formatRemaining(remainingSeconds)}` : " · hoàn tất";

  console.log(line);
  console.log(`── ${done}/${totalPages} trang · ✅${ok} ❌${failed}${tail} ──`);
  if (next) {
    console.log(`⏳ Kế tiếp: ${next.name} (sau ${formatWait(next.waitSeconds)})`);
  }
}

module.exports = {
  DelayRangeSchema,
  sleep,
  randomDelaySeconds,
  timeLabel,
  formatWait,
  formatRemaining,
  reportProgress,
};
