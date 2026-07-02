const FormData = require("form-data");
const axios = require("axios")

const extractDriveFileId = (driveUrl) => {
  const match = driveUrl.match(/\/file\/d\/([a-zA-Z0-9-_]+)/);
  return match?.[1] || null;
}

const downloadDriveImage = async(driveUrl) => {
  const fileId = extractDriveFileId(driveUrl);
  const directUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;

  const response = await axios.get(directUrl, {
    responseType: "arraybuffer",
  });

  return Buffer.from(response.data);
}

module.exports = {
  downloadDriveImage,
  extractDriveFileId,
};