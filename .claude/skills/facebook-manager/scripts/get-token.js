const axios = require("axios");
const dotenv = require("dotenv");
const { z } = require("zod");

dotenv.config();

const accessToken = process.env.MAIN_PAGE_ACCESS_TOKEN;

if (!accessToken) {
  console.error("Error: MAIN_PAGE_ACCESS_TOKEN not found in .env file");
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

const getPages = async () => {
  try {
    const response = await axios.get(
      "https://graph.facebook.com/v25.0/me/accounts",
      {
        params: {
          access_token: accessToken,
          fields: "id,name,access_token",
        },
      },
    );

    const validatedData = PagesResponseSchema.parse(response.data);

    console.log(
      `✅ Successfully fetched ${validatedData.data.length} page(s)\n`,
    );

    if (validatedData.data.length === 0) {
      console.log("NO DATA");
      return [];
    }

    return validatedData.data;
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error("❌ Validation Error:");
      error.issues.forEach((issue) => {
        console.error(`   - ${issue.path.join(".")}: ${issue.message}`);
      });
      return null;
    }

    if (error.response) {
      console.error(`❌ Facebook API Error (${error.response.status}):`);
      console.error(error.response.data.error?.message || error.response.data);
    } else if (error.request) {
      console.error("❌ No response received from Facebook API");
    } else {
      console.error("❌ Error:", error.message);
    }
    return null;
  }
};

async function main() {
  const data = await getPages();
  console.log(data);
}

main()
