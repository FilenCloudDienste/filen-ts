import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Remote } from "comlink"
import type { Contact, Dir, StringifiedClient } from "@filen/sdk-rs"
import type { SdkWorkerApi } from "@/workers/sdk.worker"

// Linking or sharing a directory reports the listing's bytes, then the items done: both throttled worker-side,
// so a tree of thousands of items does not cross the boundary per item, and the last of each always delivered
// before the op returns.
type Bytes = (downloadedBytes: number, totalBytes: number | undefined) => void
type Items = (done: number, total: number) => void

const { exposed, fakeClient } = vi.hoisted(() => ({
	exposed: new Map<"api", unknown>(),
	fakeClient: {
		publicLinkDir: vi.fn<(dir: unknown, callback: Bytes, itemsCallback: Items) => Promise<unknown>>(),
		shareDir: vi.fn<(dir: unknown, contact: unknown, callback: Bytes, itemsCallback: Items) => Promise<void>>(),
		free: vi.fn()
	}
}))

vi.mock("@filen/sdk-rs", () => ({
	default: vi.fn(),
	initThreadPool: vi.fn(),
	UnauthClient: { from_config: () => ({ free: vi.fn(), fromStringified: () => fakeClient }) }
}))

vi.mock("comlink", () => ({
	expose: (api: unknown) => {
		exposed.set("api", api)
	},
	proxy: (value: unknown) => value,
	transfer: (value: unknown) => value
}))

await import("@/workers/sdk.worker")

const api = exposed.get("api") as Remote<SdkWorkerApi>
const DIR = {} as Dir
const CONTACT = {} as Contact
const TOTAL = 5000

// A burst the way the SDK sends it: listing bytes, then (0, total) and one report per item.
function burst(bytes: Bytes, items: Items): void {
	bytes(0, undefined)
	bytes(512, 1024)
	bytes(1024, 1024)

	for (let done = 0; done <= TOTAL; done++) {
		items(done, TOTAL)
	}
}

beforeEach(async () => {
	vi.clearAllMocks()
	await api.injectClient("session" as unknown as StringifiedClient)
})

describe("sdk worker directory item progress", () => {
	it("throttles a link's item reports and delivers the final one before returning", async () => {
		const link = { uuid: "link" }
		const onBytes = vi.fn<Bytes>()
		const onItems = vi.fn<Items>()

		fakeClient.publicLinkDir.mockImplementation((_dir, callback, itemsCallback) => {
			burst(callback, itemsCallback)

			return Promise.resolve(link)
		})

		await expect(api.createDirectoryLink(DIR, onBytes, onItems)).resolves.toBe(link)

		expect(onItems.mock.calls).toEqual([
			[0, TOTAL],
			[TOTAL, TOTAL]
		])
		expect(onBytes.mock.calls).toEqual([
			[0, undefined],
			[1024, 1024]
		])
	})

	it("throttles a share's item reports and delivers the final one before returning", async () => {
		const onBytes = vi.fn<Bytes>()
		const onItems = vi.fn<Items>()

		fakeClient.shareDir.mockImplementation((_dir, _contact, callback, itemsCallback) => {
			burst(callback, itemsCallback)

			return Promise.resolve()
		})

		await api.shareDirectory(DIR, CONTACT, onBytes, onItems)

		expect(fakeClient.shareDir).toHaveBeenCalledWith(DIR, CONTACT, expect.any(Function), expect.any(Function))
		expect(onItems.mock.calls).toEqual([
			[0, TOTAL],
			[TOTAL, TOTAL]
		])
	})

	it("delivers the last item report before a failed link rejects", async () => {
		const onItems = vi.fn<Items>()

		fakeClient.publicLinkDir.mockImplementation((_dir, _callback, itemsCallback) => {
			itemsCallback(0, 3)
			itemsCallback(1, 3)
			itemsCallback(2, 3)

			return Promise.reject(new Error("refused"))
		})

		await expect(api.createDirectoryLink(DIR, vi.fn(), onItems)).rejects.toThrow("refused")

		expect(onItems.mock.calls).toEqual([
			[0, 3],
			[2, 3]
		])
	})
})
