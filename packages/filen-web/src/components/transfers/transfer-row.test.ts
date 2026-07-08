import { describe, expect, it } from "vitest"
import { type Transfer } from "@/stores/transfers"
import { transferProgress } from "@/components/transfers/transfer-row.logic"

function transfer(overrides: Partial<Transfer> = {}): Transfer {
	return {
		id: "t1",
		direction: "upload",
		name: "file.txt",
		size: 100,
		bytesTransferred: 0,
		status: "uploading",
		parentUuid: null,
		startedAt: 0,
		...overrides
	}
}

describe("transferProgress", () => {
	it("uploading: scales bytesTransferred/size to 0-100", () => {
		expect(transferProgress(transfer({ status: "uploading", bytesTransferred: 25, size: 100 }))).toBe(25)
	})

	it("uploading: zero size never divides by zero — reads 0", () => {
		expect(transferProgress(transfer({ status: "uploading", bytesTransferred: 0, size: 0 }))).toBe(0)
	})

	it("uploading: clamps above 100 in case bytesTransferred ever overshoots size", () => {
		expect(transferProgress(transfer({ status: "uploading", bytesTransferred: 150, size: 100 }))).toBe(100)
	})

	it("done: always 100, even when bytesTransferred trails size (settle/setProgress race)", () => {
		expect(transferProgress(transfer({ status: "done", bytesTransferred: 40, size: 100 }))).toBe(100)
	})

	it("done: still 100 for a zero-byte file", () => {
		expect(transferProgress(transfer({ status: "done", bytesTransferred: 0, size: 0 }))).toBe(100)
	})

	it("error: reads the last-known ratio, same formula as uploading — no reset to 0", () => {
		expect(transferProgress(transfer({ status: "error", bytesTransferred: 60, size: 100 }))).toBe(60)
	})

	it("error: zero size never divides by zero — reads 0", () => {
		expect(transferProgress(transfer({ status: "error", bytesTransferred: 0, size: 0 }))).toBe(0)
	})
})
