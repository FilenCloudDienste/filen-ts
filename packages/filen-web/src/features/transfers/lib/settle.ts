import { toast } from "sonner"
import type { ErrorDTO } from "@/lib/sdk/errors"
import { i18n } from "@/lib/i18n"
import type { TransferRetry, TransfersStore } from "@/features/transfers/store/useTransfersStore"

// A download's outcome. A failure the browser itself was saving (the service-worker path) says so: the
// browser may keep the partial file for its own retry, where the app cannot delete it.
export type DownloadOutcome = { status: "success" } | { status: "error"; dto: ErrorDTO; browserManaged?: true }

// One item's download (a file, an archive entry, or one zip of a selection) failed; `name` is what the start toast named.
export function toastDownloadFailed(name: string, outcome: { browserManaged?: true }): void {
	toast.error(
		i18n.t("transfers:transfersDownloadFailed", { name }),
		outcome.browserManaged === true ? { description: i18n.t("transfers:transfersBrowserKeptPartialHint") } : undefined
	)
}

// Settles a transfer whose op rejected. A Cancelled rejection drops the row (an aborted transfer has
// no history, mobile parity); anything else settles it as an error, keeping `retry` on the row. True when it was a
// cancel, so each runner maps that to its own outcome.
export function settleTransferFailure(
	store: Pick<TransfersStore, "settle" | "remove"> & Partial<Pick<TransfersStore, "setRetry">>,
	id: string,
	dto: ErrorDTO,
	retry?: TransferRetry
): boolean {
	if (dto.kind === "Cancelled") {
		store.settle(id, "cancelled")
		store.remove(id)

		return true
	}

	store.settle(id, "error", dto)

	if (retry !== undefined) {
		store.setRetry?.(id, retry)
	}

	return false
}
