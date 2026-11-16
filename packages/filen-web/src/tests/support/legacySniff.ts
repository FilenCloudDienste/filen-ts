import type { FileVerdict } from "@filen/shared"
import type { DriveItem } from "@/features/drive/lib/item"
import { itemFileKind } from "@/features/drive/lib/preview.logic"

// The `.ts`/`.mts` and `.dot`/`.pot` checks the content-sniff gate replaced, kept as the reference it is held to.

export function legacyUnprobedTransportStream(item: DriveItem, verdict?: FileVerdict | null): boolean {
	const kind = itemFileKind(item, verdict)

	return kind !== null && kind.sniffable && (kind.extension === "ts" || kind.extension === "mts")
}

export function legacyUnsniffedTemplate(item: DriveItem, verdict?: FileVerdict | null): boolean {
	const kind = itemFileKind(item, verdict)

	return kind !== null && kind.sniffable && (kind.extension === "dot" || kind.extension === "pot")
}
