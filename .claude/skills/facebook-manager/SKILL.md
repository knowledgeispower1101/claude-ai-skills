---
name: facebook-manager
description: This system automates Facebook Page management for accounts that handle multiple Pages. It enables users to create, edit, schedule, and delete posts across more than 40 Facebook Pages from a centralized interface. The system collects content and data from Google Drive and Google Sheets, processes the information, and generates post content automatically. Users can publish content directly to selected Pages, as well as share posts from a main Facebook Page to designated target Pages. The solution streamlines content management workflows, reduces manual effort, and ensures consistent publishing across all managed Pages.
---

## Asking the user questions

Whenever this skill needs input from the user (picking Pages, posts, timing, confirmations, etc.), ask via the interactive multiple-choice question tool (arrow keys to move, space/enter to select) instead of a plain-text question. Always leave the built-in free-text "Other" option available so the user can type an answer if none of the listed choices fit. Only fall back to a plain-text question if the interactive tool is unavailable or the user has just declined/cancelled one — in that case ask in plain chat text instead of immediately retrying the tool.

Every question must also offer two distinct cancel options, separate from the free-text "Other":
- **"Hủy bước này" (cancel this step)** — abandon the current step only and go back to redo the previous step (e.g. re-pick the post, re-pick the date), keeping everything confirmed before that step intact.
- **"Hủy toàn bộ" (cancel everything)** — abort the whole workflow immediately (posting, sharing, deleting, etc.) with nothing published/changed, and confirm to the user that it was cancelled.
Never treat a plain tool-rejection/decline as ambiguous — if the user cancels the question tool itself (not one of these two explicit options), treat it the same as "Hủy bước này" and ask in plain text whether they meant to cancel that step or the whole workflow.

## Content source (Google Drive)

Content lives under a fixed Drive hierarchy: `marketing-content / <year> / <month> / <day>`, e.g. `marketing-content/2026/07/09`.

A day folder holds content for that date in one of two shapes:
- **Single post**: the day folder directly contains a Word (`.docx`) file with the content/caption and an `images` subfolder.
- **Multiple posts**: the day folder instead contains two or more subfolders (one per post — name/order not guaranteed to mean anything), and each of those subfolders has its own `.docx` file + `images` subfolder, independent of the others.

There is no per-page content within a single post — the same caption + images for that post go out to every Page selected for it. But different posts in the same day are independent: different caption, different images, and potentially different Pages/times.

To locate a given day's content: resolve the date to `year`/`month`/`day`, walk `marketing-content` → `<year>` → `<month>` → `<day>` (search/list children at each level rather than guessing a folder ID), then check whether the day folder itself has a `.docx` + `images` (single post) or contains post subfolders (multiple posts) and list those. Read each caption from its `.docx` file with `read_file_content`.

**Image ordering matters.** Files inside the `images` subfolder are numbered to indicate posting order (e.g. `1.jpg`, `2.jpg`, `3.jpg` or `img-01`, `img-02`, ...). Always sort the images by their number before building `imagePaths`, and pass them to `post-content.js` in that exact order — Facebook attaches multi-photo posts in the order `imagePaths`/`attached_media` is given, so an unsorted list will post images out of sequence.

**Videos.** A post's folder may also contain a video file (`.mp4`, `.mov`, `.webm`, ...) — either alongside the `images` subfolder, in its own `video`/`videos` subfolder, or as a loose file next to the `.docx`. Treat any such video file the same way as images: download it and pass its local path via `videoPaths` (not `imagePaths`) when calling `postContent`. A post can have images only, a video only, or both mixed together — `post-content.js` picks the right Graph API call automatically (single photo, single video, or a combined multi-media post) based on what's non-empty. Ignore folders clearly meant for other platforms (e.g. `image-linkedin`) — those aren't for Facebook.

**Local download path must avoid collisions.** Every post's `images` folder restarts numbering at `1`, so two different posts (same day or different days) can both have a `1.jpg`. Never download straight into a date-only folder like `images/2026-07-04/` — a second post on that date, or a same-numbered image from another post, will silently overwrite the first. Instead, nest by the Drive folder ID of the *post itself* (the day folder's ID for a single-post day, or the post subfolder's ID for a multi-post day), which is guaranteed unique:
```
scripts/images/<postFolderDriveId>/1.jpg
scripts/images/<postFolderDriveId>/2.png
scripts/images/<postFolderDriveId>/video.mp4
```
Record that same nested path in `imagePaths`/`videoPaths` so it round-trips correctly through the post log and `delete-post.js`'s cleanup (see "Post log" below). `download-image.js` downloads any Drive file by ID regardless of type, so it works unchanged for videos too.

## Access tokens (.env)

`scripts/.env` holds two separate Facebook access tokens — `FB_ACCOUNT_1_ACCESS_TOKEN` and `FB_ACCOUNT_2_ACCESS_TOKEN` — each from a different Facebook account, each managing its own portfolio of Pages (the portfolios overlap partially but aren't identical: some Pages are only reachable via one token). The `1`/`2` numbering is arbitrary — neither account is "primary"; they're just two logins whose managed-Pages lists get unioned. `get-token.js` calls `/me/accounts` with both tokens and merges the results, deduped by Page id, so the full managed-Pages list Claude works from is always the union of both. If one token is invalid/blocked, `get-token.js` logs which one failed and still returns the Pages from the other rather than failing outright — only fails hard (returns `null`) if *both* tokens fail. Always use `get-token.js`'s merged output as the Page list; don't read either `.env` token directly in a workflow. Because a source Page for `share-post.js` can come from either token's portfolio (only the *target* Page's `access_token` is used to actually post the share, see `share-post.js` below), sharing works in both directions between the two accounts' Pages.

## Scripts
All the scripts are in `./scripts/`:
- `get-token.js` - fetches `id`, `name`, and `access_token` for every Page reachable from either of the two tokens in `.env` (see "Access tokens" above), merged and deduped by Page id
- `post-content.js` - posts (or schedules) a message + images/video to one or more Pages via the Facebook Graph API
  - exports `postContent({ message, imagePaths, videoPaths, pages, published, scheduledTime, sourceFolder, delayRange })`
  - `pages` is an array of `{ id, name, access_token }` (use the output of `get-token.js`)
  - `imagePaths`/`videoPaths` default to `[]`. Behavior: both empty → text-only post; exactly one image and no video → single photo post; exactly one video and no image → single video post (posted to `/videos` so it gets native video playback); anything else (multiple items, or images+video mixed) → each item uploaded unpublished first, then attached together to one feed post via `attached_media`
  - `published: false` requires `scheduledTime` (unix seconds)
  - `sourceFolder` is optional (e.g. the Drive day-folder path) and is only used for the log entry below
  - **the logged `postId` is `response.data.post_id || response.data.id`.** A single-photo post goes to `/photos`, which returns the *photo* id as `id` and the *feed post* id as `post_id`. Logging `id` there was a real bug (fixed 2026-07-27): it made `delete-post.js` target the photo and any permalink built from the log point at the wrong object. `/feed` returns the post id as `id`, so the fallback is correct for it. A valid logged `postId` always contains an underscore (`<pageId>_<postId>`) — an entry without one is corrupt
  - Pages are posted to **sequentially**, with a random pause between them drawn from `delayRange` (`{min, max}` in seconds, default `{min: 5, max: 10}`) — see "Never publish to many Pages at once" below. Pass `{min: 0, max: 0}` only for a single-Page post. Budget the wall-clock time before starting: 34 Pages at the default is roughly 5–8 minutes plus upload time, so still report progress as it goes.
  - every successful post is appended to that month's log file (see "Post log" below) — no separate step needed
  - CLI usage: `node post-content.js '<json-request>'`
- `fetch-source-post.js` - pulls an existing published post's caption and media so it can be re-posted natively to other Pages (the safe replacement for link-sharing)
  - exports `fetchSourcePost(postId, sourcePage)`, `downloadMedia(postId, media)`, and `fetchAndDownload(postId, sourcePage)`
  - `fetchAndDownload` returns `{ id, message, permalinkUrl, createdTime, imagePaths, videoPaths }` — the paths are relative to `./scripts/` and drop straight into `postContent`
  - media lands in `./scripts/images/<sourcePostId>/`, numbered in the post's own order
  - do not request the `status_type` field from the Graph API — it is rejected from v3.3 up and fails the whole call
  - CLI usage: `node fetch-source-post.js <postId> '<source-page-json>'`
- `delete-post.js` - deletes a previously published/scheduled post using the log
  - looks up the post's `pageId` across the monthly log files, re-fetches a fresh access token for that Page via `get-token.js`, calls the Graph API delete, then removes the entry from whichever monthly file has it
  - also deletes that entry's local downloaded images/video under `./scripts/images/` — but only if no other remaining log entry (in any month) still references them (the same media is often shared across multiple Pages/posts)
  - CLI usage: `node delete-post.js <postId>`
  - exports `deleteLoggedPost(postId)` **and `deletePost(postId, accessToken)`**
  - `deleteLoggedPost` throws `No log entry found for postId` on anything the skill did not publish — and a large share of what is on these Pages was posted by hand (see "The log is not the whole truth"). To remove such a post, use the exported low-level `deletePost(postId, accessToken)` with the token of the Page from `get-token.js`; the `pageId` is the part of `<pageId>_<postId>` before the underscore. Do not fabricate a log entry just to be able to call `deleteLoggedPost`
- `check-today-posts.js` - lists every post published *today* (Asia/Ho_Chi_Minh midnight-to-midnight) on every managed Page, straight from the Graph API
  - CLI usage: `node check-today-posts.js` — no arguments; prints one block per Page plus a total
  - this is the only view of what is actually on Facebook, so it is what reconciliation runs on (see "The log is not the whole truth")
- `stagger.js` - shared helpers behind the sequential multi-Page runs: `DelayRangeSchema`, `sleep`, `randomDelaySeconds`, `reportProgress` (the timeline format below). Used by both `post-content.js` and `share-post.js`
- `share-post.js` - shares one Page's existing post to one or more other Pages, via a "shared link" post (the target Page posts a link to the original, which Facebook renders as a share preview card). Still usable — the earlier belief that this format specifically was causing hidden posts did not survive testing (see "Posts on the satellite Pages may not be visible" below)
  - `node share-post.js list '{"id":"...","name":"...","access_token":"..."}'` → recent posts of that Page (`id`, `message`, `created_time`, `permalink_url`, `full_picture`), for the user to pick which one to share
  - exports `listRecentPosts(page, limit)` and `shareContent({ sourcePostId, sourcePermalinkUrl, message, targetPages, published, scheduledTime })`
  - `targetPages` is an array of `{ id, name, access_token }`; `message` is an optional extra caption on top of the shared link
  - `sourcePermalinkUrl` is what gets posted. A `/share/p/` short link is resolved automatically before the first Page (see "Which link to share" below); `permalink_url` and `pfbid` URLs are used as-is
  - also exports `resolveShareLink(url)` for when the resolved URL is needed before publishing
  - every successful share is appended to that month's log file with `sharedFrom` set to whatever was passed as `sourcePostId` — always pass the real `<pageId>_<postId>`, never the URL. Passing the URL (done by mistake on 2026-07-27) makes the log unsearchable by source post and breaks matching against `readAllLogs()`
  - CLI usage: `node share-post.js '<json-request>'`
- `post-log-store.js` - shared module backing the monthly log files (see "Post log" below); exports `readAllLogs()`, `appendToLog(entries)`, `removeEntry(postId)`, `setPostId(oldPostId, newPostId)`, `listLogFiles()` (also still exports `setCalendarEventId`, unused now that Google Calendar sync has been removed)
- `download-image.js` - downloads a Drive file by ID. **Currently broken:** the Google OAuth token is expired, so the whole Drive-based content pipeline is unusable until the user re-authorises via `authorize-drive.js`. Until then, source content from an existing Facebook post with `fetch-source-post.js` instead
- `authorize-drive.js` / `google-oauth.js` - Google OAuth setup for the Drive pipeline; run `authorize-drive.js` to re-authorise when Drive calls start failing
- `daily-share-auto2-to-auto.js` - standalone test job (AutomationTest2 → AutomationTest), unrelated to the production Pages

## Mixing images and video in one post can fail with a permission error

**Verified 2026-08-07.** When `imagePaths` and `videoPaths` are both non-empty, `postContent` uploads each item unpublished first, then combines them into one feed post via `attached_media` (see the `post-content.js` entry above). That specific combined flow can fail with:

```
(#10) Application does not have permission for this action
```

even though the same Page's token has `pages_manage_posts` and the same account's token just published fine to other Pages minutes earlier. Confirmed on Trung Kiên Automation (account 1 token, app `motor_giam_toc_gimo`): a mixed post (3 images + 1 video) failed with `#10`, but immediately after, the identical caption posted as **video-only** (`imagePaths: []`, `videoPaths: [the video]`, going through the single-video `/videos` path instead of `attached_media`) succeeded on the same Page with the same token. So the gap is specific to the unpublished-upload-then-attach flow, not video support or the token's scopes in general — most likely the app's `pages_manage_posts` is at Standard Access rather than the Advanced Access (App Review-gated) that flow needs. This is a Meta App Dashboard setting, not something fixable from these scripts.

Don't retry a mixed post silently. If a source post has both images and video and posting fails with `#10`:
1. Tell the user plainly — don't guess or "just drop the video" on your own initiative.
2. Offer the proven fallback: post the video alone (drop the images) — confirmed working. Photos-only (drop the video) has not been separately verified but is likely fine since plain multi-photo/text posts to these Pages work routinely.
3. Whichever the user picks, publish to **one** Page first and confirm before running the rest of the batch, same as any other new content path.

## Which link to share (`sourcePermalinkUrl`)

**The Graph API rejects `https://www.facebook.com/share/p/<code>/` short links** — the kind the *Chia sẻ → Sao chép liên kết* button produces, and the kind the user will paste. Posting one fails with `The url you supplied is invalid` (verified on 2026-07-29, every Page in the batch). The short link itself is fine; it just has to be resolved first.

Two URL forms are accepted, and **which one you use changes how Facebook renders the card on some Pages**:

- the `pfbid` permalink a `/share/p/` link redirects to (`facebook.com/<PageName>/posts/pfbid…`) — **prefer this.**
- `permalink_url` from the Graph API (`facebook.com/<pageId>/posts/<postId>`) — usually fine, but not always

On 2026-07-31 the same post shared to 18 Pages with `permalink_url` rendered correctly on 15 of them (`type: album`, "Ảnh từ bài viết của <source Page>", with a preview image) and degraded to a bare link card (`type: share`, title `www.facebook.com`, no image, no attribution) on Trung Kiên Technology, Trung Kiên Tech and Trung Kiên Motor. Deleting and re-sharing with the same URL reproduced the failure; re-sharing the identical post via the `pfbid` form fixed all three immediately. Those Pages had shared correctly before, so this is not a permanent property of a Page.

Practical rule: **ask the user for the `/share/p/` link and let `resolveShareLink` turn it into the `pfbid` form.** Fall back to `permalink_url` only when no short link is available — and then check the rendered `attachments.type` per Page afterwards.

**`shareContent` handles the resolution for you** — it calls `resolveShareLink` on `sourcePermalinkUrl` once per run, following the 302 and stripping the query string, and passes anything that is not a `/share/` URL through untouched. So a `/share/p/` link the user pastes can go straight in. Only call `resolveShareLink` yourself if you need the resolved URL before publishing (e.g. to show it in a dry run).

To check which post a `/share/p/` link points at without publishing anything, read the resolved URL's Open Graph tags — the Graph API cannot resolve it:

```
curl -sL -A "facebookexternalhit/1.1" "<resolved pfbid url>" | grep -o 'og:description" content="[^"]*'
```

**After any share batch, verify the rendering per Page** — `attachments{title,type,media}`. `album` with an "Ảnh từ bài viết của …" title is the good outcome; `share` with title `www.facebook.com` means Facebook fell back to a bare link card and the post looks broken even though the API reported success.

**The attachment type mirrors the source post, not the link form.** An album source yields `type: album` with `title: "Ảnh từ bài viết của <source Page>"`; a single-photo source yields `type: photo` pointing at `photo.php` with no attribution line. Do not read a `photo` attachment as evidence that the wrong link was used — check what the source post is first.

Still share to **one** Page and have the user look at the card before running the batch. It is the cheapest way to catch a bad link, and on 2026-07-29 it is what stopped a rejected URL from failing across 19 Pages.

If the user wants a native re-post instead of a share card, none of this applies — use `fetch-source-post.js` + `postContent` (see the re-posting workflow). Confirm which of the two they mean first; "đăng lên" is ambiguous between them.

## The log is not the whole truth

`readAllLogs()` records only what **this skill** published. Team members also post and share by hand from the Facebook app and Business Suite, and those never appear in it. On 2026-07-27 Facebook held 68 posts across the Pages while the log had 52 — the other 16 were a manual backlog share of older Thiên Hổ posts, which put 3–4 posts on the same Page in one day.

So: **never answer "what went out today" from the log alone.** Run `node check-today-posts.js` and diff it against `readAllLogs()`. A post present on Facebook but absent from the log is a manual post, not a bug in the scripts — say so plainly instead of assuming the scripts double-posted. Confirm the cause before proposing deletions: fetch each unexplained post's `attachments{title,type,unshimmed_url}` and `created_time` to see what it actually shares. Deleting on the assumption of a duplicate, when the post is really a different day's content someone posted on purpose, destroys work.

`delete-post.js` cannot remove these (no log entry) — see its notes above for the low-level path.

## Danh sách Fanpage vệ tinh (Repost & Share) — lịch đăng/share theo ngày

A Google Sheet titled **"Danh sách Fanpage vệ tinh (Repost & Share)"** (owner `marketing.thienho@gmail.com`, fileId `1F60J5-fueBgCT9Vc2J9w2nNiUEYgcExHLjLrB1NgRPk` as of 2026-08 — re-`search_files` by title if this ever 404s) is the source of truth for which satellite Pages get a native post, a share, or nothing on a given day. **Before running the satellite-Page repost/share workflow below, always check this sheet first for the target date** rather than asking the user page-by-page which route to use.

It has 4 tabs, each tracking a distinct group of satellite Pages (grouped by who manages them, not by product line):

| Tab | Pages it tracks |
|---|---|
| **BIẾN TẦN - HIỀN** | Biến tần Hồ Chí Minh, Long An, Cần Thơ, Tây Ninh, Bình Phước, Đồng Nai, Bình Dương, Miền Trung, Miền Bắc, Hà Nội, Bắc Ninh, Hải Dương, Miền Nam, Nam Định, Hải Phòng (15 Pages) |
| **MOTOR-Thư** | Motor Giảm Tốc GIMO, Motor giảm tốc Hồ Chí Minh, Hải Dương, Miền Trung, Hà Nội, Bắc Ninh, Cần Thơ, Long An, Tây Ninh, Bình Dương, Miền Nam, Miền Bắc (12 Pages) |
| **FANPAGE-Thư** | Biến Tần Bình Chánh/Bình Tân/Quận 12/Vũng Tàu/An Giang/Tiền Giang, Motor giảm tốc Bình Chánh/Bình Tân/Đồng Nai/Bình Phước/Vũng Tàu/An Giang/Quận 12/Kiên Giang/Tiền Giang, Biến tần Nghệ An/Vĩnh Phúc/Thái Bình/Kiên Giang (19 Pages — the newer batch of satellite Pages) |
| **TRUNG KIÊN** | Trung Kiên Automation, Giảm Tốc, Biến Tần, Technology, Motor Giảm Tốc, Tech, Motor (7 Pages) |

Each tab is one continuous table, one row per calendar day: weekday name \| date (`d/M/yyyy`, leading zero not consistent) \| **Thao tác** (`Đăng bài` / `Share bài` / `Không đăng` / blank) \| **Tiến độ (IT)** (free text like `Hoàn thành`, set and owned by the IT team — never write to this column) \| one TRUE/FALSE checkbox column per Page in that tab \| `Progress` (a constant page-count, not a completion counter — ignore it). The row layout changed over time — rows before roughly 2026-06 used plain `Đã đăng`/`Đã share` text per Page instead of the Thao tác/checkbox format — so always work off the most recent month block for a tab, never an older archived one.

**How to read it**: `search_files` (`title contains 'Danh sách Fanpage vệ tinh'`) → `read_file_content`. The file is large (~150k+ characters as of 2026-08) and gets saved to a local tool-results file rather than returned inline — read that file with `grep`/`awk` via Bash rather than the Read tool's token-limited paging, since the flattened markdown has no tab-name markers: identify the right tab by matching its known page-name header row (the table above), then find the row for the target date within that tab's *current* month block.

**Đăng bài / Share bài / Không đăng apply per tab, independently** — on the same day, one tab can say "Đăng bài" while another says "Share bài" and another "Không đăng". Feed each tab's action into the matching route in "Workflow: re-posting a Page's post to other Pages" (Đăng bài → native re-post; Share bài → share card; Không đăng → skip that tab's Pages entirely that day). If a date's Thao tác cell is blank, ask the user rather than guessing.

**No write-back yet.** As of 2026-08, the only Google Drive/Sheets access available is read-only (`search_files`, `read_file_content`, `get_file_metadata`, `download_file_content`, `create_file`, `copy_file` — none of these can write a single cell/checkbox in an existing Sheet), and the skill's own `authorize-drive.js` OAuth pipeline is scoped to `drive.readonly` only (and currently expired besides). So after a run completes, **tell the user exactly which cells to tick** (tab name, date row, which Page columns) instead of claiming the sheet was updated. Do not silently skip this — it's real follow-up work for a human until a Sheets-write tool exists.

## Deleting posts

Deleting is irreversible. Only ever delete when the user asked for it in this conversation — never on your own initiative, not to clean up a duplicate you noticed, not to retry a botched publish.

Once asked, two steps before the first Graph API call:

1. **List exactly what will go** — one line per post: Page name, local time, what the post actually contains, and its `postId`. Never a bare count ("xoá 15 bài trùng"); the user has to see what they are agreeing to lose.
2. **Then a final yes/no**, stating that it cannot be undone.

Between the two, verify each post is what you called it — `attachments{title,type,unshimmed_url}`, `created_time`, and whether it appears in `readAllLogs()`. A post that looks like a duplicate may be different content someone posted deliberately; the attachment target is what tells them apart.

When the user says they already deleted a post on Facebook themselves, only clear the log entry (`removeEntry`) — the Graph API call will just error on a post that no longer exists.

## Post log

Logs are split **one file per calendar month**, named `./scripts/post-log-<YYYY>-<MM>.json` (e.g. `post-log-2026-07.json`). A post/share is filed under the month of its `createdAt`, so November's entries live in `post-log-2026-11.json`, December's in `post-log-2026-12.json`, etc. — never one growing file for the whole year.

Every successful `post-content.js` call appends one record per Page to that month's file:
```json
{
  "postId": "1110707515468174_122111264271361823",
  "pageId": "1110707515468174",
  "pageName": "Hungnguyentest",
  "published": true,
  "scheduledTime": null,
  "createdAt": "2026-07-10T08:00:00.000Z",
  "sourceFolder": "marketing-content/2026/07/04",
  "message": "...",
  "imagePaths": ["images/2026-07-04/1.jpg", "images/2026-07-04/2.png"],
  "videoPaths": [],
  "calendarEventId": null
}
```
This is the record of what *this skill* published — authoritative for undoing its own work, but not a complete picture of the Pages (see "The log is not the whole truth" above). Use `post-log-store.js`'s `readAllLogs()` (merges every monthly file) to find a `postId` when the user wants to delete or look up a past post (by date, Page name, or content). To delete a post, call `delete-post.js <postId>`; it searches across all monthly files, handles finding the right Page token, and cleans up the log entry in whichever month file has it. There's no separate "edit" API call for feed/photo posts — Facebook only allows editing the text of a plain feed post via `POST /{post-id}` with a new `message`; treat edits to photo posts as delete + repost.

The monthly log files are local to this machine (not synced to Drive) — don't delete or hand-edit them outside of `post-content.js`/`delete-post.js`/`post-log-store.js` (or the cleanup step below), since they're the only record of which Facebook post ID maps to which Page/content.

`calendarEventId` stays `null` on every entry — Google Calendar sync was removed (it wasn't worth the time cost); the field is legacy and unused.

## Cleanup: xoá dữ liệu cũ (log + ảnh đã tải)

Once a calendar month is fully done and it's been at least a month since (i.e. any month that isn't the current month or the previous one), its `post-log-<YYYY>-<MM>.json` and the local media it references under `./scripts/images/` are safe to delete — Facebook itself remains the record of what was actually published, and this is purely local disk cleanup.

Only do this **when the user explicitly asks for it in that conversation** (e.g. "dọn dẹp file cũ", "xoá log/ảnh tháng trước") — never proactively or on a schedule, since it is irreversible for the local record: once a month's log file is gone, `delete-post.js <postId>` for a post from that month will throw `No log entry found for postId` and require the low-level `deletePost(postId, accessToken)` path instead (same as any hand-posted content, see "The log is not the whole truth").

When asked:
1. **List which months qualify** (file name, entry count, date range) and confirm with the user before deleting anything — same spirit as "Deleting posts" above, just for local files instead of live posts.
2. **Delete the qualifying `post-log-<YYYY>-<MM>.json` files.**
3. **Delete the image/video folders those files referenced** under `./scripts/images/<postFolderDriveId>/` — read `imagePaths`/`videoPaths` out of each file *before* deleting it so you know which folders are safe to remove; don't delete a folder still referenced by a log file outside the cleanup range.

## Workflow: posting a day's content to selected Pages

1. **Identify the day folder** the user wants to post: resolve the target date and walk `marketing-content/<year>/<month>/<day>`.
2. **Detect single vs. multiple posts** for that day (see "Content source" above):
   - If the day folder directly has a `.docx` + `images` (and/or a video file), there is exactly one post — treat it as "post 1" and skip straight to step 4. Its post-folder ID (for local media paths, see above) is the day folder's own Drive ID.
   - If the day folder contains post subfolders instead, there are multiple posts. For each subfolder, read its `.docx` caption, list its `images` subfolder sorted by number (ascending) to build that post's `imagePaths`, and check for any video file to build `videoPaths` — all downloaded under that subfolder's own Drive ID. Show the user a short summary of each post found (e.g. first line of caption + image/video count) so they can tell them apart.
3. **If multiple posts were found, ask the user how to proceed** before doing anything else:
   - Post all of them, or only a subset — let them pick which post(s) to publish.
   - For the post(s) they pick, ask whether each one gets its own Pages/time, or whether they all share the same Pages/time. Don't assume "same for all" — confirm it.
4. **Fetch Page targets**: run `get-token.js` to get the full list of `{id, name, access_token}` for all managed Pages.
5. **For each post being published, let the user pick Pages**: present the Page list from step 4 as a selectable list and have the user choose which Page(s) that post goes to (reuse the same selection across posts only if the user said they share Pages).
6. **For each post, resolve the publish time**, based on the day folder's date relative to today:
   - **Future date** → treat as a scheduled post: use `published: false` + `scheduled_publish_time` set to that date (ask the user for the exact hour if not specified — and, when there are multiple posts, ask whether each post gets its own hour or they all publish at the same time).
   - **Today or a past date** → do not assume "post now" silently; explicitly confirm with the user before publishing (past-dated content especially should not go out without an explicit yes).
   - **Folder with no clear date** → ask the user what date/time they want to publish.
7. **Confirm before publishing**: show a final summary per post (which Pages, the message/caption, image/video count, and the resolved publish time — now vs. scheduled for X) and get explicit user confirmation before touching any of them.
8. **Publish**: call `post-content.js` (via `postContent(...)`) once per post, with that post's message, `imagePaths`/`videoPaths`, resolved `published`/`scheduledTime`, confirmed list of `pages`, and `sourceFolder` set to the Drive day-folder path. Report per-post, per-Page success/failure back to the user. Each successful Page post is automatically recorded in that month's log file (see "Post log" below) — no manual bookkeeping needed.

## Posts on the satellite Pages may not be visible — and the API cannot tell you

**Unresolved as of 2026-07-22.** Content on the satellite Pages (Biến tần …, Motor giảm tốc …, Trung Kiên …) is reaching readers inconsistently: some posts are unviewable to anyone who is not a Page admin, while other posts on the same Page, same day, same structure are fine. The main Thiên Hổ Technology Page (5.2k followers) is unaffected.

**Never claim a batch is healthy on the strength of API fields.** `is_published: true`, `is_hidden: false` and `privacy: EVERYONE` were all reported for posts that readers could not see. Page-level probes are equally useless here — `is_published`, `is_unclaimed`, `promotion_eligible` all come back clean, and `restrictions` / `country_restrictions` / `age_restrictions` do not exist as fields. Report what the fields say, not what you infer from them.

Ruled out by direct testing, so don't re-propose these as the cause: post privacy (that was a separate, real bug — see below), link-share vs native format, content duplicated across Pages, album vs single-photo structure, and post age. The leading untested hypothesis is Meta limiting distribution across a network of 40+ low-follower Pages publishing identical content — which, if true, is an operating-model problem, not something to fix in these scripts.

Only the user can resolve it, via **Meta Business Suite → Chất lượng trang / Tình trạng tài khoản** on an affected Page. To check whether a specific post is visible, ask someone with an ordinary logged-in Facebook account who is not a Page admin; incognito is not a valid test, because Facebook gates logged-out browsing regardless of a post's settings.

Given all that, for anything past a couple of Pages:

1. **Confirm visibility before scaling.** Publish to one Page, have it checked by a real non-admin account, and only then run the rest.
2. **Keep the stagger.** `Promise.all` across N Pages puts N identical posts on Facebook in the same second. `postContent` and `shareContent` stagger sequentially instead. **The user set the default to `{min: 5, max: 10}` on 2026-07-27 — use it as-is and don't propose widening it unprompted.** Never `{min: 0, max: 0}` on a multi-Page run, though: simultaneous identical posts are the burst pattern Facebook's integrity systems flag. If Pages later start showing distribution problems, a wider range is worth *testing* as one variable — but say so as a hypothesis, not a correction. Recompute and state the wall-clock estimate whenever the range changes.
3. **Warn the user before a large batch** how long it will take, and offer to split it across several runs or days.

### Reporting progress on a staggered run

`postContent` prints a timeline-style report after **every** Page — the format the user picked:

```
20:44  ✅  Biến Tần Bình Chánh
── 16/34 trang · ✅15 ❌1 · còn ~50 phút ──
⏳ Kế tiếp: Biến tần Nghệ An (sau 3p10s)
```

Run the batch under the **Monitor** tool, not `Bash(run_in_background)`. Monitor turns each stdout line into a chat notification, which is the only way the user gets a live update per Page; a backgrounded Bash command only notifies once, on exit. The three lines above are printed together so Monitor batches them into a single notification per Page.

Monitor's `timeout_ms` caps out at 1 hour. At the current `{min: 5, max: 10}` a 34-Page share run finishes in well under that, but a batch with large image or video uploads per Page can still overrun, so pass `persistent: true` rather than betting on the estimate — otherwise the monitor is killed mid-run while the posting continues unwatched. Don't pipe the command through `grep` to tidy the output either: extra pipe stages risk buffering the lines that are the whole point. A couple of startup lines from `get-token.js` are a fair trade.

Validate before launching a run — resolve every target Page name and fetch the source content first (a `--dry-run` flag on the runner), so a typo fails in seconds rather than part-way through the batch.

Relay these lines to the user as-is — don't reformat them into a table or summarise them away.

## Workflow: re-posting a Page's post to other Pages

The team includes non-technical members, so this flow is pure multiple-choice — never ask them to paste a post ID or any JSON. Everything Claude needs (Page IDs, tokens, post IDs) is fetched internally and only human-readable labels are shown to the user. The single exception is the `/share/p/` short link when they choose the share-card route — that one cannot be fetched (see "Which link to share").

**First, settle which of the two routes they want** — "đăng lên", "share lên" and "lấy bài … đăng" are all ambiguous, and getting it wrong means deleting a whole batch:

- **Native re-post** (`fetch-source-post.js` + `postContent`) — the target Page posts the caption and images as its own content. No visible link back to the source.
- **Share card** (`share-post.js` + `shareContent`) — the target Page posts the `/share/p/` link and Facebook renders it as a share of the original, crediting the source Page.

Ask with a plain-language multiple choice ("Đăng lại nội dung như bài của chính trang đó, hay share có dẫn nguồn về Thiên Hổ?"). Steps 1–4 and 7–9 below are shared; steps 5–6 and 9 differ per route.

1. **Ask which Page to pull content from** (the "source" Page): run `get-token.js`, then present the Page names as a single-select list ("Bạn muốn lấy nội dung từ trang nào?").
2. **Show that Page's recent posts as a picker**: call `node share-post.js list '<page-json>'` for the chosen Page, then present each returned post as an option — label = first ~60 characters of `message` (or "[ảnh, không có chữ]" if empty), with the post's date as the description. Single-select ("Lấy bài viết nào?"). Keep this to the most recent 5-8 posts so the list isn't overwhelming.
3. **Ask which Page(s) receive it**: present all *other* Pages (exclude the source Page) as a multi-select list ("Đăng bài này lên (những) trang nào?").
4. **Check what is already on those Pages today**: `readAllLogs()` for the skill's own entries *and* `node check-today-posts.js` for what is actually on Facebook, since hand-posted content is invisible to the log. If anything is already published there today, show it and confirm before continuing — the same batch has been published twice within an hour before.
5. **Get the source content for the chosen route**:
   - Native re-post → `fetchAndDownload(postId, sourcePage)` from `fetch-source-post.js` gives the caption plus local `imagePaths`/`videoPaths`.
   - Share card → ask the user for the post's `/share/p/` short link (see "Which link to share"), and keep the real `<pageId>_<postId>` from step 2 for `sourcePostId`.
6. **Ask whether to edit the caption** or keep the original wording (optional free-text vs. a "Giữ nguyên nội dung gốc" option) — optional and skippable.
7. **Resolve timing** the same way as posting (see step 6 in the posting workflow above): future date → ask for a time and schedule; today/past or "now" → confirm explicitly first.
8. **Confirm before publishing**: show one plain-language summary — which post (short preview), from which Page, to which Page(s), when, and roughly how long the staggered run will take.
9. **Publish to one Page first, then the rest.** Call `postContent(...)` (native) or `shareContent(...)` (share card) for a single target Page, show the user the result, and only continue to the remaining Pages once they confirm it looks right. Then run the rest under Monitor and report progress as it goes. Report per-Page success/failure in plain language (Page name, not raw IDs).

## Workflow: daily satellite-page repost/share (theo Danh sách Fanpage vệ tinh)

Use this when the user wants the day's scheduled satellite-Page activity run (e.g. "đăng bài hôm nay theo lịch", "chạy lịch vệ tinh hôm nay") rather than a one-off share/post to an explicit list of Pages they already named.

1. **Resolve the target date** (default: today) and read the schedule sheet — see "Danh sách Fanpage vệ tinh (Repost & Share)" above — for all 4 tabs' Thao tác value on that date.
2. **Show the user a summary before doing anything**: one line per tab — tab name, action (Đăng bài / Share bài / Không đăng), and Page count — so they can catch a wrong date or a tab they didn't expect to run. Skip tabs marked Không đăng; ask the user about any blank cell rather than guessing.
3. **For each tab that needs action, get the source content**:
   - If the user already gave a source (a Facebook link, or "dùng bài hôm nay của Thiên Hổ"), reuse it for every tab due to publish that day, unless the user says the tabs need different content.
   - Otherwise ask which Page/post to pull from, same as steps 1–2 of "Workflow: re-posting a Page's post to other Pages".
4. **Run each tab through the matching route** from "Workflow: re-posting a Page's post to other Pages" (Đăng bài → native re-post; Share bài → share card) — one tab at a time, one Page first then the rest under Monitor, same confirmation and stagger rules as that workflow.
5. **Report the manual sheet update needed**: there is no Sheets-write tool available (see the caveat above), so end with an explicit checklist for the user — tab name, date, and which Page columns to tick TRUE — instead of a vague "đã cập nhật sheet".
