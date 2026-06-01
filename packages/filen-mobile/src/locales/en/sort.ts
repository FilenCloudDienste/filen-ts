// Notes list grouping vocabulary (src/lib/sort.ts NotesSorter.group — the section-header
// titles). Shared keys live in common.ts and must not be redefined here.
//
// Month names are NOT translation keys: sort.ts derives them at runtime from
// `Intl.DateTimeFormat(intlLanguage, { month: "long" })`, which is locale-correct for free.
// Only the fixed time-bucket / note-state labels live here.
export const sort = {
	/** Notes group header: notes edited within the last 24 hours */
	today: "Today",
	/** Notes group header: notes edited within the previous 7 days */
	previous_7_days: "Previous 7 days",
	/** Notes group header: notes edited within the previous 30 days */
	previous_30_days: "Previous 30 days",
	/** Notes group header: pinned notes */
	pinned: "Pinned",
	/** Notes group header: favorited notes */
	favorited: "Favorited",
	/** Notes group header: archived notes */
	archived: "Archived",
	/** Notes group header: trashed notes */
	trashed: "Trashed"
} as const
