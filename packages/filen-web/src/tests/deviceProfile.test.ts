// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { narrowItem } from "@/features/drive/lib/item"
import { canPreview } from "@/features/drive/lib/preview.logic"
import { allowedMediaContentType } from "@/features/preview/lib/mediaType"
import { deviceProfile, refineDeviceProfile, subscribeDeviceProfile } from "@/lib/deviceProfile"
import { useDeviceProfile } from "@/lib/useDeviceProfile"
import { testUuid } from "@/tests/support/uuid"

const MIB = 1024n * 1024n

function heicFile(size: bigint, mime: string) {
	return narrowItem({
		uuid: testUuid(`photo.heic:${String(size)}`),
		stableUUID: undefined,
		parent: "22222222-2222-2222-2222-222222222222",
		size,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: true,
		meta: { type: "decoded", data: { name: "photo.heic", mime, modified: 1_700_000_000_000n, size, key: "key", version: 2 } }
	})
}

// Runs in file order: the profile is module state, refined step by step.
describe("deviceProfile", () => {
	it("starts with every probe unknown and the desktop's ranged PDF ceiling", () => {
		expect(deviceProfile()).toMatchObject({ heicNative: "unknown", jxlNative: "unknown", pdfRangedMax: 8192n * MIB })
		expect(deviceProfile()).toBe(deviceProfile())
	})

	it("replaces the profile on a refinement and notifies subscribers", () => {
		const before = deviceProfile()
		const listener = vi.fn()
		const unsubscribe = subscribeDeviceProfile(listener)

		refineDeviceProfile({ jxlNative: "no" })

		expect(listener).toHaveBeenCalledTimes(1)
		expect(deviceProfile()).not.toBe(before)
		expect(deviceProfile()).toEqual({ ...before, jxlNative: "no" })

		unsubscribe()
		refineDeviceProfile({ jxlNative: "unknown" })

		expect(listener).toHaveBeenCalledTimes(1)
	})

	it("is read by the gates on their next call: one predicate for the open gate and the inline type", () => {
		const big = heicFile(300n * MIB, "image/jpeg")

		expect(canPreview(big)).toBe(false)
		expect(allowedMediaContentType(big)).toBeNull()

		refineDeviceProfile({ heicNative: "yes" })

		expect(canPreview(big)).toBe(true)
		expect(allowedMediaContentType(big)).toBe("image/jpeg")

		refineDeviceProfile({ heicNative: "unknown" })

		expect(canPreview(big)).toBe(false)
	})

	it("re-renders a hook reader when a probe resolves", () => {
		const { result } = renderHook(() => useDeviceProfile())

		expect(result.current.heicNative).toBe("unknown")

		act(() => {
			refineDeviceProfile({ heicNative: "no" })
		})

		expect(result.current.heicNative).toBe("no")
	})
})
