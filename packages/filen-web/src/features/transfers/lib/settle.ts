import { toast } from "sonner"
import type { ErrorDTO } from "@/lib/sdk/errors"
import { i18n } from "@/lib/i18n"
import type { TransfersStore } from "@/features/transfers/store/useTransfersStore"

// A download's outcome. A failure the browser itself was saving (the service-worker path) says so: the
// browser may keep the partial file for its own retry, where the app cannot delete it.
export type DownloadOutcome = { status: "success" } | { status: "error"; dto: ErrorDTO; browserManaged?: true }

export function toastDownloadFailed(outcome: { browserManaged?: true }): void {
	toast.error(
		i18n.t("transfers:transfersDownloadSummaryCompleteWithFailures", { count: 0, failed: 1 }),
		outcome.browserManaged === true ? { description: i18n.t("transfers:transfersBrowserKeptPartialHint") } : undefined
	)
}

// Settles a transfer whose op rejected. A Cancelled rejection drops the row (an aborted transfer has
// no history, mobile parity); anything else settles it as an error. True when it was a cancel, so each
// runner maps that to its own outcome.
export function settleTransferFailure(store: Pick<TransfersStore, "settle" | "remove">, id: string, dto: ErrorDTO): boolean {
	if (dto.kind === "Cancelled") {
		store.settle(id, "cancelled")
		store.remove(id)

		return true
	}

	store.settle(id, "error", dto)

	return false
}
