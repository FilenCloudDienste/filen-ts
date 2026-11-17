// "preview" namespace, text family — a calendar file's agenda. Spread into preview.ts; same catalog rules.
export const previewTextCalendar = {
	/** Calendar preview — the view switch's group name (Agenda | Source) */
	previewCalendarView: "Calendar view",
	/** Calendar preview — the view switch's option that shows the agenda */
	previewCalendarAgenda: "Agenda",
	/** Calendar preview — summary line; {{count}} entries (events and to-dos) */
	previewCalendarSummary_one: "{{count}} entry",
	/** Calendar preview — summary line; {{count}} entries (events and to-dos) */
	previewCalendarSummary_other: "{{count}} entries",
	/** Calendar preview — appended to the summary when entries past the cap are not shown; {{count}} of them */
	previewCalendarOmitted_one: "{{count}} more not shown",
	/** Calendar preview — appended to the summary when entries past the cap are not shown; {{count}} of them */
	previewCalendarOmitted_other: "{{count}} more not shown",
	/** Calendar preview — appended to the summary when the file was too long to read to its end; {{count}} entries past the cap were seen before reading stopped, so more may follow */
	previewCalendarOmittedAtLeast_one: "at least {{count}} more not shown",
	/** Calendar preview — appended to the summary when the file was too long to read to its end; {{count}} entries past the cap were seen before reading stopped, so more may follow */
	previewCalendarOmittedAtLeast_other: "at least {{count}} more not shown",
	/** Calendar preview — appended to the summary when the file was too long to read to its end and no entry past the cap was seen */
	previewCalendarTruncated: "the rest of the file was not read",
	/** Calendar preview — the file has no events or to-dos */
	previewCalendarEmpty: "This calendar has no events.",
	/** Calendar preview — reading the calendar failed */
	previewCalendarFailed: "The calendar could not be read.",
	/** Calendar preview — the day heading for entries without a start */
	previewCalendarUndated: "No date",
	/** Calendar preview — the time column of a whole-day entry */
	previewCalendarAllDay: "All day",
	/** Calendar preview — the viewer's own clock for a time written in another zone; {{time}} is that time */
	previewCalendarYourTime: "{{time}} your time",
	/** Calendar preview — an entry without a title */
	previewCalendarUntitled: "Untitled",
	/** Calendar preview — marks a to-do among events */
	previewCalendarTodo: "To-do",
	/** Calendar preview — detail field: when the entry starts */
	previewCalendarStarts: "Starts",
	/** Calendar preview — detail field: when an event ends */
	previewCalendarEnds: "Ends",
	/** Calendar preview — detail field: when a to-do is due */
	previewCalendarDue: "Due",
	/** Calendar preview — detail field: how long the entry lasts */
	previewCalendarDuration: "Duration",
	/** Calendar preview — detail field: its recurrence in words */
	previewCalendarRepeats: "Repeats",
	/** Calendar preview — detail field: where it takes place */
	previewCalendarLocation: "Location",
	/** Calendar preview — detail field: who organizes it */
	previewCalendarOrganizer: "Organizer",
	/** Calendar preview — detail field: who is invited */
	previewCalendarAttendees: "Attendees",
	/** Calendar preview — detail field: its status (CONFIRMED, TENTATIVE…) */
	previewCalendarStatus: "Status",
	/** Calendar preview — detail field: its web address, shown as text and never opened */
	previewCalendarLink: "Link",
	/** Calendar preview — detail field: its description */
	previewCalendarDescription: "Description",
	/** Calendar preview — detail field: dates the recurrence skips; {{count}} of them */
	previewCalendarExceptions_one: "{{count}} date skipped",
	/** Calendar preview — detail field: dates the recurrence skips; {{count}} of them */
	previewCalendarExceptions_other: "{{count}} dates skipped",
	/** Calendar preview — detail field: dates added beside the recurrence; {{count}} of them */
	previewCalendarExtraDates_one: "{{count}} extra date",
	/** Calendar preview — detail field: dates added beside the recurrence; {{count}} of them */
	previewCalendarExtraDates_other: "{{count}} extra dates",
	/** Calendar preview — a time with the zone it is written in; {{time}} is the time, {{zone}} the zone's name (Europe/Berlin) */
	previewCalendarZone: "{{time}} ({{zone}})",
	/** Calendar preview — a time in a zone that could not be converted; {{time}} is the time as written, {{zone}} the zone's name as the file gives it */
	previewCalendarZoneUnconverted: "{{time}} (time zone: {{zone}}, not converted)",
	/** Calendar preview — under an agenda time, a zone that could not be converted; {{zone}} is the zone's name as the file gives it */
	previewCalendarZoneUnconvertedShort: "time zone: {{zone}} (not converted)",
	/** Calendar preview — a recurrence: every N seconds */
	previewCalendarEverySecond_one: "Every second",
	/** Calendar preview — a recurrence: every N seconds */
	previewCalendarEverySecond_other: "Every {{count}} seconds",
	/** Calendar preview — a recurrence: every N minutes */
	previewCalendarEveryMinute_one: "Every minute",
	/** Calendar preview — a recurrence: every N minutes */
	previewCalendarEveryMinute_other: "Every {{count}} minutes",
	/** Calendar preview — a recurrence: every N hours */
	previewCalendarEveryHour_one: "Every hour",
	/** Calendar preview — a recurrence: every N hours */
	previewCalendarEveryHour_other: "Every {{count}} hours",
	/** Calendar preview — a recurrence: every N days */
	previewCalendarEveryDay_one: "Every day",
	/** Calendar preview — a recurrence: every N days */
	previewCalendarEveryDay_other: "Every {{count}} days",
	/** Calendar preview — a recurrence: every N weeks */
	previewCalendarEveryWeek_one: "Every week",
	/** Calendar preview — a recurrence: every N weeks */
	previewCalendarEveryWeek_other: "Every {{count}} weeks",
	/** Calendar preview — a recurrence: every N months */
	previewCalendarEveryMonth_one: "Every month",
	/** Calendar preview — a recurrence: every N months */
	previewCalendarEveryMonth_other: "Every {{count}} months",
	/** Calendar preview — a recurrence: every N years */
	previewCalendarEveryYear_one: "Every year",
	/** Calendar preview — a recurrence: every N years */
	previewCalendarEveryYear_other: "Every {{count}} years",
	/** Calendar preview — a recurrence's days; {{days}} is a list of weekdays */
	previewCalendarOnDays: "on {{days}}",
	/** Calendar preview — a recurrence's days of the month; {{days}} is a list of numbers */
	previewCalendarOnMonthDays: "on day {{days}}",
	/** Calendar preview — a recurrence's months; {{months}} is a list of month names */
	previewCalendarInMonths: "in {{months}}",
	/** Calendar preview — how many times it repeats */
	previewCalendarTimes_one: "{{count}} time",
	/** Calendar preview — how many times it repeats */
	previewCalendarTimes_other: "{{count}} times",
	/** Calendar preview — the last date it repeats on; {{date}} is formatted */
	previewCalendarUntil: "until {{date}}",
	/** Calendar preview — a weekday with an ordinal: the first */
	previewCalendarNth1: "first {{day}}",
	/** Calendar preview — a weekday with an ordinal: the second */
	previewCalendarNth2: "second {{day}}",
	/** Calendar preview — a weekday with an ordinal: the third */
	previewCalendarNth3: "third {{day}}",
	/** Calendar preview — a weekday with an ordinal: the fourth */
	previewCalendarNth4: "fourth {{day}}",
	/** Calendar preview — a weekday with an ordinal: the last */
	previewCalendarNthLast: "last {{day}}",
	/** Calendar preview — a weekday with any other ordinal; {{n}} is the number (negative counts from the end) */
	previewCalendarNthOther: "{{day}} #{{n}}"
}
