const fs = require("fs");
const axios = require("axios");
const FormData = require("form-data");
const { z } = require("zod");
const { appendToLog } = require("./post-log-store");

const GRAPH_VERSION = "v25.0";

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
  })
  .refine((data) => data.published || data.scheduledTime, {
    message: "scheduledTime is required when published is false",
    path: ["scheduledTime"],
  });

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
      const params = { message, access_token: pageToken };
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
  } = PostRequestSchema.parse(request);

  const results = await Promise.all(
    pages.map((page) =>
      postToPage(page, { message, imagePaths, videoPaths, published, scheduledTime }),
    ),
  );

  const logEntries = results
    .filter((result) => result.success)
    .map((result) => ({
      postId: result.postId,
      pageId: result.pageId,
      pageName: result.name,
      published,
      scheduledTime: scheduledTime ?? null,
      createdAt: new Date().toISOString(),
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

  results.forEach((result) => {
    if (result.success) {
      console.log(`✅ ${result.name || result.pageId}: post ${result.postId}`);
    } else {
      console.error(`❌ ${result.name || result.pageId}: ${result.error}`);
    }
  });

  console.log(JSON.stringify(results));
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
