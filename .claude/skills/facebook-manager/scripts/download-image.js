const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { getAccessToken } = require("./google-oauth");

// Downloads a Drive file's binary content straight to disk via the Drive
// API — content never passes through the caller's context, unlike the
// Drive MCP tool's base64 responses (impractical for multi-MB images).
async function downloadDriveFile(fileId, destPath) {
  const accessToken = await getAccessToken();

  const response = await axios.get(
    `https://www.googleapis.com/drive/v3/files/${fileId}`,
    {
      params: { alt: "media" },
      headers: { Authorization: `Bearer ${accessToken}` },
      responseType: "arraybuffer",
    },
  );

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, response.data);

  return destPath;
}

async function main() {
  const [fileId, destPath] = process.argv.slice(2);

  if (!fileId || !destPath) {
    console.error("Usage: node download-image.js <driveFileId> <destPath>");
    process.exit(1);
  }

  const savedPath = await downloadDriveFile(fileId, destPath);
  console.log(`✅ Saved: ${savedPath}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("❌", err.response?.data || err.message);
    process.exit(1);
  });
}

module.exports = { downloadDriveFile };
