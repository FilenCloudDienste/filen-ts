import { type DriveItem } from "@/features/drive/lib/item"
import { buildPublicLinkUrl } from "@/features/drive/components/linkDialog.logic"
import { type DriveItemLinkStatus } from "@/features/drive/queries/drive"

// Copy-link's dispatch outcome: "copied" (a link already existed and its URL made it to the
// clipboard), "clipboardError" (a link existed but the write itself failed — `error` is whatever
// `writeClipboard` threw, for the caller's own LABEL-FIRST toast), or "openDialog" (no link yet, or
// its URL can't be built — e.g. an item whose metadata key hasn't decrypted — degrading to the same
// explicit create-a-link flow Public link's own click always opens).
export type CopyLinkOutcome = { action: "copied" } | { action: "clipboardError"; error: unknown } | { action: "openDialog" }

// Pure dispatch for the item menu's Copy-link entry — takes the item's CURRENT link status (the
// caller reads/fetches it from the shared link-status query cache, driveItemLinkStatusQueryKey, before
// calling this) rather than fetching it itself, so the whole matrix is testable without a query client
// or a DOM clipboard: `writeClipboard` is injected, never `navigator.clipboard` directly.
export async function resolveCopyLinkAction(
	item: DriveItem,
	status: DriveItemLinkStatus | null,
	writeClipboard: (text: string) => Promise<void>
): Promise<CopyLinkOutcome> {
	if (status === null) {
		return { action: "openDialog" }
	}

	const url = buildPublicLinkUrl(item, status)

	if (url === null) {
		return { action: "openDialog" }
	}

	try {
		await writeClipboard(url)
		return { action: "copied" }
	} catch (e) {
		return { action: "clipboardError", error: e }
	}
}
