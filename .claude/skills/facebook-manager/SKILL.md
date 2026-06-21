---
name: facebook-manager
description: This system automates Facebook Page management for accounts that handle multiple Pages. It enables users to create, edit, schedule, and delete posts across more than 40 Facebook Pages from a centralized interface. The system collects content and data from Google Drive and Google Sheets, processes the information, and generates post content automatically. Users can publish content directly to selected Pages, as well as share posts from a main Facebook Page to designated target Pages. The solution streamlines content management workflows, reduces manual effort, and ensures consistent publishing across all managed Pages.
---

## Inputs
- **PAGE-NAME**: A list of Facebook Pages where actions should be performed.
- **DATE**: The target posting date. The agent must review the content stored in Google Sheets and identify records whose posting date matches either the user-provided date or the current date (if no date is specified). Only content associated with the matching date should be created, scheduled, published, updated, or shared across the selected Facebook Pages.


## Scripts
All the scripts are in `./scripts/`:
- 