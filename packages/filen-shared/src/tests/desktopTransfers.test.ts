import { describe, expect, expectTypeOf, it } from "vitest"
import type { DesktopSdkWire, DesktopTransferResult, DesktopTransfers } from "@filen/shared/desktop"
import { parseEnvelope, stringifyEnvelope } from "@filen/shared/session"

// A wasm-shaped File as the page holds it (`@filen/sdk-rs` File): bigint size, timestamp and chunks.
const file = {
	uuid: "4f8e2c1a-3b5d-4e6f-8a9b-0c1d2e3f4a5b",
	stableUUID: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
	meta: {
		type: "decoded",
		data: {
			name: "$bigint:1n.txt",
			mime: "text/plain",
			created: 1762819200000n,
			modified: 1762819200000n,
			hash: "ab".repeat(32),
			size: 9007199254740993n,
			key: "key",
			version: 2
		}
	},
	parent: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
	size: 9007199254740993n,
	favorited: false,
	region: "de-1",
	bucket: "filen-1",
	timestamp: 1762819200000n,
	chunks: 9n,
	canMakeThumbnail: false
}

const unavailable = <T>(): Promise<DesktopTransferResult<T>> =>
	Promise.resolve({
		ok: false,
		error: {
			code: "hostUnavailable"
		}
	})

describe("desktop transfers contract", () => {
	it("an envelope round-trips a wasm File with bigint size, timestamp and chunks", () => {
		const wire: DesktopSdkWire = stringifyEnvelope(file)
		const back = parseEnvelope(wire) as typeof file

		expect(back).toEqual(file)
		expect(typeof back.size).toBe("bigint")
		expect(typeof back.timestamp).toBe("bigint")
		expect(typeof back.chunks).toBe("bigint")
		expect(back.meta.data.name).toBe("$bigint:1n.txt")
	})

	it("the stubbed bridge satisfies DesktopTransfers", async () => {
		const stub = {
			download: () => unavailable(),
			upload: () => unavailable(),
			pickUpload: () => unavailable(),
			cancel: () => undefined,
			setPaused: () => undefined,
			onEvents: () => () => undefined,
			reveal: () => unavailable(),
			open: () => unavailable(),
			chooseDownloadDirectory: () =>
				Promise.resolve({
					status: "canceled" as const
				})
		} satisfies DesktopTransfers

		expectTypeOf(stub).toExtend<DesktopTransfers>()
		await expect(stub.reveal()).resolves.toEqual({
			ok: false,
			error: {
				code: "hostUnavailable"
			}
		})
	})
})
