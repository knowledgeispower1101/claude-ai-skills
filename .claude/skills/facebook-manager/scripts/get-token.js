const axios = require("axios");
const dotenv = require("dotenv");
const { z } = require("zod");

dotenv.config();

// Two separate Facebook accounts each manage their own portfolio of Pages;
// the full managed-Pages list is the union of both, deduped by Page id.
const TOKEN_SOURCES = [
  { envVar: "FB_ACCOUNT_1_ACCESS_TOKEN", token: process.env.FB_ACCOUNT_1_ACCESS_TOKEN },
  { envVar: "FB_ACCOUNT_2_ACCESS_TOKEN", token: process.env.FB_ACCOUNT_2_ACCESS_TOKEN },
].filter((source) => source.token);

if (TOKEN_SOURCES.length === 0) {
  console.error(
    "Error: neither FB_ACCOUNT_1_ACCESS_TOKEN nor FB_ACCOUNT_2_ACCESS_TOKEN found in .env file",
  );
  process.exit(1);
}

const CategoryListSchema = z.object({
  id: z.string(),
  name: z.string(),
});

const PageSchema = z.object({
  access_token: z.string().default(""),
  name: z.string(),
  id: z.string(),
});

const PagesResponseSchema = z.object({
  data: z.array(PageSchema),
});

const getPagesForToken = async (accessToken) => {
  const response = await axios.get(
    "https://graph.facebook.com/v25.0/me/accounts?limit=200",
    {
      params: {
        access_token: accessToken,
        fields: "id,name,access_token",
      },
    },
  );

  return PagesResponseSchema.parse(response.data).data;
};

const getPages = async () => {
  try {
    const byId = new Map();
    let successCount = 0;

    for (const { envVar, token } of TOKEN_SOURCES) {
      try {
        const pages = await getPagesForToken(token);
        successCount++;
        for (const page of pages) {
          if (!byId.has(page.id)) byId.set(page.id, page);
        }
      } catch (error) {
        const message = error.response?.data?.error?.message || error.message;
        console.error(`❌ ${envVar}: ${message}`);
      }
    }

    if (successCount === 0) {
      // every configured token failed outright — this is a hard failure, not "no pages"
      return null;
    }

    const pages = [...byId.values()];

    console.log(`✅ Successfully fetched ${pages.length} page(s)\n`);

    if (pages.length === 0) {
      console.log("NO DATA");
    }

    return pages;
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error("❌ Validation Error:");
      error.issues.forEach((issue) => {
        console.error(`   - ${issue.path.join(".")}: ${issue.message}`);
      });
      return null;
    }

    console.error("❌ Error:", error.message);
    return null;
  }
};

async function main() {
  const data = await getPages();
  console.log(data);
}

if (require.main === module) {
  main();
}

module.exports = { getPages };
