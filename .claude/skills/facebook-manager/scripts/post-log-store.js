const fs = require("fs");
const path = require("path");

const LOG_DIR = __dirname;
const LOG_FILE_PATTERN = /^post-log-(\d{4})-(\d{2})\.json$/;

function monthKeyFromDate(dateInput) {
  const date = dateInput ? new Date(dateInput) : new Date();
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  return `${yyyy}-${mm}`;
}

function logPathForMonthKey(monthKey) {
  return path.join(LOG_DIR, `post-log-${monthKey}.json`);
}

function listLogFiles() {
  return fs
    .readdirSync(LOG_DIR)
    .filter((name) => LOG_FILE_PATTERN.test(name))
    .sort()
    .map((name) => path.join(LOG_DIR, name));
}

function readLogFile(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf-8").trim();
  if (!raw) return [];
  return JSON.parse(raw);
}

function writeLogFile(filePath, log) {
  fs.writeFileSync(filePath, JSON.stringify(log, null, 2));
}

// Merged view across every monthly log file, oldest month first.
function readAllLogs() {
  return listLogFiles().flatMap((filePath) => readLogFile(filePath));
}

// Appends each entry to the file matching the month of its `createdAt`.
function appendToLog(entries) {
  if (entries.length === 0) return;

  const byMonth = new Map();
  entries.forEach((entry) => {
    const monthKey = monthKeyFromDate(entry.createdAt);
    if (!byMonth.has(monthKey)) byMonth.set(monthKey, []);
    byMonth.get(monthKey).push(entry);
  });

  byMonth.forEach((monthEntries, monthKey) => {
    const filePath = logPathForMonthKey(monthKey);
    const log = readLogFile(filePath);
    log.push(...monthEntries);
    writeLogFile(filePath, log);
  });
}

// Locates which monthly file holds a given postId.
function findEntryLocation(postId) {
  for (const filePath of listLogFiles()) {
    const log = readLogFile(filePath);
    const entry = log.find((item) => item.postId === postId);
    if (entry) return { filePath, log, entry };
  }
  return null;
}

// Removes an entry from whichever monthly file contains it. Returns the
// removed entry, or null if no log file has that postId.
function removeEntry(postId) {
  const found = findEntryLocation(postId);
  if (!found) return null;

  const remaining = found.log.filter((item) => item.postId !== postId);
  writeLogFile(found.filePath, remaining);
  return found.entry;
}

// Patches in the Google Calendar event id for an already-logged post, once
// Claude has created the corresponding calendar event via the Calendar MCP tool.
function setCalendarEventId(postId, calendarEventId) {
  const found = findEntryLocation(postId);
  if (!found) {
    throw new Error(`No log entry found for postId "${postId}"`);
  }

  found.entry.calendarEventId = calendarEventId;
  writeLogFile(found.filePath, found.log);
  return found.entry;
}

module.exports = {
  LOG_DIR,
  monthKeyFromDate,
  logPathForMonthKey,
  listLogFiles,
  readAllLogs,
  appendToLog,
  removeEntry,
  setCalendarEventId,
};
