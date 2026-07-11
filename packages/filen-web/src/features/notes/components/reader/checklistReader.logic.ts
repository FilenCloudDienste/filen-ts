import { checklistParser, type Checklist } from "@filen/utils"

// Parse→row model for the read-only checklist render. `checklistParser` (the SAME `@filen/utils`
// singleton mobile and old-web both write through) already tolerates malformed
// HTML by returning []; the empty-string guard just skips invoking the parser for the common case of a
// brand-new checklist note with no items yet.
export function checklistRows(content: string | undefined): Checklist {
	if (content === undefined || content.length === 0) {
		return []
	}

	return checklistParser.parse(content)
}
