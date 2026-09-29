import type { Transfer } from "@/features/transfers/store/useTransfersStore"

export function makeTransfer(overrides: Partial<Transfer> = {}): Transfer {
	return {
		id: "transfer-a",
		direction: "upload",
		name: "report.pdf",
		size: 1_000,
		bytesTransferred: 0,
		status: "uploading",
		paused: false,
		parentUuid: null,
		startedAt: 1_700_000_000_000,
		...overrides
	}
}
