# gas-automations
Google AppScript automations related to SolidarityTech, ActionNetwork, and Gcal


Syncs events from any public `.ics` feed (Google Calendar, Outlook,
Zoom, etc.) into a Google Calendar, using the source event's UID to
update existing events in place instead of creating duplicates on
every run.

Designed to run on a time-driven trigger in Google Apps Script, but
works just as well when invoked manually from the editor.


## What it does

- **Fetches** an ICS feed over HTTP(S) or `webcal://`.
- **Parses** `VEVENT` blocks (title, description, location, start,
  end, and `RRULE` recurrence rules).
- **Cleans** trailing Zoom boilerplate from descriptions (join links,
  passcodes, dial-in numbers) — configurable via `STRIP_PATTERNS`.
- **Deduplicates** using the source `UID`, stored as a private
  extended property (`sourceUID`) on each event. Re-running the sync
  patches changed fields instead of creating a second copy.
- **Removes stray duplicates** — if an earlier broken run left
  multiple events with the same UID, the extras are deleted on the
  next sync.
- **Serialises runs** with `LockService`, so a long sync won't
  overlap with the next scheduled one.


## Requirements

- A Google account with access to the target calendar.
- The **Advanced Google Calendar service** enabled in the Apps
  Script project (identifier: `Calendar`). See *Setup* below.
- The target calendar must be writable by the account running the
  script.


## Setup

### 1. Create the Apps Script project

Either clone an existing project:

```bash
clasp clone <scriptId>
```

…or create a new one:

```bash
clasp create --title "ICS Calendar Sync" --type standalone
```

..or just create a new appscript project in drive, and copy the Code.js file over to
it in the editor.

### 2. Enable the Advanced Calendar service

In the Apps Script editor:

1. Open **Services** (the `+` next to "Services" in the left sidebar).
2. Find **Google Calendar API**, click **Add**.
3. When prompted, the service identifier should be `Calendar`. If it
   isn't, rename it — the script calls `Calendar.Events.*` directly.

> **Why is this needed?** The script uses `Calendar.Events.list` to
> do a single paginated lookup of all events carrying our UID tag,
> and `Calendar.Events.insert` / `.patch` to write events with
> extended properties. The plain `CalendarApp` service can't set
> extended properties or filter by them, so it can't perform the
> dedup lookup efficiently.

### 3. Paste in the code

Copy `Code.gs` (and any other `.gs` files) into the project, then
push:

```bash
clasp push
```

### 4. Set the script properties

The script reads two values from **Project Settings → Script
properties**:

| Property             | Description                                              |
| -------------------- | -------------------------------------------------------- |
| `SOURCE_ICS_URL`     | URL of the `.ics` feed. `http(s)://` or `webcal://`.     |
| `TARGET_CALENDAR_ID` | Calendar ID of the destination calendar.                |

Set them either through the UI, or by editing `setConfig()` in
`Code.gs` and running it once from the editor:

```javascript
function setConfig() {
  PropertiesService.getScriptProperties().setProperties({
    SOURCE_ICS_URL: 'https://example.com/calendar.ics',
    TARGET_CALENDAR_ID: 'primary'
  }, false);
  Logger.log('Script properties updated.');
}
```

> To find a calendar's ID: open **Google Calendar → Settings for
> that calendar → Integrate calendar → Calendar ID**. For the
> account's primary calendar, the literal string `primary` works.

### 5. Run a first sync

From the Apps Script editor, select `syncCalendar` and click **Run**.
The first run will prompt for OAuth authorisation — approve it. You
should see output in the execution log like:

```
Fetched ICS in 412 ms
Parsed 87 events from the feed.
After time filter: 62 events.
Loaded 0 existing events in 118 ms
Applied in 3421 ms
Sync complete. Created: 62, Updated: 0, Unchanged: 0, Skipped: 0
```

Run it a second time — you should see `Unchanged: 62` and nothing
new created. That's the dedup working.

### 6. Install a trigger

To run automatically, execute `setupTrigger()` once from the editor.
It installs a single hourly time-driven trigger for `syncCalendar`,
removing any pre-existing ones first so you don't end up with
duplicates.

Change the interval by editing the `.everyHours(1)` call in
`setupTrigger()` before running it.

---

## Configuration reference

### Script properties (set in the UI)

| Property             | Required | Notes                                              |
| -------------------- | -------- | -------------------------------------------------- |
| `SOURCE_ICS_URL`     | yes      | `webcal://` is silently rewritten to `https://`.   |
| `TARGET_CALENDAR_ID` | yes      | `primary` or a full calendar ID.                   |

### Constants (edit in `Code.gs`)

| Constant          | Default | Purpose                                                              |
| ----------------- | ------- | -------------------------------------------------------------------- |
| `SOURCE_UID_KEY`  | `sourceUID` | Extended-property key used to tag events. Change only if it collides with something else. |
| `SYNC_PAST_DAYS`  | `30`    | Events that ended more than this many days ago are ignored. Set to `Infinity` to sync the whole feed. |
| `STRIP_PATTERNS`  | see file | Regexes for trailing description lines to remove.                    |

---

## Utility functions

These are not called by the trigger — run them manually from the
editor when you need them.

| Function              | What it does                                                                 |
| --------------------- | ---------------------------------------------------------------------------- |
| `syncCalendar`        | The main sync.                                                                |
| `setConfig`           | One-shot helper to write `SOURCE_ICS_URL` and `TARGET_CALENDAR_ID`.           |
| `setupTrigger`        | Installs exactly one hourly trigger for `syncCalendar`.                      |
| `killAllTriggers`     | Deletes every trigger in the project. Useful when resetting.                 |
| `diagnose`            | Logs property status, service availability, calendar name, event count, triggers. |
| `verifyEmpty`         | Logs how many events are in the target calendar.                              |
| `wipeTargetCalendar`  | Deletes all events via `CalendarApp`. Run twice if recurring series leave orphaned instances. |
| `purgeAllEvents`      | Deletes all events via the Advanced Service. Faster and more thorough than `wipeTargetCalendar`. |

---

## Deployment / running via `clasp run`

If you want to trigger the sync from the command line with
`clasp run syncCalendar`, the project needs more setup than a plain
`clasp login` provides. `clasp run` uses the Apps Script Execution
API, which requires:

1. A **standard GCP project** linked to the Apps Script project.
   Copy its project number from the Cloud Console and paste it into
   **Project Settings → GCP Project**.

2. The `projectId` field added to your local `.clasp.json`:

   ```json
   {
     "scriptId": "…",
     "projectId": "my-gcp-project-123456",
     "rootDir": "."
   }
   ```

3. Explicit `oauthScopes` in `appsscript.json`:

   ```json
   {
     "timeZone": "America/New_York",
     "dependencies": {},
     "exceptionLogging": "STACKDRIVER",
     "runtimeVersion": "V8",
     "oauthScopes": [
       "https://www.googleapis.com/auth/script.external_request",
       "https://www.googleapis.com/auth/calendar",
       "https://www.googleapis.com/auth/script.scriptapp"
     ]
   }
   ```

4. A **Desktop OAuth client** created in the Cloud Console
   (APIs & Services → Credentials → Create Credentials → OAuth
   client ID → Desktop app). Download the JSON and save it as
   `client_secret.json` in the project directory.

5. Re-authenticate `clasp` with those credentials and the project's
   scopes:

   ```bash
   clasp login --creds client_secret.json --use-project-scopes
   ```

6. The script deployed as an **API Executable**
   (Deploy → New deployment → gear icon → API Executable).

If any of these are missing, `clasp run syncCalendar` fails with
`NOT_FOUND` or a scope error.

---

## Troubleshooting

### `Exception: We're sorry, a server error occurred... NOT_FOUND`

Missing one of the six prerequisites listed above. The most common
culprits are a missing `projectId` in `.clasp.json`, missing
`oauthScopes` in the manifest, or a `clasp login` that was done
without `--use-project-scopes`.

### `FATAL: enable the Google Calendar Advanced Service`

The Advanced Calendar service isn't enabled, or it's enabled under a
different identifier than `Calendar`. Check the **Services** panel
in the editor.

### `FATAL: Missing script property: SOURCE_ICS_URL`

The script property hasn't been set. Run `setConfig()` or add it
manually through Project Settings → Script properties.

### `Fetch failed with status: 404` (or any non-200)

The ICS URL is wrong, private, or requires authentication. Public
Google Calendar ICS feeds end in `/public/basic.ics` — if you're
using the "Secret address in iCal format" URL, that's a different
endpoint and does not work with this script's unauthenticated fetch.

### Events appear twice

The second copy was probably created before the `sourceUID` extended
property was in use. `loadExistingByUID` only recognises events
tagged with that property, so untagged duplicates aren't matched.
Delete the untagged copies manually (or run `purgeAllEvents` and
re-sync from scratch).

### Times are shifted by hours

The ICS feed uses a `TZID` that Apps Script doesn't recognise, and
the fallback is your project's time zone. Check **Project Settings →
Time zone** — it should match the calendar's time zone.

### `RRULE` events only appear once

The script passes `RRULE` through to Google Calendar, which expands
the series itself. If the feed uses non-standard recurrence
extensions (`RDATE`, `EXDATE`, `RECURRENCE-ID` overrides), those are
not currently handled.

### The trigger stops firing

Google disables triggers if the script exceeds quota or throws
repeatedly. Check **Executions** in the editor for the failure
reason, fix it, then re-run `setupTrigger()`.


## Limitations

- **No `RDATE` / `EXDATE` support.** Only `RRULE` is carried over.
  Events with exception dates will show the wrong set of instances.
- **No incremental sync.** Every run re-fetches and re-parses the
  entire feed. Fine for feeds with a few hundred events; slow for
  thousands.
- **No deletion propagation.** Events removed from the source feed
  are left in the target calendar. There's a `PROPAGATE_DELETIONS`
  idea in older versions of this script but it isn't wired up here —
  deletions must be handled manually via `purgeAllEvents` +
  re-sync, or by adding the logic back in.
- **Description-only patching.** On update, only the description is
  compared and patched. Changes to title, location, or times in the
  source feed won't propagate to already-created events.
- **`Calendar.Events.list` caps out** around 2,500 events per
  calendar. If your target calendar is larger than that, narrow the
  `SYNC_PAST_DAYS` window.


## File layout

```
.
├── Code.gs          # Everything: config, parsing, sync, utilities
├── appsscript.json  # Manifest (scopes, time zone, runtime)
├── .clasp.json      # Local clasp project config (gitignored)
├── .claspignore     # Files clasp shouldn't push
└── README.md
```

### Suggested `.claspignore`

```
**/**
!Code.gs
!appsscript.json
```

This keeps `README.md`, `Makefile`, and any other repo files out of
the Apps Script project, so the editor only sees the files that
actually run.

### Suggested `.gitignore`

```
.clasprc.json
client_secret.json
node_modules/
```

Never commit `.clasprc.json` or `client_secret.json` — both contain
OAuth credentials.


## License

MIT (or whatever you prefer — replace this line).
```

### Notes on choices I made

- **I documented the `clasp run` setup in full**, since you hit the `NOT_FOUND` error and that's the most likely reason someone will open the README.
- **I didn't document a `Makefile` section** because your Makefile is a separate artefact — if you want it folded in, say the word and I'll add a section showing the common `make` targets.
- **The `Limitations` section is honest about what the script doesn't do.** That's better than letting someone assume it handles `EXDATE` correctly, discover the hard way that it doesn't, and file a bug.
- **I suggested a `.claspignore`** because without one, `clasp push` will try to upload `README.md` as an Apps Script file — which "works" but is confusing in the editor.
