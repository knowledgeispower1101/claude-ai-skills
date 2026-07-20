const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { getPages } = require("./get-token");
const { readAllLogs, removeEntry } = require("./post-log-store");

const GRAPH_VERSION = "v24.0";

async function deletePost(postId, accessToken) {
  const { data } = await axios.delete(
    `https://graph.facebook.com/${GRAPH_VERSION}/${postId}`,
    { params: { access_token: accessToken } },
  );

  return data;
}

function cleanupLocalMedia(deletedEntry, remainingLog) {
  const mediaPaths = [
    ...(deletedEntry.imagePaths || []),
    ...(deletedEntry.videoPaths || []),
  ];
  if (mediaPaths.length === 0) return [];

  // Other Pages may still be logged against the same local media (same
  // content posted to multiple Pages) — only delete files no longer
  // referenced by any remaining log entry.
  const stillReferenced = new Set();
  remainingLog.forEach((item) => {
    (item.imagePaths || []).forEach((mediaPath) => stillReferenced.add(mediaPath));
    (item.videoPaths || []).forEach((mediaPath) => stillReferenced.add(mediaPath));
  });

  const removed = [];
  const dirsToCheck = new Set();

  mediaPaths.forEach((mediaPath) => {
    if (stillReferenced.has(mediaPath)) return;

    const absolutePath = path.join(__dirname, mediaPath);
    if (fs.existsSync(absolutePath)) {
      fs.unlinkSync(absolutePath);
      removed.push(mediaPath);
      dirsToCheck.add(path.dirname(absolutePath));
    }
  });

  dirsToCheck.forEach((dir) => {
    if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
      fs.rmdirSync(dir);
    }
  });

  return removed;
}

async function deleteLoggedPost(postId) {
  const entry = readAllLogs().find((item) => item.postId === postId);

  if (!entry) {
    throw new Error(`No log entry found for postId "${postId}"`);
  }

  const pages = await getPages();
  const page = pages.find((item) => item.id === entry.pageId);

  if (!page) {
    throw new Error(
      `Page "${entry.pageId}" not found among currently accessible Pages`,
    );
  }

  await deletePost(postId, page.access_token);

  removeEntry(postId);
  const remainingLog = readAllLogs();

  const removedMedia = cleanupLocalMedia(entry, remainingLog);

  return {
    postId,
    pageId: entry.pageId,
    pageName: entry.pageName,
    removedImages: removedMedia,
    calendarEventId: entry.calendarEventId || null,
  };
}

async function main() {
  const postId = process.argv[2];

  if (!postId) {
    console.error("Usage: node delete-post.js <postId>");
    process.exit(1);
  }

  const result = await deleteLoggedPost(postId);
  console.log(
    `✅ Deleted post ${result.postId} from ${result.pageName || result.pageId}`,
  );
  if (result.removedImages.length > 0) {
    console.log(`🗑️  Removed local images: ${result.removedImages.join(", ")}`);
  }
  console.log(JSON.stringify(result));
}

if (require.main === module) {
  main().catch((err) => {
    console.error("❌", err.response?.data?.error?.message || err.message);
    process.exit(1);
  });
}

module.exports = { deletePost, deleteLoggedPost };
