import { toast } from "sonner"
import { resolveCopyLinkAction } from "@/features/drive/components/itemMenu.logic"
import { driveItemLinkStatusQueryKey, fetchDriveItemLinkStatus, type DriveItemLinkStatus } from "@/features/drive/queries/drive"
import { type DriveItem } from "@/features/drive/lib/item"
import { queryClient } from "@/queries/client"
import { errorLabel } from "@/lib/i18n/errorLabel"

// Copy link, as the item menu entry and drive.copyLink run it: the existing public link's URL straight to the
// clipboard, or `openLinkDialog` when there is no link yet (or its URL can't be built). `staleTime: "static"` reuses
// the link dialog's own cache entry (same query key) rather than always re-fetching. A free-tier account can never
// have an existing link (public links are premium-only), so it degrades to the dialog, where the subscription gate
// lives (see linkDialog.tsx).
export async function copyItemLink(item: DriveItem, copiedMessage: string, openLinkDialog: () => void): Promise<void> {
	let status: DriveItemLinkStatus | null

	// `query` rethrows the fetch's error, which a fire-and-forget caller would otherwise leave as a silent unhandled
	// rejection.
	try {
		status = await queryClient.query({
			queryKey: driveItemLinkStatusQueryKey(item.data.uuid),
			queryFn: () => fetchDriveItemLinkStatus(item),
			staleTime: "static"
		})
	} catch (e) {
		toast.error(errorLabel(e))
		return
	}

	const outcome = await resolveCopyLinkAction(item, status, url => navigator.clipboard.writeText(url))

	if (outcome.action === "copied") {
		toast.success(copiedMessage)
		return
	}

	if (outcome.action === "clipboardError") {
		toast.error(errorLabel(outcome.error))
		return
	}

	openLinkDialog()
}
