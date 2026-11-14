// Actions whose id changed, old id to new. A combo stored under an old id moves to the new one when the record loads
// (registry.ts migrateOverrides), and the next write stores it there; one already stored under the new id wins, then
// the first old id listed.
export const RENAMED_ACTIONS: readonly (readonly [from: string, to: string])[] = [
	// One print action for the spreadsheet, the presentation and the PDF viewer.
	["sheet.print", "office.print"],
	["presentation.print", "office.print"]
]
