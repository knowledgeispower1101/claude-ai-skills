const fs = require("fs");
const path = require("path");
const { getPages } = require("./get-token");
const { listRecentPosts, shareContent } = require("./share-post");

const SOURCE_PAGE_NAME = "AutomationTest2";
const TARGET_PAGE_NAME = "AutomationTest";
const STATE_PATH = path.join(__dirname, "daily-share-state.json");

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return { lastSharedPostId: null };
  }
}

function writeState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function main() {
  const pages = await getPages();
  if (!pages) throw new Error("Không lấy được danh sách Page (token có thể đã hết hạn)");

  const sourcePage = pages.find((p) => p.name === SOURCE_PAGE_NAME);
  const targetPage = pages.find((p) => p.name === TARGET_PAGE_NAME);
  if (!sourcePage) throw new Error(`Không tìm thấy Page nguồn "${SOURCE_PAGE_NAME}"`);
  if (!targetPage) throw new Error(`Không tìm thấy Page đích "${TARGET_PAGE_NAME}"`);

  const posts = await listRecentPosts(sourcePage, 1);
  if (!posts.length) {
    log("Không có bài viết nào trên trang nguồn.");
    return;
  }

  const latest = posts[0];
  const state = readState();

  if (state.lastSharedPostId === latest.id) {
    log(`Bài mới nhất (${latest.id}) đã được chia sẻ trước đó, bỏ qua.`);
    return;
  }

  log(`Chia sẻ bài ${latest.id} từ ${SOURCE_PAGE_NAME} sang ${TARGET_PAGE_NAME}...`);
  const results = await shareContent({
    sourcePostId: latest.id,
    sourcePermalinkUrl: latest.permalink_url,
    targetPages: [targetPage],
    published: true,
  });

  results.forEach((r) => {
    if (r.success) {
      log(`✅ ${r.name}: post ${r.postId}`);
    } else {
      log(`❌ ${r.name}: ${r.error}`);
    }
  });

  if (results.every((r) => r.success)) {
    writeState({ lastSharedPostId: latest.id });
  }
}

main().catch((err) => {
  log(`❌ Fatal: ${err.response?.data?.error?.message || err.message}`);
  process.exit(1);
});
