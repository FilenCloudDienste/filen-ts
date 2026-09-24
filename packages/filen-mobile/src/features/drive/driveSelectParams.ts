import type { SelectOptionsParam } from "@/hooks/useDrivePath"
import { serialize } from "@/lib/serializer"

// A picker screen's route param: everything but the session's items and preselection (both read back
// from the session store).
export function serializeSelectOptions(options: SelectOptionsParam): string {
	return serialize({
		type: options.type,
		files: options.files,
		directories: options.directories,
		intention: options.intention,
		previewType: options.previewType,
		id: options.id
	} satisfies SelectOptionsParam)
}
