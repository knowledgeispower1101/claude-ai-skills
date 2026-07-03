const fs = require("fs");
const path = require("path");
const axios = require("axios");

const extractDriveFileId = (driveUrl) => {
  const match = driveUrl.match(/\/file\/d\/([a-zA-Z0-9-_]+)/);
  return match?.[1] || null;
};

const downloadDriveImage = async (driveUrl, outputDir = path.join(__dirname, "images")) => {
  const fileId = extractDriveFileId(driveUrl);

  if (!fileId) {
    throw new Error("Invalid Google Drive URL");
  }

  const directUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;

  const response = await axios.get(directUrl, {
    responseType: "arraybuffer",
  });

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const contentType = response.headers["content-type"];
  let ext = ".jpg";

  if (contentType.includes("png")) ext = ".png";
  else if (contentType.includes("jpeg")) ext = ".jpg";
  else if (contentType.includes("gif")) ext = ".gif";
  else if (contentType.includes("webp")) ext = ".webp";

  const filePath = path.join(outputDir, `${fileId}${ext}`);

  fs.writeFileSync(filePath, response.data);

  console.log(`Saved: ${filePath}`);

  return filePath;
};

module.exports = {
  downloadDriveImage,
  extractDriveFileId,
};