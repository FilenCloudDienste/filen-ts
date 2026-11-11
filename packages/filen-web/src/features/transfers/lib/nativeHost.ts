import { toast } from "sonner"
import type { DesktopTransferError } from "@filen/shared/desktop"
import { driveItemName } from "@filen/shared"
import { desktopBridge } from "@/lib/desktop"
import { errorLabel } from "@/lib/i18n/errorLabel"
import type { DriveItem } from "@/features/drive/lib/item"
import { toastTransferStarted } from "@/features/transfers/lib/transferStartToast"
import { downloadItemOf, errorDtoOf } from "@/features/transfers/lib/nativeTransfers.logic"

// Whether the desktop app's native host takes the page's transfers, and its downloads. Kept apart from the feed
// (nativeTransfers.ts), which the download paths need none of. What stays on the page's own download path: public-link
// downloads, archive entries, Download as, and a lone file the preview holds whole (download.ts).

let feedRunning = false

// On desktop, once the signed-in shell started the feed.
export function nativeTransfersAvailable(): boolean {
	return feedRunning
}

export function nativeFeedChanged(running: boolean): void {
	feedRunning = running
}

export function toastNativeFailure(error: DesktopTransferError): void {
	toast.error(errorLabel(errorDtoOf(error)))
}

// `ask`: always main's directory picker ("Download to…").
export async function startNativeDownloads(items: DriveItem[], options?: { ask?: boolean }): Promise<void> {
	const bridge = desktopBridge()
	const [first] = items

	if (bridge === undefined || first === undefined) {
		return
	}

	try {
		const result = await bridge.transfers.download(items.map(downloadItemOf), options)

		if (!result.ok) {
			toastNativeFailure(result.error)
		} else if (result.value.status === "started" && result.value.ids.length > 0) {
			toastTransferStarted({ direction: "download", name: driveItemName(first), count: items.length, noun: "items" })
		}
	} catch (e) {
		toast.error(errorLabel(e))
	}
}
