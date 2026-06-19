import { vi, describe, it, expect, beforeEach } from "vitest"

const { mockShareAsync } = vi.hoisted(() => ({
	mockShareAsync: vi.fn()
}))

vi.mock("expo-sharing", () => ({ shareAsync: mockShareAsync }))

// Mirror @filen/utils `run`: execute fn with a defer collector, then run the deferred
// callbacks (in reverse) on both success and failure, returning a Result.
vi.mock("@filen/utils", () => ({
	run: async (fn: (defer: (d: () => void) => void) => Promise<unknown>) => {
		const deferred: Array<() => void> = []
		const defer = (d: () => void) => {
			deferred.push(d)
		}

		try {
			const data = await fn(defer)

			for (const d of deferred.reverse()) {
				d()
			}

			return { success: true, data, error: null }
		} catch (error) {
			for (const d of deferred.reverse()) {
				d()
			}

			return { success: false, data: null, error }
		}
	}
}))

import { Platform, Share } from "react-native"
import { shareTmpFile, shareUrl } from "@/lib/share"

describe("shareTmpFile", () => {
	beforeEach(() => {
		mockShareAsync.mockReset().mockResolvedValue(undefined)
	})

	it("shares the uri with dialogTitle=name and default text/plain mime", async () => {
		const cleanup = vi.fn()
		const result = await shareTmpFile({ uri: "file:///tmp/a.txt", name: "a.txt", cleanup })

		expect(result.success).toBe(true)
		expect(mockShareAsync).toHaveBeenCalledTimes(1)
		expect(mockShareAsync).toHaveBeenCalledWith("file:///tmp/a.txt", {
			mimeType: "text/plain",
			dialogTitle: "a.txt"
		})
	})

	it("uses the provided mimeType when given", async () => {
		const cleanup = vi.fn()

		await shareTmpFile({ uri: "file:///tmp/x.pdf", name: "x.pdf", mimeType: "application/pdf", cleanup })

		expect(mockShareAsync).toHaveBeenCalledWith("file:///tmp/x.pdf", {
			mimeType: "application/pdf",
			dialogTitle: "x.pdf"
		})
	})

	it("runs cleanup after a successful share", async () => {
		const cleanup = vi.fn()

		await shareTmpFile({ uri: "file:///tmp/a.txt", name: "a.txt", cleanup })

		expect(cleanup).toHaveBeenCalledTimes(1)
	})

	it("runs cleanup and returns failure when sharing throws", async () => {
		const cleanup = vi.fn()
		mockShareAsync.mockRejectedValue(new Error("share boom"))

		const result = await shareTmpFile({ uri: "file:///tmp/a.txt", name: "a.txt", cleanup })

		expect(result.success).toBe(false)
		expect(cleanup).toHaveBeenCalledTimes(1)
	})
})

describe("shareUrl", () => {
	const URL = "https://drive.filen.io/d/abc#key"

	beforeEach(() => {
		mockShareAsync.mockReset()
		vi.mocked(Share.share).mockReset().mockResolvedValue({ action: "sharedAction" })
		Platform.OS = "ios"
	})

	it("shares via the iOS `url` field on iOS", async () => {
		Platform.OS = "ios"

		await shareUrl(URL)

		expect(Share.share).toHaveBeenCalledTimes(1)
		expect(Share.share).toHaveBeenCalledWith({ url: URL })
	})

	it("shares via the `message` field on Android (Android ignores the url field)", async () => {
		Platform.OS = "android"

		await shareUrl(URL)

		expect(Share.share).toHaveBeenCalledTimes(1)
		expect(Share.share).toHaveBeenCalledWith({ message: URL })
	})

	it("never routes a url through expo-sharing (file-only on Android)", async () => {
		Platform.OS = "android"

		await shareUrl(URL)

		expect(mockShareAsync).not.toHaveBeenCalled()
	})

	it("propagates a rejection so the caller surfaces it", async () => {
		vi.mocked(Share.share).mockRejectedValue(new Error("share boom"))

		await expect(shareUrl(URL)).rejects.toThrow("share boom")
	})
})
