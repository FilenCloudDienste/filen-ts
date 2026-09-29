import type { ErrorDTO } from "@/lib/sdk/errors"
import type { TransfersStore } from "@/features/transfers/store/useTransfersStore"

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
