const fs = require("fs");
const axios = require("axios");
const FormData = require("form-data");
const { z } = require("zod");
const { appendToLog } = require("./post-log-store");

const GRAPH_VERSION = "v25.0";

// Force every published post to be publicly visible on the Page timeline.
const PUBLIC_PRIVACY = JSON.stringify({ value: "EVERYONE" });

const PageTargetSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  access_token: z.string(),
});

const PostRequestSchema = z
  .object({
    message: z.string().min(1, "message is required"),
    imagePaths: z.array(z.string()).default([]),
    videoPaths: z.array(z.string()).default([]),
    pages: z.array(PageTargetSchema).min(1, "at least one page is required"),
    published: z.boolean().default(true),
    // unix seconds, required when published === false
    scheduledTime: z.number().int().optional(),
    // Drive folder this content came from, kept in the log for traceability
    sourceFolder: z.string().optional(),
    // Seconds to wait between Pages, picked at random from [min, max].
    // Posting to many Pages in one burst reads as coordinated spam, so the
    // default staggers them; pass {min:0,max:0} only for a single Page.
    delayRange: z
      .object({ min: z.number().min(0), max: z.number().min(0) })
      .refine((r) => r.max >= r.min, {
        message: "delayRange.max must be >= delayRange.min",
      })
      .default({ min: 120, max: 300 }),
  })
  .refine((data) => data.published || data.scheduledTime, {
    message: "scheduledTime is required when published is false",
    path: ["scheduledTime"],
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

async function uploadUnpublishedPhoto(pageId, pageToken, imagePath) {
  const form = new FormData();
  form.append("source", fs.createReadStream(imagePath));
  form.append("published", "false");
  form.append("access_token", pageToken);

  const { data } = await axios.post(
    `https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/photos`,
    form,
    { headers: form.getHeaders() },
  );

  return data.id;
}

async function uploadUnpublishedVideo(pageId, pageToken, videoPath) {
  const form = new FormData();
  form.append("source", fs.createReadStream(videoPath));
  form.append("published", "false");
  form.append("access_token", pageToken);

  const { data } = await axios.post(
    `https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/videos`,
    form,
    { headers: form.getHeaders() },
  );

  return data.id;
}

async function postToPage(
  page,
  { message, imagePaths, videoPaths, published, scheduledTime },
) {
  const { id: pageId, name, access_token: pageToken } = page;
  const totalMedia = imagePaths.length + videoPaths.length;

  try {
    let response;

    if (totalMedia === 0) {
      // Text-only post
      const params = { message, access_token: pageToken, privacy: PUBLIC_PRIVACY };
      if (!published) {
        params.published = false;
        params.scheduled_publish_time = scheduledTime;
      }

      response = await axios.post(
        `https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/feed`,
        null,
        { params },
      );
    } else if (imagePaths.length === 1 && videoPaths.length === 0) {
      // Single photo post
      const form = new FormData();
      form.append("source", fs.createReadStream(imagePaths[0]));
      form.append("caption", message);
      form.append("access_token", pageToken);
      form.append("privacy", PUBLIC_PRIVACY);
      if (!published) {
        form.append("published", "false");
        form.append("scheduled_publish_time", String(scheduledTime));
      }

      response = await axios.post(
        `https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/photos`,
        form,
        { headers: form.getHeaders() },
      );
    } else if (imagePaths.length === 0 && videoPaths.length === 1) {
      // Single video post
      const form = new FormData();
      form.append("source", fs.createReadStream(videoPaths[0]));
      form.append("description", message);
      form.append("access_token", pageToken);
      form.append("privacy", PUBLIC_PRIVACY);
      if (!published) {
        form.append("published", "false");
        form.append("scheduled_publish_time", String(scheduledTime));
      }

      response = await axios.post(
        `https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/videos`,
        form,
        { headers: form.getHeaders() },
      );
    } else {
      // Multiple photos/videos: upload each unpublished, then attach to a single feed post
      const mediaIds = await Promise.all([
        ...imagePaths.map((imagePath) =>
          uploadUnpublishedPhoto(pageId, pageToken, imagePath),
        ),
        ...videoPaths.map((videoPath) =>
          uploadUnpublishedVideo(pageId, pageToken, videoPath),
        ),
      ]);

      const params = {
        message,
        access_token: pageToken,
        privacy: PUBLIC_PRIVACY,
        attached_media: JSON.stringify(
          mediaIds.map((mediaId) => ({ media_fbid: mediaId })),
        ),
      };
      if (!published) {
        params.published = false;
        params.scheduled_publish_time = scheduledTime;
      }

      response = await axios.post(
        `https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/feed`,
        null,
        { params },
      );
    }

    return { pageId, name, success: true, postId: response.data.id };
  } catch (error) {
    const errorMessage = error.response?.data?.error?.message || error.message;
    return { pageId, name, success: false, error: errorMessage };
  }
}

async function postContent(request) {
  const {
    message,
    imagePaths,
    videoPaths,
    pages,
    published,
    scheduledTime,
    sourceFolder,
    delayRange,
  } = PostRequestSchema.parse(request);

  // Sequential, not Promise.all: N Pages publishing the same content in the
  // same second is the pattern Facebook's integrity systems flag.
  const results = [];
  // Drawn one iteration ahead so each report can announce the coming pause.
  let pendingWait = 0;

  for (const [index, page] of pages.entries()) {
    if (pendingWait > 0) await sleep(pendingWait * 1000);

    const result = await postToPage(page, {
      message,
      imagePaths,
      videoPaths,
      published,
      scheduledTime,
    });
    results.push({ ...result, createdAt: new Date().toISOString() });

    const nextPage = pages[index + 1];
    pendingWait = nextPage ? randomDelaySeconds(delayRange) : 0;

    reportProgress(
      result,
      results,
      pages.length,
      delayRange,
      nextPage
        ? { name: (nextPage.name || nextPage.id).trim(), waitSeconds: pendingWait }
        : null,
    );
  }

  const logEntries = results
    .filter((result) => result.success)
    .map((result) => ({
      postId: result.postId,
      pageId: result.pageId,
      pageName: result.name,
      published,
      scheduledTime: scheduledTime ?? null,
      createdAt: result.createdAt,
      sourceFolder: sourceFolder ?? null,
      sharedFrom: null,
      message,
      imagePaths,
      videoPaths,
      calendarEventId: null,
    }));

  appendToLog(logEntries);

  return results;
}

async function main() {
  const input = process.argv[2];

  if (!input) {
    console.error(
      'Usage: node post-content.js \'{"message":"...","imagePaths":["..."],"videoPaths":["..."],"pages":[{"id":"...","name":"...","access_token":"..."}],"published":true}\'',
    );
    process.exit(1);
  }

  const request = JSON.parse(input);
  const results = await postContent(request);

  const failures = results.filter((r) => !r.success);
  const ok = results.length - failures.length;

  console.log(`\nXong: ${ok}/${results.length} trang thành công`);
  failures.forEach((f) => console.log(`   ❌ ${(f.name || f.pageId).trim()} — ${f.error}`));
}

if (require.main === module) {
  main().catch((err) => {
    if (err instanceof z.ZodError) {
      console.error("❌ Validation Error:");
      err.issues.forEach((issue) => {
        console.error(`- ${issue.path.join(".")}: ${issue.message}`);
      });
    } else {
      console.error("❌", err.message || err);
    }
    process.exit(1);
  });
}

module.exports = { postContent, postToPage };
