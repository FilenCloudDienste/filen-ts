// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, renderHook } from "@testing-library/react"
import { useSpeedSampleAging, useTransfersStore, type Transfer } from "@/features/transfers/store/useTransfersStore"

function uploading(id: string): Transfer {
	return {
		id,
		direction: "upload",
		name: "file.txt",
		size: 1_000,
		bytesTransferred: 0,
		status: "uploading",
		paused: false,
		parentUuid: null,
		startedAt: 0
	}
}

beforeEach(() => {
	vi.useFakeTimers()
	vi.setSystemTime(10_000)
	useTransfersStore.setState({ transfers: [], speedSamples: [], rowSpeedSamples: {} })
})

afterEach(() => {
	cleanup()
	vi.useRealTimers()
})

describe("useSpeedSampleAging", () => {
	it("runs no timer while no window holds samples", () => {
		renderHook(() => {
			useSpeedSampleAging()
		})

		expect(vi.getTimerCount()).toBe(0)
	})

	it("ages a stalled transfer's samples out, then stops ticking", () => {
		useTransfersStore.setState({ transfers: [uploading("a")] })

		renderHook(() => {
			useSpeedSampleAging()
		})

		act(() => {
			useTransfersStore.getState().setProgress("a", 100)
			vi.advanceTimersByTime(500)
			useTransfersStore.getState().setProgress("a", 200)
		})

		expect(vi.getTimerCount()).toBe(1)

		act(() => {
			vi.advanceTimersByTime(6_000)
		})

		expect(useTransfersStore.getState().rowSpeedSamples).toEqual({})
		expect(useTransfersStore.getState().speedSamples).toEqual([])
		expect(vi.getTimerCount()).toBe(0)
	})
})
