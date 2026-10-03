import { showJobToast } from "@/features/transfers/lib/jobToast"
import { startCopy, startLinkedCopy } from "@/features/drive/lib/copy"
import { type CopyDestination, type CopyJobGlyph } from "@/features/drive/lib/copy.logic"
import { type DriveItem } from "@/features/drive/lib/item"
import type { AnyItemWithContext } from "@filen/sdk-rs"

// Every copy the user starts shows its card, before the job can settle, so even a quick copy ends on it.
export function startCopyWithCard(items: DriveItem[], destination: CopyDestination): string | null {
	const id = startCopy(items, destination)

	if (id !== null) {
		showJobToast(id)
	}

	return id
}

export function startLinkedCopyWithCard(item: AnyItemWithContext, name: string, glyph: CopyJobGlyph, destination: CopyDestination): string {
	const id = startLinkedCopy(item, name, glyph, destination)

	showJobToast(id)

	return id
}
