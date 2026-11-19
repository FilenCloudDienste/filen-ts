import { toast } from "sonner"
import { resolveCopyLinkAction } from "@/features/drive/components/itemMenu.logic"
import { buildPublicLinkUrl } from "@/features/drive/components/linkDialog.logic"
import { driveItemLinkStatusQueryKey, fetchDriveItemLinkStatus, type DriveItemLinkStatus } from "@/features/drive/queries/drive"
import { type DriveItem } from "@/features/drive/lib/item"
import { queryClient } from "@/queries/client"
import { copyTextLater } from "@/lib/copyText"
import { errorLabel } from "@/lib/i18n/errorLabel"

// Copy link, as the item menu entry and drive.copyLink run it: the existing public link's URL straight to the
// clipboard, or `openLinkDialog` when there is no link yet (or its URL can't be built). The link dialog's own cache
// entry (same query key, never stale) is reused rather than always re-fetching. A free-tier account can never have an
// existing link (public links are premium-only), so it degrades to the dialog, where the subscription gate lives (see
// linkDialog.tsx).
export async function copyItemLink(item: DriveItem, copiedMessage: string, openLinkDialog: () => void): Promise<void> {
	const queryKey = driveItemLinkStatusQueryKey(item.data.uuid)
	const cached = queryClient.getQueryData<DriveItemLinkStatus | null>(queryKey)

	if (cached === undefined) {
		// The status comes from the worker, after the click's activation has ended in Safari: the write starts now, on a
		// promise of the URL. A failed status read says its error's label (copyTextLater), never an unhandled rejection.
		const url = queryClient
			.query({ queryKey, queryFn: () => fetchDriveItemLinkStatus(item), staleTime: "static" })
			.then(status => (status === null ? null : buildPublicLinkUrl(item, status)))

		await copyTextLater(url, { copied: copiedMessage, failed: openLinkDialog })

		return
	}

	const outcome = await resolveCopyLinkAction(item, cached, url => navigator.clipboard.writeText(url))

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
