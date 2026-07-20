const { setCalendarEventId } = require("./post-log-store");

function main() {
  const [postId, calendarEventId] = process.argv.slice(2);

  if (!postId || !calendarEventId) {
    console.error(
      "Usage: node set-calendar-event-id.js <postId> <calendarEventId>",
    );
    process.exit(1);
  }

  const entry = setCalendarEventId(postId, calendarEventId);
  console.log(
    `✅ Linked calendar event ${calendarEventId} to post ${entry.postId} (${entry.pageName || entry.pageId})`,
  );
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error("❌", err.message || err);
    process.exit(1);
  }
}
