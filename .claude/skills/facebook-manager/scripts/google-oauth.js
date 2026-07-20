const path = require("path");
const axios = require("axios");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const TOKEN_URI = "https://oauth2.googleapis.com/token";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing ${name} in .env — run authorize-drive.js first if this is GOOGLE_OAUTH_REFRESH_TOKEN.`,
    );
  }
  return value;
}

// Exchanges the stored refresh_token for a fresh short-lived access_token.
// Access tokens expire (~1h) so callers should fetch a new one per script run
// rather than caching it across invocations.
async function getAccessToken() {
  const clientId = requireEnv("GOOGLE_OAUTH_CLIENT_ID");
  const clientSecret = requireEnv("GOOGLE_OAUTH_CLIENT_SECRET");
  const refreshToken = requireEnv("GOOGLE_OAUTH_REFRESH_TOKEN");

  const { data } = await axios.post(TOKEN_URI, null, {
    params: {
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    },
  });

  return data.access_token;
}

module.exports = { getAccessToken, TOKEN_URI };
