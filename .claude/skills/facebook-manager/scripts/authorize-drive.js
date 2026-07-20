// One-time setup script: obtains a Google Drive OAuth refresh_token and
// saves it into .env as GOOGLE_OAUTH_REFRESH_TOKEN. Only needs to be run
// once (or again if the refresh token is ever revoked).
//
// Usage: node authorize-drive.js
// Then open the printed URL, sign in as the Drive account, and approve.

const fs = require("fs");
const path = require("path");
const http = require("http");
const axios = require("axios");
const { TOKEN_URI } = require("./google-oauth");

const ENV_PATH = path.join(__dirname, ".env");
const PORT = 4756;
const REDIRECT_URI =
  process.env.GOOGLE_OAUTH_REDIRECT_URI || `http://localhost:${PORT}/oauth2callback`;
const SCOPE = "https://www.googleapis.com/auth/drive.readonly";

function saveRefreshToken(refreshToken) {
  let contents = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf-8") : "";
  if (/^GOOGLE_OAUTH_REFRESH_TOKEN=.*$/m.test(contents)) {
    contents = contents.replace(
      /^GOOGLE_OAUTH_REFRESH_TOKEN=.*$/m,
      `GOOGLE_OAUTH_REFRESH_TOKEN=${refreshToken}`,
    );
  } else {
    contents += `${contents.endsWith("\n") || contents === "" ? "" : "\n"}GOOGLE_OAUTH_REFRESH_TOKEN=${refreshToken}\n`;
  }
  fs.writeFileSync(ENV_PATH, contents);
}

async function main() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error("❌ Missing GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET in .env");
    process.exit(1);
  }

  const authUrl =
    "https://accounts.google.com/o/oauth2/v2/auth?" +
    new URLSearchParams({
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: SCOPE,
      access_type: "offline",
      prompt: "consent",
    }).toString();

  console.log("Open this URL in a browser signed in as the Drive account:\n");
  console.log(authUrl);
  console.log(`\nWaiting for the OAuth redirect on ${REDIRECT_URI} ...`);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname !== "/oauth2callback") {
      res.writeHead(404).end();
      return;
    }

    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");

    if (error) {
      res.writeHead(400, { "Content-Type": "text/plain" }).end(`OAuth error: ${error}`);
      console.error(`❌ OAuth error: ${error}`);
      server.close();
      process.exit(1);
      return;
    }

    try {
      const { data } = await axios.post(TOKEN_URI, null, {
        params: {
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: REDIRECT_URI,
          grant_type: "authorization_code",
        },
      });

      if (!data.refresh_token) {
        throw new Error(
          "No refresh_token returned — revoke the app's access at https://myaccount.google.com/permissions and try again (Google only issues a refresh_token on first consent).",
        );
      }

      saveRefreshToken(data.refresh_token);

      res
        .writeHead(200, { "Content-Type": "text/plain" })
        .end("Authorized. You can close this tab and return to the terminal.");
      console.log("✅ Saved GOOGLE_OAUTH_REFRESH_TOKEN to .env");
    } catch (err) {
      res
        .writeHead(500, { "Content-Type": "text/plain" })
        .end("Failed to exchange code for tokens, see terminal.");
      console.error("❌", err.response?.data || err.message);
    } finally {
      server.close();
      process.exit(0);
    }
  });

  server.listen(PORT);
}

main();
