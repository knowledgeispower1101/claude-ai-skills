const fs = require("fs");
const path = require("path");
const axios = require("axios");

const GRAPH_VERSION = "v24.0";
const MEDIA_ROOT = path.join(__dirname, "images");

// Pulls a published post's caption and media so it can be re-posted natively to
// other Pages. Sharing the post's permalink as a `link` instead makes every
// target Page publish the same URL, which Facebook hides as coordinated spam.
async function fetchSourcePost(postId, sourcePage) {
  const { data } = await axios.get(
    `https://graph.facebook.com/${GRAPH_VERSION}/${postId}`,
    {
      params: {
        access_token: sourcePage.access_token,
        // `status_type` and other aggregated fields are rejected from v3.3 up.
        fields: "id,message,created_time,permalink_url,attachments",
      },
    },
  );

  const attachment = data.attachments?.data?.[0];
  const subattachments = attachment?.subattachments?.data;

  // A multi-photo post nests each photo under subattachments; a single-media
  // post carries its one image/video on the attachment itself.
  const mediaItems = subattachments?.length
    ? subattachments
    : attachment
      ? [attachment]
      : [];

  const media = mediaItems
    .map((item) => {
      const videoSrc = item.media?.source;
      if (videoSrc) return { type: "video", url: videoSrc };

      const imageSrc = item.media?.image?.src;
      if (imageSrc) return { type: "image", url: imageSrc };

      return null;
    })
    .filter(Boolean);

  return {
    id: data.id,
    message: data.message || "",
    permalinkUrl: data.permalink_url,
    createdTime: data.created_time,
    media,
  };
}

async function downloadMedia(postId, media) {
  // Nest by post id so two posts' media can never overwrite each other.
  const destDir = path.join(MEDIA_ROOT, postId);
  fs.mkdirSync(destDir, { recursive: true });

  const imagePaths = [];
  const videoPaths = [];

  for (const [index, item] of media.entries()) {
    const ext = item.type === "video" ? "mp4" : "jpg";
    const destPath = path.join(destDir, `${index + 1}.${ext}`);

    const response = await axios.get(item.url, { responseType: "arraybuffer" });
    fs.writeFileSync(destPath, response.data);

    // postContent resolves these relative to the scripts directory.
    const relPath = path.relative(__dirname, destPath);
    if (item.type === "video") videoPaths.push(relPath);
    else imagePaths.push(relPath);
  }

  return { imagePaths, videoPaths };
}

// Convenience wrapper: fetch + download in one call.
async function fetchAndDownload(postId, sourcePage) {
  const post = await fetchSourcePost(postId, sourcePage);
  const { imagePaths, videoPaths } = await downloadMedia(post.id, post.media);
  return { ...post, imagePaths, videoPaths };
}

async function main() {
  const [postId, pageJson] = process.argv.slice(2);

  if (!postId || !pageJson) {
    console.error(
      'Usage: node fetch-source-post.js <postId> \'{"id":"...","name":"...","access_token":"..."}\'',
    );
    process.exit(1);
  }

  const result = await fetchAndDownload(postId, JSON.parse(pageJson));

  console.log(
    `✅ ${result.imagePaths.length} ảnh, ${result.videoPaths.length} video từ bài ${result.id}`,
  );
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error("❌", err.response?.data?.error?.message || err.message);
    process.exit(1);
  });
}

module.exports = { fetchSourcePost, downloadMedia, fetchAndDownload };
