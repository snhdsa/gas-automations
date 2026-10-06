/**
 * CONFIGURATION
 *
 * These values are read from the script's properties at runtime.
 * Set them under:
 *   Project Settings (gear icon) → Script properties
 *
 *   SOURCE_ICS_URL      - URL of the .ics feed (http/https/webcal)
 *   TARGET_CALENDAR_ID  - Calendar ID of the destination calendar
 *
 * You can also set them once via setConfig() below. HIGHLY RECOMMENDED
 */

function getSourceIcsUrl() {
  const raw = (PropertiesService.getScriptProperties().getProperty('SOURCE_ICS_URL') || '').trim();
  if (!raw) throw new Error('Missing script property: SOURCE_ICS_URL');
  return raw.replace(/^webcal:\/\//i, 'https://');
}

function getTargetCalendarId() {
  const id = (PropertiesService.getScriptProperties().getProperty('TARGET_CALENDAR_ID') || '').trim();
  if (!id) throw new Error('Missing script property: TARGET_CALENDAR_ID');
  return id;
}

/**
 * One-time helper: writes SOURCE_ICS_URL and TARGET_CALENDAR_ID into the
 * script properties. Edit the two values, then run this from the editor.
 */
function setConfig() {
  PropertiesService.getScriptProperties().setProperties({
    SOURCE_ICS_URL: '',
    TARGET_CALENDAR_ID: ''
  }, false); // false = keep any other existing properties
  Logger.log('Script properties updated.');
}

/**
 * Private extended-property key used to stamp each event with its
 * source ICS UID, so future runs can find and update it in place.
 */
const SOURCE_UID_KEY = 'sourceUID';

/**
 * Optional: only sync events that ended within this many days in the past.
 * Set to Infinity to sync everything.
 */
const SYNC_PAST_DAYS = 30;

/**
 * Trailing description lines to strip.
 */
const STRIP_PATTERNS = [
  /^\s*Join:\s*https:\/\/us06web\.zoom\.us\/meeting\/register\/\S+\s*$/i,
  /^\s*Passcode:\s*\S+\s*$/i,
  /^\s*Dial-in:\s*.*$/i
];

/* ------------------------------------------------------------------ */
/* ICS decoding and parsing                                            */
/* ------------------------------------------------------------------ */

function decodeICSValue(value) {
  if (!value) return '';
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '\\' && i + 1 < value.length) {
      const next = value[i + 1];
      if (next === 'n' || next === 'N') { out += '\n'; i++; continue; }
      if (next === ',')                  { out += ',';  i++; continue; }
      if (next === ';')                  { out += ';';  i++; continue; }
      if (next === '\\')                 { out += '\\'; i++; continue; }
    }
    out += c;
  }
  return out;
}

function parseICS(icsText) {
  const events = [];
  const unfolded = icsText.replace(/\r?\n[ \t]/g, '');
  const blocks = unfolded.split('BEGIN:VEVENT').slice(1);

  for (const block of blocks) {
    const endIdx = block.indexOf('END:VEVENT');
    const body = endIdx !== -1 ? block.substring(0, endIdx) : block;

    const ev = {
      uid: extractProperty(body, 'UID'),
      title: extractProperty(body, 'SUMMARY') || 'Untitled Event',
      description: extractProperty(body, 'DESCRIPTION'),
      location: extractProperty(body, 'LOCATION'),
      start: parseICSDate(extractProperty(body, 'DTSTART')),
      end: parseICSDate(extractProperty(body, 'DTEND')),
      recurrence: extractRRule(body)
    };

    if (ev.start && ev.end) events.push(ev);
  }
  return events;
}

function extractProperty(block, propName) {
  const regex = new RegExp('^' + propName + '(?:;[^:]*)?:(.*)$', 'm');
  const match = block.match(regex);
  if (!match) return '';
  return decodeICSValue(match[1].trim());
}

function extractRRule(block) {
  const match = block.match(/^RRULE:(.*)$/m);
  if (!match) return [];
  return ['RRULE:' + match[1].trim()];
}

function parseICSDate(value) {
  if (!value) return null;

  if (/^\d{8}$/.test(value)) {
    const y = parseInt(value.substring(0, 4), 10);
    const m = parseInt(value.substring(4, 6), 10) - 1;
    const d = parseInt(value.substring(6, 8), 10);
    return new Date(y, m, d);
  }

  if (/^\d{8}T\d{6}Z?$/.test(value)) {
    const y  = parseInt(value.substring(0, 4), 10);
    const m  = parseInt(value.substring(4, 6), 10) - 1;
    const d  = parseInt(value.substring(6, 8), 10);
    const hh = parseInt(value.substring(9, 11), 10);
    const mm = parseInt(value.substring(11, 13), 10);
    const ss = parseInt(value.substring(13, 15), 10);

    if (value.endsWith('Z')) return new Date(Date.UTC(y, m, d, hh, mm, ss));
    return new Date(y, m, d, hh, mm, ss);
  }

  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

/* ------------------------------------------------------------------ */
/* Description cleaning                                                */
/* ------------------------------------------------------------------ */

function stripJoinLines(description) {
  if (!description) return '';
  const lines = description.split(/\r?\n/);

  while (lines.length > 0) {
    const last = lines[lines.length - 1].trim();
    const isBlank = last === '';
    const isStripLine = STRIP_PATTERNS.some(function (re) { return re.test(last); });

    if (isBlank || isStripLine) lines.pop();
    else break;
  }

  return lines.join('\n').trim();
}

/* ------------------------------------------------------------------ */
/* Calendar: bulk lookup, create, patch                                */
/* ------------------------------------------------------------------ */

/**
 * Loads every event in the target calendar that carries our SOURCE_UID_KEY
 * extended property, in a single paginated pass.
 * Returns Map<uid, {id, description}>.
 *
 * If duplicate events share the same UID (leftovers from earlier broken
 * runs), the extra ones are deleted on the spot and only the first is kept.
 */
function loadExistingByUID(calId) {
  const map = new Map();
  let pageToken = null;

  do {
    const resp = Calendar.Events.list(calId, {
      maxResults: 250,
      pageToken: pageToken,
      singleEvents: false,
      showDeleted: false,
      fields: 'nextPageToken,items(id,description,extendedProperties)'
    });

    const items = resp.items || [];
    for (const item of items) {
      const uid = item.extendedProperties &&
                  item.extendedProperties.private &&
                  item.extendedProperties.private[SOURCE_UID_KEY];
      if (!uid) continue;

      if (!map.has(uid)) {
        map.set(uid, { id: item.id, description: item.description || '' });
      } else {
        try {
          Calendar.Events.remove(calId, item.id);
          Logger.log('Deleted duplicate event ' + item.id + ' for UID ' + uid);
        } catch (e) { /* ignore */ }
      }
    }

    pageToken = resp.nextPageToken;
  } while (pageToken);

  return map;
}

/**
 * Creates an event via the Advanced Service, stamping the source UID as a
 * private extended property. Returns the new event ID.
 */
function createEventWithUID(calendar, ev, options) {
  const resource = {
    summary: ev.title,
    description: options.description || '',
    location: options.location || '',
    start: {
      dateTime: ev.start.toISOString(),
      timeZone: Session.getScriptTimeZone()
    },
    end: {
      dateTime: ev.end.toISOString(),
      timeZone: Session.getScriptTimeZone()
    },
    extendedProperties: { private: {} }
  };

  if (ev.uid) resource.extendedProperties.private[SOURCE_UID_KEY] = ev.uid;
  if (ev.recurrence && ev.recurrence.length > 0) resource.recurrence = ev.recurrence;

  const created = Calendar.Events.insert(resource, calendar.getId());
  return created.id;
}

/* ------------------------------------------------------------------ */
/* Main sync                                                          */
/* ------------------------------------------------------------------ */

function syncCalendar() {
  // Prevent overlapping runs from racing each other.
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    Logger.log('Another sync is already running — skipping this pass.');
    return;
  }

  try {
    if (typeof Calendar === 'undefined' || !Calendar.Events) {
      Logger.log('FATAL: enable the Google Calendar Advanced Service (identifier "Calendar").');
      return;
    }

    // Read config from script properties
    let sourceIcsUrl, targetCalendarId;
    try {
      sourceIcsUrl = getSourceIcsUrl();
      targetCalendarId = getTargetCalendarId();
    } catch (e) {
      Logger.log('FATAL: ' + e.message);
      return;
    }

    const targetCal = CalendarApp.getCalendarById(targetCalendarId);
    if (!targetCal) {
      Logger.log('Target calendar not found. Check TARGET_CALENDAR_ID.');
      return;
    }

    // 1. Fetch ICS
    let icsText;
    const t0 = Date.now();
    try {
      const response = UrlFetchApp.fetch(sourceIcsUrl, { muteHttpExceptions: true });
      if (response.getResponseCode() !== 200) {
        Logger.log('Fetch failed with status: ' + response.getResponseCode());
        return;
      }
      icsText = response.getContentText();
    } catch (e) {
      Logger.log('Fetch error: ' + e.message);
      return;
    }
    Logger.log('Fetched ICS in ' + (Date.now() - t0) + ' ms');

    // 2. Parse
    let events = parseICS(icsText);
    Logger.log('Parsed ' + events.length + ' events from the feed.');

    // Optional: restrict to recent/upcoming events
    if (isFinite(SYNC_PAST_DAYS)) {
      const cutoff = new Date(Date.now() - SYNC_PAST_DAYS * 86400000);
      events = events.filter(function (ev) { return ev.end && ev.end >= cutoff; });
      Logger.log('After time filter: ' + events.length + ' events.');
    }

    // 3. Bulk-load existing events keyed by source UID
    const t1 = Date.now();
    const existingByUid = loadExistingByUID(targetCal.getId());
    Logger.log('Loaded ' + existingByUid.size + ' existing events in ' +
               (Date.now() - t1) + ' ms');

    // 4. Diff and apply
    const t2 = Date.now();
    let created = 0, updated = 0, unchanged = 0, skipped = 0;

    for (const ev of events) {
      if (!ev.uid) {
        Logger.log('Skipping event with no UID: ' + ev.title);
        skipped++;
        continue;
      }

      const cleaned = stripJoinLines(ev.description) || '';
      const prev = existingByUid.get(ev.uid);

      try {
        if (prev) {
          if ((prev.description || '') !== cleaned) {
            Calendar.Events.patch(
              { description: cleaned },
              targetCal.getId(),
              prev.id
            );
            updated++;
          } else {
            unchanged++;
          }
        } else {
          createEventWithUID(targetCal, ev, { description: cleaned });
          created++;
        }
      } catch (e) {
        Logger.log('Error on "' + ev.title + '" (UID ' + ev.uid + '): ' + e.message);
        skipped++;
      }
    }

    Logger.log('Applied in ' + (Date.now() - t2) + ' ms');
    Logger.log('Sync complete. Created: ' + created +
               ', Updated: ' + updated +
               ', Unchanged: ' + unchanged +
               ', Skipped: ' + skipped);
  } finally {
    lock.releaseLock();
  }
}

// Maintenance utilities
//   Functions to help with testing/debugging

/**
 * Deletes every event in the target calendar.
 * Run twice if recurring series leave orphaned instances behind.
 */
function wipeTargetCalendar() {
  const cal = CalendarApp.getCalendarById(getTargetCalendarId());
  if (!cal) { Logger.log('Target calendar not found.'); return; }

  const events = cal.getEvents(new Date(2000, 0, 1), new Date(2100, 0, 1));
  Logger.log('Deleting ' + events.length + ' events...');
  for (const ev of events) {
    try { ev.deleteEvent(); } catch (e) { /* ignore */ }
  }
  Logger.log('Done.');
}

/**
 * Fast, exhaustive purge using the Advanced Service. Handles recurring
 * series and event instances, no date-range limit.
 */
function purgeAllEvents() {
  const calId = getTargetCalendarId();
  let pageToken = null;
  let total = 0;

  do {
    const resp = Calendar.Events.list(calId, {
      maxResults: 250,
      pageToken: pageToken,
      showDeleted: false,
      singleEvents: false
    });

    const items = resp.items || [];
    for (const item of items) {
      try {
        Calendar.Events.remove(calId, item.id);
        total++;
      } catch (e) {
        Logger.log('Failed to delete ' + item.id + ': ' + e.message);
      }
    }

    pageToken = resp.nextPageToken;
  } while (pageToken);

  Logger.log('Deleted ' + total + ' events.');
}

/**
 * Prints a snapshot of the current state: service availability,
 * event count, trigger count, and property status.
 */
function diagnose() {
  Logger.log('=== Diagnostic ===');

  const props = PropertiesService.getScriptProperties();
  const srcUrl = props.getProperty('SOURCE_ICS_URL');
  const targetId = props.getProperty('TARGET_CALENDAR_ID');
  Logger.log('SOURCE_ICS_URL:      ' + (srcUrl ? 'SET' : 'MISSING'));
  Logger.log('TARGET_CALENDAR_ID:  ' + (targetId ? 'SET' : 'MISSING'));

  Logger.log('Calendar service: ' +
    (typeof Calendar !== 'undefined' && Calendar.Events ? 'AVAILABLE' : 'MISSING'));

  if (targetId) {
    const cal = CalendarApp.getCalendarById(targetId);
    Logger.log('Target calendar: ' + (cal ? 'OK (' + cal.getName() + ')' : 'NOT FOUND'));
    if (cal) {
      const events = cal.getEvents(new Date(2000, 0, 1), new Date(2100, 0, 1));
      Logger.log('Events in target calendar: ' + events.length);
    }
  }

  const triggers = ScriptApp.getProjectTriggers();
  Logger.log('Triggers: ' + triggers.length);
  triggers.forEach(function (t) {
    Logger.log('  - ' + t.getHandlerFunction());
  });
}

/**
 * Verifies the target calendar is empty.
 */
function verifyEmpty() {
  const cal = CalendarApp.getCalendarById(getTargetCalendarId());
  const events = cal.getEvents(new Date(1970, 0, 1), new Date(2100, 0, 1));
  Logger.log('Events remaining: ' + events.length);
}

/**
 * Installs a trigger that runs every 5 minutes for syncCalendar. Run ONLY ONCE manually.
 */
function setupTrigger() {
  for (const t of ScriptApp.getProjectTriggers()) {
    if (t.getHandlerFunction() === 'syncCalendar') {
      ScriptApp.deleteTrigger(t);
    }
  }
  ScriptApp.newTrigger('syncCalendar').timeBased().everyMinutes(5).create();
  Logger.log('Trigger installed. Total triggers now: ' +
             ScriptApp.getProjectTriggers().length);
}


/**
 * Deletes every trigger in the project. Use when cleaning up.
 */
function killAllTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  Logger.log('Deleting ' + triggers.length + ' trigger(s).');
  for (const t of triggers) {
    Logger.log('  - ' + t.getHandlerFunction());
    ScriptApp.deleteTrigger(t);
  }
}
