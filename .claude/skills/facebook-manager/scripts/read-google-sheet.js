const axios = require("axios");
const { z } = require("zod");
const { downloadDriveImage } = require("./download-image");
require("dotenv").config();

// --- Env validation ---
const envSchema = z.object({
  SHEET_URL: z
    .string()
    .url()
    .refine((url) => /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/.test(url), {
      message: "Invalid SHEET_URL: must contain a spreadsheet ID",
    }),
  GOOGLE_API_KEY: z.string().min(1, "GOOGLE_API_KEY is required"),
});

const env = envSchema.parse(process.env);

const spreadsheetId = env.SHEET_URL.match(
  /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/,
)?.[1];

if (!spreadsheetId) {
  throw new Error("Invalid SHEET_URL");
}

// --- Sheet metadata schema ---
const sheetMetaSchema = z.object({
  sheets: z.array(
    z.object({
      properties: z.object({
        title: z.string(),
        sheetId: z.number().optional(),
        index: z.number().optional(),
      }),
    }),
  ),
});

// --- Raw values response schema (from Sheets API) ---
const valuesResponseSchema = z.object({
  range: z.string().optional(),
  majorDimension: z.string().optional(),
  values: z.array(z.array(z.string())).optional(),
});

// --- Vietnamese -> English key mapping ---
const KEY_MAP = {
  Timestamp: "timestamp",
  "Nội dung chính bài viết": "mainContent",
  "Ngày đăng": "publishDate",
  "Link nội dung bài": "contentLink",
  "Chủ đề": "topic",
  "Link ảnh chính": "mainImageLink",
  "Link ảnh phụ": "secondaryImageLink",
  "Link ảnh zalo OA": "zaloOaImageLink",
  Note: "note",
  CAPTION: "caption",
  EDIT: "edit",
  STATUS: "status",
};

function mapKeysToEnglish(row) {
  const mapped = {};
  Object.entries(row).forEach(([key, value]) => {
    const englishKey = KEY_MAP[key] || key; // fallback to original key if unmapped
    mapped[englishKey] = value;
  });
  return mapped;
}

// --- Row schema (English keys) ---
const sheetRowSchema = z.object({
  timestamp: z.string(),
  mainContent: z.string(),
  publishDate: z.string(),
  contentLink: z.string(),
  topic: z.string(),
  mainImageLink: z.string(),
  secondaryImageLink: z.string(),
  zaloOaImageLink: z.string(),
  note: z.string(),
  caption: z.string(),
  edit: z.string(),
  status: z.string(),
});

const sheetDataSchema = z.array(sheetRowSchema);

async function getSheetNames() {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`;

  const response = await axios.get(url, {
    params: {
      key: env.GOOGLE_API_KEY,
    },
  });

  const data = sheetMetaSchema.parse(response.data);

  return data.sheets.map((sheet) => sheet.properties.title);
}

async function getSheetData(sheetName) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(
    sheetName,
  )}`;

  const response = await axios.get(url, {
    params: {
      key: env.GOOGLE_API_KEY,
    },
  });

  const raw = valuesResponseSchema.parse(response.data);
  const rows = raw.values || [];

  if (rows.length === 0) {
    return [];
  }

  const headers = rows[0];

  const data = rows.slice(1).map((row) => {
    const obj = {};
    headers.forEach((header, index) => {
      obj[header] = row[index] || "";
    });
    return mapKeysToEnglish(obj);
  });

  return sheetDataSchema.parse(data);
}

async function main() {
  const sheetNames = await getSheetNames();
  const data = await getSheetData(sheetNames[0]);

  await Promise.all(
    data.map(async (item) => {
      if (item.mainImageLink) {
        item.mainImagePath = await downloadDriveImage(item.mainImageLink);
      }

      if (item.secondaryImageLink) {
        item.secondaryImagePath = await downloadDriveImage(item.secondaryImageLink);
      }

      if (item.zaloOaImageLink) {
        item.zaloOaImagePath = await downloadDriveImage(item.zaloOaImageLink);
      }
    })
  );

  console.log(data);
}

 main().catch((err) => {
  if (err instanceof z.ZodError) {
    console.error("Validation error:");
    console.error(err.errors);
  } else {
    console.error(err);
  }
});
