const axios = require("axios");
const { z } = require("zod");
const { appendToLog } = require("./post-log-store");
const {
  DelayRangeSchema,
  sleep,
  randomDelaySeconds,
  reportProgress,
} = require("./stagger");

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
    delayRange: DelayRangeSchema.default({ min: 120, max: 300 }),
  })
  .refine((data) => data.published || data.scheduledTime, {
    message: "scheduledTime is required when published is false",
    path: ["scheduledTime"],
  });

async function shareContent(request) {
  const {
    sourcePostId,
    sourcePermalinkUrl,
    message,
    targetPages,
    published,
    scheduledTime,
    delayRange,
  } = ShareRequestSchema.parse(request);

  // Sequential, not Promise.all: N Pages sharing the same link in the same
  // second is the pattern Facebook's integrity systems flag.
  const results = [];
  // Drawn one iteration ahead so each report can announce the coming pause.
  let pendingWait = 0;

  for (const [index, page] of targetPages.entries()) {
    if (pendingWait > 0) await sleep(pendingWait * 1000);

    const result = await shareToPage(page, {
      permalinkUrl: sourcePermalinkUrl,
      message,
      published,
      scheduledTime,
    });
    const createdAt = new Date().toISOString();
    results.push({ ...result, createdAt });

    // Log after every Page, not once at the end: a staggered run takes a while,
    // and if it is interrupted the shares already published must still be
    // recorded or there is no way to find and delete them later.
    if (result.success) {
      appendToLog([
        {
          postId: result.postId,
          pageId: result.pageId,
          pageName: result.name,
          published,
          scheduledTime: scheduledTime ?? null,
          createdAt,
          sourceFolder: null,
          sharedFrom: sourcePostId,
          message: message ?? null,
          imagePaths: [],
          videoPaths: [],
          calendarEventId: null,
        },
      ]);
    }

    const nextPage = targetPages[index + 1];
    pendingWait = nextPage ? randomDelaySeconds(delayRange) : 0;

    reportProgress(
      result,
      results,
      targetPages.length,
      delayRange,
      nextPage
        ? { name: (nextPage.name || nextPage.id).trim(), waitSeconds: pendingWait }
        : null,
    );
  }

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
