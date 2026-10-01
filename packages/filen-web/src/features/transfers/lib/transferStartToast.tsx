import { Link } from "@tanstack/react-router"
import { toast } from "sonner"
import { i18n } from "@/lib/i18n"

export interface TransferStart {
	direction: "upload" | "download"
	// The one file or directory, named when it is the only item.
	name: string
	count: number
	// What `count` counts: a pick of files says files, anything mixing directories items.
	noun: "files" | "items"
}

function startedMessage({ direction, name, count, noun }: TransferStart): string {
	if (count === 1) {
		return direction === "upload"
			? i18n.t("transfers:transfersUploadStarted", { name })
			: i18n.t("transfers:transfersDownloadStarted", { name })
	}

	if (direction === "download") {
		return i18n.t("transfers:transfersDownloadStartedItems", { count })
	}

	return noun === "files"
		? i18n.t("transfers:transfersUploadStartedFiles", { count })
		: i18n.t("transfers:transfersUploadStartedItems", { count })
}

// Said once a transfer has really begun (a download has a place to save to and its row, an upload passed
// its quota check), never for a cancelled picker. `replaceId` turns a toast already showing for the same
// work (the directory scan) into this one in place. The action is a real link (the Toaster renders inside
// the router), styled as sonner's own action button by its data attributes.
export function toastTransferStarted(start: TransferStart, replaceId?: string | number): void {
	const id = toast(startedMessage(start), {
		...(replaceId !== undefined ? { id: replaceId } : {}),
		action: (
			<Link
				to="/transfers"
				data-button=""
				data-action=""
				onClick={() => {
					toast.dismiss(id)
				}}
			>
				{i18n.t("transfers:transfersStartedView")}
			</Link>
		)
	})
}
