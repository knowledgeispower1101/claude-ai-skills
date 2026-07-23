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
  - Pages are posted to **sequentially**, with a random pause between them drawn from `delayRange` (`{min, max}` in seconds, default `{min: 120, max: 300}`) — see "Never publish to many Pages at once" below. Pass `{min: 0, max: 0}` only for a single-Page post. Budget the wall-clock time before starting: 34 Pages at the default is roughly 1.5–2 hours, so run it in the background and report progress.
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
  - exports `deleteLoggedPost(postId)`
- `share-post.js` - shares one Page's existing post to one or more other Pages, via a "shared link" post (the target Page posts a link to the original, which Facebook renders as a share preview card). Still usable — the earlier belief that this format specifically was causing hidden posts did not survive testing (see "Posts on the satellite Pages may not be visible" below)
  - `node share-post.js list '{"id":"...","name":"...","access_token":"..."}'` → recent posts of that Page (`id`, `message`, `created_time`, `permalink_url`, `full_picture`), for the user to pick which one to share
  - exports `listRecentPosts(page, limit)` and `shareContent({ sourcePostId, sourcePermalinkUrl, message, targetPages, published, scheduledTime })`
  - `targetPages` is an array of `{ id, name, access_token }`; `message` is an optional extra caption on top of the shared link
  - every successful share is appended to that month's log file with `sharedFrom` set to the source post's ID
  - CLI usage: `node share-post.js '<json-request>'`
- `post-log-store.js` - shared module backing the monthly log files (see "Post log" below); exports `readAllLogs()`, `appendToLog(entries)`, `removeEntry(postId)`, `setCalendarEventId(postId, calendarEventId)`, `listLogFiles()`
- `read-google-sheet.js` / `download-image.js` - legacy Sheet-based content pipeline, kept for reference

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
  "calendarEventId": "abc123def456"
}
```
This is the source of truth for "what did we post where" — use `post-log-store.js`'s `readAllLogs()` (merges every monthly file) to find a `postId` when the user wants to delete or look up a past post (by date, Page name, or content). To delete a post, call `delete-post.js <postId>`; it searches across all monthly files, handles finding the right Page token, and cleans up the log entry in whichever month file has it. There's no separate "edit" API call for feed/photo posts — Facebook only allows editing the text of a plain feed post via `POST /{post-id}` with a new `message`; treat edits to photo posts as delete + repost.

The monthly log files are local to this machine (not synced to Drive) — don't delete or hand-edit them outside of `post-content.js`/`delete-post.js`/`set-calendar-event-id.js`/`post-log-store.js`, since they're the only record of which Facebook post ID maps to which Page/content.

`calendarEventId` starts as `null` on every new entry — the Facebook-side scripts have no access to Google Calendar. Claude fills it in as a follow-up step right after publishing (see "Google Calendar sync" below).

## Google Calendar sync

Every piece of content that gets created or scheduled for posting must also show up on Google Calendar, so the team can see the publishing schedule at a glance. Facebook scripts can't do this themselves (they only talk to the Graph API), so this is a step Claude performs directly with the `mcp__claude_ai_Google_Calendar__*` tools right after a successful `postContent`/`shareContent` call.

- **Which calendar**: use the user's primary calendar (their own email, e.g. `ai.thienhotechnology@gmail.com`) unless the user says otherwise. Call `list_calendars` if unsure which id to use.
- **One event per successful Page post** (mirrors the one-log-entry-per-Page shape of `post-log.json`), created via `create_event`:
  - `summary`: `"[<Page name>] <first ~60 chars of the caption>"` (or `"[<Page name>] Ảnh/không có chữ"` if the message is empty).
  - `description`: the full caption, plus the source Drive folder (`sourceFolder`) if present, plus the Facebook `postId`.
  - **start/end time**:
    - Scheduled post (`published: false`) → start = `scheduledTime` (converted from unix seconds), end = start + 30 minutes.
    - Published immediately (`published: true`) → start = the post's `createdAt` (i.e. now), end = start + 30 minutes.
  - Use the same timezone as the Page/team (`Asia/Ho_Chi_Minh` unless told otherwise).
- **After creating the event**, link it back to the log entry so it can be found again later: `node set-calendar-event-id.js <postId> <calendarEventId>`.
- **Report to the user** which posts got calendar events (or if calendar sync failed for any post — don't silently drop it, but also don't block the Facebook publish on a calendar failure since the post itself already succeeded).
- **On delete**: `delete-post.js <postId>` returns (and prints as JSON) the entry's `calendarEventId`. If it's non-null, call `mcp__claude_ai_Google_Calendar__delete_event` to remove the matching calendar event as part of the same delete flow — a deleted Facebook post shouldn't leave a stale calendar entry behind.

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
9. **Sync to Google Calendar**: for each successful Page post from step 8, create a calendar event and link it back to the log entry — see "Google Calendar sync" below. Do this for every publish, whether it went out now or is scheduled for the future.

## Posts on the satellite Pages may not be visible — and the API cannot tell you

**Unresolved as of 2026-07-22.** Content on the satellite Pages (Biến tần …, Motor giảm tốc …, Trung Kiên …) is reaching readers inconsistently: some posts are unviewable to anyone who is not a Page admin, while other posts on the same Page, same day, same structure are fine. The main Thiên Hổ Technology Page (5.2k followers) is unaffected.

**Never claim a batch is healthy on the strength of API fields.** `is_published: true`, `is_hidden: false` and `privacy: EVERYONE` were all reported for posts that readers could not see. Page-level probes are equally useless here — `is_published`, `is_unclaimed`, `promotion_eligible` all come back clean, and `restrictions` / `country_restrictions` / `age_restrictions` do not exist as fields. Report what the fields say, not what you infer from them.

Ruled out by direct testing, so don't re-propose these as the cause: post privacy (that was a separate, real bug — see below), link-share vs native format, content duplicated across Pages, album vs single-photo structure, and post age. The leading untested hypothesis is Meta limiting distribution across a network of 40+ low-follower Pages publishing identical content — which, if true, is an operating-model problem, not something to fix in these scripts.

Only the user can resolve it, via **Meta Business Suite → Chất lượng trang / Tình trạng tài khoản** on an affected Page. To check whether a specific post is visible, ask someone with an ordinary logged-in Facebook account who is not a Page admin; incognito is not a valid test, because Facebook gates logged-out browsing regardless of a post's settings.

Given all that, for anything past a couple of Pages:

1. **Confirm visibility before scaling.** Publish to one Page, have it checked by a real non-admin account, and only then run the rest.
2. **Keep the stagger.** `Promise.all` across N Pages puts N identical posts on Facebook in the same second. `postContent` staggers sequentially instead — leave `delayRange` at its default and never zero it for a multi-Page run to save time.
3. **Warn the user before a large batch** how long it will take, and offer to split it across several runs or days.

### Reporting progress on a staggered run

`postContent` prints a timeline-style report after **every** Page — the format the user picked:

```
20:44  ✅  Biến Tần Bình Chánh
── 16/34 trang · ✅15 ❌1 · còn ~50 phút ──
⏳ Kế tiếp: Biến tần Nghệ An (sau 3p10s)
```

Run the batch under the **Monitor** tool, not `Bash(run_in_background)`. Monitor turns each stdout line into a chat notification, which is the only way the user gets a live update per Page; a backgrounded Bash command only notifies once, on exit. The three lines above are printed together so Monitor batches them into a single notification per Page.

Monitor's `timeout_ms` caps out at 1 hour, which is shorter than a full batch (34 Pages ≈ 2 hours), so pass `persistent: true` instead — otherwise the monitor is killed mid-run while the posting continues unwatched. Don't pipe the command through `grep` to tidy the output either: extra pipe stages risk buffering the lines that are the whole point. A couple of startup lines from `get-token.js` are a fair trade.

Validate before launching a long run — resolve every target Page name and fetch the source content first (a `--dry-run` flag on the runner), so a typo fails in seconds rather than 20 minutes in.

Relay these lines to the user as-is — don't reformat them into a table or summarise them away.

## Workflow: re-posting a Page's post to other Pages

The team includes non-technical members, so this flow is pure multiple-choice — never ask them to paste a post ID, a URL, or any JSON. Everything Claude needs (Page IDs, tokens, post IDs, permalink URLs) is fetched internally and only human-readable labels are shown to the user.

1. **Ask which Page to pull content from** (the "source" Page): run `get-token.js`, then present the Page names as a single-select list ("Bạn muốn lấy nội dung từ trang nào?").
2. **Show that Page's recent posts as a picker**: call `node share-post.js list '<page-json>'` for the chosen Page, then present each returned post as an option — label = first ~60 characters of `message` (or "[ảnh, không có chữ]" if empty), with the post's date as the description. Single-select ("Lấy bài viết nào?"). Keep this to the most recent 5-8 posts so the list isn't overwhelming.
3. **Ask which Page(s) receive it**: present all *other* Pages (exclude the source Page) as a multi-select list ("Đăng bài này lên (những) trang nào?").
4. **Check the log for duplicates**: call `readAllLogs()` and look for today's entries on the chosen Pages carrying the same message. If any exist, show the user what is already published and confirm before continuing — the same batch has been published twice within an hour before.
5. **Fetch the source content**: `fetchAndDownload(postId, sourcePage)` from `fetch-source-post.js` gives the caption plus local `imagePaths`/`videoPaths`.
6. **Ask whether to edit the caption** or keep the original wording (optional free-text vs. a "Giữ nguyên nội dung gốc" option) — optional and skippable.
7. **Resolve timing** the same way as posting (see step 6 in the posting workflow above): future date → ask for a time and schedule; today/past or "now" → confirm explicitly first.
8. **Confirm before publishing**: show one plain-language summary — which post (short preview), from which Page, to which Page(s), when, and roughly how long the staggered run will take.
9. **Publish**: call `postContent(...)` once with the fetched caption/media and the confirmed `targetPages`. It posts sequentially with a random pause between Pages, so run it in the background for anything over a handful of Pages and report progress as it goes. Report per-Page success/failure in plain language (Page name, not raw IDs).
10. **Sync to Google Calendar**: for each successful post from step 9, create a calendar event and link it back to the log entry — see "Google Calendar sync" below, same as the posting workflow.
