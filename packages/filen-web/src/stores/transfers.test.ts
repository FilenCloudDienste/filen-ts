import { beforeEach, describe, expect, it } from "vitest"
import type { ErrorDTO } from "@/lib/sdk/errors"
import { computeTransfersAggregate, useTransfersStore, type Transfer } from "@/stores/transfers"

function makeTransfer(overrides: Partial<Transfer> = {}): Transfer {
	return {
		id: "transfer-a",
		direction: "upload",
		name: "report.pdf",
		size: 1_000,
		bytesTransferred: 0,
		status: "uploading",
		parentUuid: null,
		startedAt: 1_700_000_000_000,
		...overrides
	}
}

function sdkDto(kind: string): ErrorDTO {
	return { species: "sdk", kind, message: `${kind} message`, label: `${kind} label` }
}

beforeEach(() => {
	useTransfersStore.setState({ transfers: [] })
})

describe("add", () => {
	it("appends a new transfer, present and uploading", () => {
		const transfer = makeTransfer()

		useTransfersStore.getState().add(transfer)

		expect(useTransfersStore.getState().transfers).toEqual([transfer])
	})

	it("appends without disturbing an already-present transfer", () => {
		const first = makeTransfer({ id: "a" })
		const second = makeTransfer({ id: "b" })

		useTransfersStore.getState().add(first)
		useTransfersStore.getState().add(second)

		expect(useTransfersStore.getState().transfers).toEqual([first, second])
	})

	it("does not mutate the previous array (returns a new reference)", () => {
		const prev = useTransfersStore.getState().transfers

		useTransfersStore.getState().add(makeTransfer())

		expect(useTransfersStore.getState().transfers).not.toBe(prev)
	})
})

describe("setProgress", () => {
	it("updates bytesTransferred for the matching id", () => {
		useTransfersStore.getState().add(makeTransfer({ id: "a" }))

		useTransfersStore.getState().setProgress("a", 500)

		expect(useTransfersStore.getState().transfers[0]?.bytesTransferred).toBe(500)
	})

	it("leaves other transfers untouched", () => {
		useTransfersStore.getState().add(makeTransfer({ id: "a" }))
		useTransfersStore.getState().add(makeTransfer({ id: "b", bytesTransferred: 10 }))

		useTransfersStore.getState().setProgress("a", 500)

		expect(useTransfersStore.getState().transfers.find(transfer => transfer.id === "b")?.bytesTransferred).toBe(10)
	})

	it("is a no-op for an unknown id", () => {
		useTransfersStore.getState().add(makeTransfer({ id: "a" }))

		useTransfersStore.getState().setProgress("missing", 999)

		expect(useTransfersStore.getState().transfers[0]?.bytesTransferred).toBe(0)
	})
})

describe("settle", () => {
	it("marks a transfer done, with no error field set", () => {
		useTransfersStore.getState().add(makeTransfer({ id: "a" }))

		useTransfersStore.getState().settle("a", "done")

		const transfer = useTransfersStore.getState().transfers[0]
		expect(transfer?.status).toBe("done")
		expect(transfer?.error).toBeUndefined()
	})

	it("marks a transfer errored, carrying the dto", () => {
		const dto = sdkDto("UploadFailed")
		useTransfersStore.getState().add(makeTransfer({ id: "a" }))

		useTransfersStore.getState().settle("a", "error", dto)

		const transfer = useTransfersStore.getState().transfers[0]
		expect(transfer?.status).toBe("error")
		expect(transfer?.error).toEqual(dto)
	})

	it("only settles the matching id", () => {
		useTransfersStore.getState().add(makeTransfer({ id: "a" }))
		useTransfersStore.getState().add(makeTransfer({ id: "b" }))

		useTransfersStore.getState().settle("a", "done")

		expect(useTransfersStore.getState().transfers.find(transfer => transfer.id === "b")?.status).toBe("uploading")
	})
})

describe("remove", () => {
	it("removes only the matching id", () => {
		useTransfersStore.getState().add(makeTransfer({ id: "a" }))
		useTransfersStore.getState().add(makeTransfer({ id: "b" }))

		useTransfersStore.getState().remove("a")

		expect(useTransfersStore.getState().transfers.map(transfer => transfer.id)).toEqual(["b"])
	})
})

describe("clearFinished", () => {
	it("drops done/error transfers, keeps uploading ones", () => {
		useTransfersStore.getState().add(makeTransfer({ id: "a", status: "uploading" }))
		useTransfersStore.getState().add(makeTransfer({ id: "b", status: "done" }))
		useTransfersStore.getState().add(makeTransfer({ id: "c", status: "error", error: sdkDto("Boom") }))

		useTransfersStore.getState().clearFinished()

		expect(useTransfersStore.getState().transfers.map(transfer => transfer.id)).toEqual(["a"])
	})

	it("is a no-op when every transfer is still uploading", () => {
		useTransfersStore.getState().add(makeTransfer({ id: "a" }))
		useTransfersStore.getState().add(makeTransfer({ id: "b" }))

		useTransfersStore.getState().clearFinished()

		expect(useTransfersStore.getState().transfers.map(transfer => transfer.id)).toEqual(["a", "b"])
	})
})

describe("computeTransfersAggregate", () => {
	it("returns zero when there are no transfers", () => {
		expect(computeTransfersAggregate([])).toEqual({ activeCount: 0, percent: 0 })
	})

	it("counts only uploading transfers, ignoring done/error", () => {
		const transfers = [
			makeTransfer({ id: "a", status: "uploading", size: 100, bytesTransferred: 50 }),
			makeTransfer({ id: "b", status: "done", size: 100, bytesTransferred: 100 }),
			makeTransfer({ id: "c", status: "error", size: 100, bytesTransferred: 20 })
		]

		expect(computeTransfersAggregate(transfers)).toEqual({ activeCount: 1, percent: 0.5 })
	})

	it("sums bytesTransferred/size across every active transfer", () => {
		const transfers = [
			makeTransfer({ id: "a", status: "uploading", size: 100, bytesTransferred: 50 }),
			makeTransfer({ id: "b", status: "uploading", size: 300, bytesTransferred: 50 })
		]

		// 100 transferred / 400 total
		expect(computeTransfersAggregate(transfers)).toEqual({ activeCount: 2, percent: 0.25 })
	})

	it("is 0 percent (not NaN) when every active transfer has zero size", () => {
		const transfers = [makeTransfer({ id: "a", status: "uploading", size: 0, bytesTransferred: 0 })]

		expect(computeTransfersAggregate(transfers)).toEqual({ activeCount: 1, percent: 0 })
	})
})
