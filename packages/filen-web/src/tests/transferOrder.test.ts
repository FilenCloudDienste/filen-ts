import { describe, expect, it } from "vitest"
import type { DesktopTransfer } from "@filen/shared/desktop"
import type { Transfer } from "@/features/transfers/store/useTransfersStore"
import {
	externalTransferGroupOf,
	groupEnd,
	groupRows,
	TRANSFER_GROUP,
	transferGroupOf,
	type TransferGroup
} from "@/features/transfers/lib/order"
import type { ExternalTransferRow } from "@/features/transfers/lib/externalTransfers.logic"
import { rowOf } from "@/features/transfers/lib/nativeTransfers.logic"

function transfer(overrides: Partial<Transfer> = {}): Transfer {
	return {
		id: "t1",
		direction: "upload",
		name: "file.txt",
		size: 100,
		bytesTransferred: 0,
		status: "uploading",
		paused: false,
		parentUuid: null,
		startedAt: 0,
		...overrides
	}
}

describe("transferGroupOf", () => {
	it.each([
		["uploading", TRANSFER_GROUP.active],
		["downloading", TRANSFER_GROUP.active],
		["copying", TRANSFER_GROUP.active],
		["compressing", TRANSFER_GROUP.active],
		["extracting", TRANSFER_GROUP.active],
		["error", TRANSFER_GROUP.failed],
		["completedWithErrors", TRANSFER_GROUP.failed],
		["done", TRANSFER_GROUP.done],
		["cancelled", TRANSFER_GROUP.cancelled]
	] as const)("%s → %i", (status, group) => {
		expect(transferGroupOf(transfer({ status }), false)).toBe(group)
	})

	it("an active row waiting for the archive slot, or told it is queued, is queued", () => {
		expect(transferGroupOf(transfer({ status: "downloading", waitingForSlot: true }), false)).toBe(TRANSFER_GROUP.queued)
		expect(transferGroupOf(transfer({ status: "compressing" }), true)).toBe(TRANSFER_GROUP.queued)
	})

	it("a paused row is paused, whatever it waits for", () => {
		expect(transferGroupOf(transfer({ paused: true }), false)).toBe(TRANSFER_GROUP.paused)
		expect(transferGroupOf(transfer({ paused: true, waitingForSlot: true }), true)).toBe(TRANSFER_GROUP.paused)
	})

	it("a finished row ignores the queued flag and a stale paused one", () => {
		expect(transferGroupOf(transfer({ status: "done", paused: true }), true)).toBe(TRANSFER_GROUP.done)
		expect(transferGroupOf(transfer({ status: "error" }), true)).toBe(TRANSFER_GROUP.failed)
	})

	it("maps the desktop app's native host rows like the page's own", () => {
		const native: DesktopTransfer = {
			id: "n1",
			direction: "download",
			kind: "file",
			origin: "page",
			group: "g1",
			name: "a.bin",
			parentUuid: null,
			size: 10,
			bytes: 3,
			files: null,
			paused: false,
			startedAt: 1,
			revealable: false
		}
		const row: Transfer = { ...rowOf(native, undefined), paused: false }

		expect(transferGroupOf(row, false)).toBe(TRANSFER_GROUP.active)
		expect(transferGroupOf({ ...row, paused: true }, false)).toBe(TRANSFER_GROUP.paused)
		expect(transferGroupOf({ ...row, status: "error" }, false)).toBe(TRANSFER_GROUP.failed)
		expect(transferGroupOf({ ...row, status: "done" }, false)).toBe(TRANSFER_GROUP.done)
	})
})

describe("externalTransferGroupOf", () => {
	it("a sync or mounts transfer is active, the cache's queued uploads queued", () => {
		const moving: ExternalTransferRow = {
			kind: "transfer",
			id: "sync:p:upload:a.txt",
			path: "a.txt",
			direction: "upload",
			bytes: 1,
			total: 2,
			speed: null,
			source: { kind: "sync", pairId: "p", name: "Pair" }
		}
		const queued: ExternalTransferRow = { kind: "queued", id: "mounts:queued", count: 3, source: { kind: "mounts", role: "drive" } }

		expect(externalTransferGroupOf(moving)).toBe(TRANSFER_GROUP.active)
		expect(externalTransferGroupOf({ ...moving, source: { kind: "mounts", role: null } })).toBe(TRANSFER_GROUP.active)
		expect(externalTransferGroupOf(queued)).toBe(TRANSFER_GROUP.queued)
	})
})

describe("groupRows", () => {
	const groupOf = (row: { id: string; group: TransferGroup }): TransferGroup => row.group

	it("puts rows in group order, each group in its sources' order", () => {
		const own = [
			{ id: "done1", group: TRANSFER_GROUP.done },
			{ id: "active1", group: TRANSFER_GROUP.active },
			{ id: "failed1", group: TRANSFER_GROUP.failed },
			{ id: "paused1", group: TRANSFER_GROUP.paused },
			{ id: "active2", group: TRANSFER_GROUP.active },
			{ id: "queued1", group: TRANSFER_GROUP.queued },
			{ id: "done2", group: TRANSFER_GROUP.done }
		]
		const external = [
			{ id: "ext-active", group: TRANSFER_GROUP.active },
			{ id: "ext-queued", group: TRANSFER_GROUP.queued }
		]
		const grouped = groupRows([own, external], groupOf)

		expect(grouped.rows.map(row => row.id)).toEqual([
			"active1",
			"active2",
			"ext-active",
			"queued1",
			"ext-queued",
			"paused1",
			"failed1",
			"done1",
			"done2"
		])
		expect(groupEnd(grouped, TRANSFER_GROUP.active)).toBe(3)
		expect(groupEnd(grouped, TRANSFER_GROUP.paused)).toBe(6)
		expect(groupEnd(grouped, TRANSFER_GROUP.cancelled)).toBe(9)
	})

	it("is stable: rows that keep their group keep their order however often it runs", () => {
		const rows = Array.from({ length: 50 }, (_, index) => ({ id: `r${String(index)}`, group: TRANSFER_GROUP.active }))
		const first = groupRows([rows], groupOf).rows.map(row => row.id)

		expect(first).toEqual(rows.map(row => row.id))
		expect(groupRows([rows], groupOf).rows.map(row => row.id)).toEqual(first)
	})

	it("a group change moves only that row", () => {
		const rows: { id: string; group: TransferGroup }[] = ["a", "b", "c", "d"].map(id => ({ id, group: TRANSFER_GROUP.active }))
		const before = groupRows([rows], groupOf).rows.map(row => row.id)
		const changed = rows.map(row => (row.id === "b" ? { ...row, group: TRANSFER_GROUP.done } : row))
		const after = groupRows([changed], groupOf).rows.map(row => row.id)

		expect(before).toEqual(["a", "b", "c", "d"])
		expect(after).toEqual(["a", "c", "d", "b"])
	})

	it("handles no rows", () => {
		expect(groupRows([[], []], groupOf)).toEqual({ rows: [], ends: [0, 0, 0, 0, 0, 0] })
	})
})
