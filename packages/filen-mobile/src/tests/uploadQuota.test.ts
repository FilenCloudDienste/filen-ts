import { vi, describe, it, expect, beforeEach } from "vitest"

const { deps } = vi.hoisted(() => ({
	deps: {
		cached: vi.fn(),
		fetchFresh: vi.fn(),
		isCachedFresh: vi.fn()
	}
}))

vi.mock("@/queries/useAccount.query", () => ({ accountQuotaDeps: deps }))

vi.mock("@/lib/i18n", () => ({
	default: { t: (key: string, params?: Record<string, unknown>) => `${key}:${JSON.stringify(params)}` }
}))

vi.mock("@filen/shared", async () => ({
	...(await import("@/tests/mocks/filenShared")),
	formatBytes: (bytes: number) => `${bytes}B`
}))

import { uploadQuotaRefusal, notEnoughStorageMessage } from "@/features/transfers/quota"

beforeEach(() => {
	deps.cached.mockReset().mockReturnValue({ storageUsed: 900n, maxStorage: 1000n })
	deps.fetchFresh.mockReset().mockResolvedValue({ storageUsed: 900n, maxStorage: 1000n })
	deps.isCachedFresh.mockReset().mockReturnValue(true)
})

describe("uploadQuotaRefusal", () => {
	it("a fresh cached figure that fits answers without a request", async () => {
		expect(await uploadQuotaRefusal([40, 60])).toBeNull()
		expect(deps.fetchFresh).not.toHaveBeenCalled()
	})

	it("a stale cached figure is read once", async () => {
		deps.isCachedFresh.mockReturnValue(false)

		expect(await uploadQuotaRefusal([50])).toBeNull()
		expect(deps.fetchFresh).toHaveBeenCalledOnce()
	})

	it("a cached refusal is re-read once, and a fresh refusal names what's needed and what's free", async () => {
		expect(await uploadQuotaRefusal([150])).toBe('not_enough_storage:{"needed":"150B","free":"100B"}')
		expect(deps.fetchFresh).toHaveBeenCalledOnce()
	})

	it("a delete made elsewhere that frees room lets it through", async () => {
		deps.fetchFresh.mockResolvedValue({ storageUsed: 0n, maxStorage: 1000n })

		expect(await uploadQuotaRefusal([150])).toBeNull()
	})

	it("an unknown quota never blocks (the server decides)", async () => {
		deps.cached.mockReturnValue({ storageUsed: 0n, maxStorage: 0n })
		deps.fetchFresh.mockRejectedValue(new Error("offline"))

		expect(await uploadQuotaRefusal([10 ** 12])).toBeNull()
	})

	it("sizes a file can't report count as nothing; an empty batch asks nothing", async () => {
		expect(await uploadQuotaRefusal([null, undefined, 0])).toBeNull()
		expect(deps.cached).not.toHaveBeenCalled()
	})
})

describe("notEnoughStorageMessage", () => {
	it("formats both sizes", () => {
		expect(notEnoughStorageMessage(2048n, 1024)).toBe('not_enough_storage:{"needed":"2048B","free":"1024B"}')
	})
})
