const axios = require("axios");
const { z } = require("zod");
const { appendToLog } = require("./post-log-store");

const GRAPH_VERSION = "v24.0";

const PageSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  access_token: z.string(),
});

// Recent posts of a Page, for the user to pick which one to share.
async function listRecentPosts(page, limit = 8) {
  const { data } = await axios.get(
    `https://graph.facebook.com/${GRAPH_VERSION}/${page.id}/posts`,
    {
      params: {
        access_token: page.access_token,
        fields: "id,message,created_time,permalink_url,full_picture",
        limit,
      },
    },
  );

  return data.data || [];
}

async function shareToPage(targetPage, { permalinkUrl, message, published, scheduledTime }) {
  try {
    const params = {
      link: permalinkUrl,
      access_token: targetPage.access_token,
    };
    if (message) params.message = message;
    if (!published) {
      params.published = false;
      params.scheduled_publish_time = scheduledTime;
    }

    const { data } = await axios.post(
      `https://graph.facebook.com/${GRAPH_VERSION}/${targetPage.id}/feed`,
      null,
      { params },
    );

    return { pageId: targetPage.id, name: targetPage.name, success: true, postId: data.id };
  } catch (error) {
    const errorMessage = error.response?.data?.error?.message || error.message;
    return { pageId: targetPage.id, name: targetPage.name, success: false, error: errorMessage };
  }
}

const ShareRequestSchema = z
  .object({
    sourcePostId: z.string(),
    sourcePermalinkUrl: z.string().url(),
    message: z.string().optional(),
    targetPages: z.array(PageSchema).min(1, "at least one target page is required"),
    published: z.boolean().default(true),
    scheduledTime: z.number().int().optional(),
  })
  .refine((data) => data.published || data.scheduledTime, {
    message: "scheduledTime is required when published is false",
    path: ["scheduledTime"],
  });

async function shareContent(request) {
  const { sourcePostId, sourcePermalinkUrl, message, targetPages, published, scheduledTime } =
    ShareRequestSchema.parse(request);

  const results = await Promise.all(
    targetPages.map((page) =>
      shareToPage(page, { permalinkUrl: sourcePermalinkUrl, message, published, scheduledTime }),
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
      sourceFolder: null,
      sharedFrom: sourcePostId,
      message: message ?? null,
      imagePaths: [],
      calendarEventId: null,
    }));

  appendToLog(logEntries);

  return results;
}

async function main() {
  const [subcommand, input] = process.argv.slice(2);

  if (subcommand === "list") {
    if (!input) {
      console.error(
        'Usage: node share-post.js list \'{"id":"...","name":"...","access_token":"..."}\'',
      );
      process.exit(1);
    }

    const page = PageSchema.parse(JSON.parse(input));
    const posts = await listRecentPosts(page);
    console.log(JSON.stringify(posts, null, 2));
    return;
  }

  if (!subcommand) {
    console.error(
      'Usage:\n' +
        '  node share-post.js list \'{"id":"...","name":"...","access_token":"..."}\'\n' +
        '  node share-post.js \'{"sourcePostId":"...","sourcePermalinkUrl":"...","targetPages":[{"id":"...","name":"...","access_token":"..."}],"published":true}\'',
    );
    process.exit(1);
  }

  const request = JSON.parse(subcommand);
  const results = await shareContent(request);

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
        console.error(`   - ${issue.path.join(".")}: ${issue.message}`);
      });
    } else {
      console.error("❌", err.response?.data?.error?.message || err.message);
    }
    process.exit(1);
  });
}

module.exports = { listRecentPosts, shareContent, shareToPage };
