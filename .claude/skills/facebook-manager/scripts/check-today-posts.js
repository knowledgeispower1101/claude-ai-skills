const axios = require("axios");
const { getPages } = require("./get-token");

const GRAPH_VERSION = "v25.0";
const ICT_OFFSET_MS = 7 * 60 * 60 * 1000; // Asia/Ho_Chi_Minh has no DST

// Midnight-to-midnight range for "today" in Asia/Ho_Chi_Minh, computed fresh each run.
function getTodayRangeICT() {
  const nowIct = new Date(Date.now() + ICT_OFFSET_MS);
  const sinceMs =
    Date.UTC(nowIct.getUTCFullYear(), nowIct.getUTCMonth(), nowIct.getUTCDate()) -
    ICT_OFFSET_MS;
  const untilMs = sinceMs + 24 * 60 * 60 * 1000;
  return { since: Math.floor(sinceMs / 1000), until: Math.floor(untilMs / 1000) };
}

async function getTodayPosts(page, { since, until }) {
  const { data } = await axios.get(
    `https://graph.facebook.com/${GRAPH_VERSION}/${page.id}/posts`,
    {
      params: {
        access_token: page.access_token,
        fields: "id,message,created_time,permalink_url",
        since,
        until,
        limit: 25,
      },
    },
  );
  return data.data || [];
}

async function main() {
  const pages = await getPages();
  if (!pages) throw new Error("Không lấy được danh sách Page");

  const range = getTodayRangeICT();

  let totalPosts = 0;
  for (const page of pages) {
    try {
      const posts = await getTodayPosts(page, range);
      if (posts.length === 0) continue;
      totalPosts += posts.length;
      console.log(`\n=== ${page.name} (${page.id}) — ${posts.length} bài ===`);
      posts.forEach((p) => {
        const preview = (p.message || "[không có chữ]").replace(/\s+/g, " ").slice(0, 80);
        console.log(`  - ${p.created_time} | ${preview} | ${p.permalink_url || p.id}`);
      });
    } catch (err) {
      console.error(`❌ ${page.name}: ${err.response?.data?.error?.message || err.message}`);
    }
  }
  console.log(`\nTổng cộng: ${totalPosts} bài viết hôm nay trên ${pages.length} Page.`);
}

main().catch((err) => {
  console.error("❌ Fatal:", err.response?.data || err.message);
  process.exit(1);
});
