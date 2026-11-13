// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import type { DriveItem } from "@/features/drive/lib/item"
import { knownUnpreviewable, useVideoEditMode } from "@/features/preview/videoEdit/useVideoEditMode"
import { fakeVideoEditClient } from "@/tests/support/fakeVideoEditClient"

// Entering the video editor: a previewable source opens it, one without a picture this browser shows is refused and
// remembered, a failed read ends the client, an entry overtaken by another (or by leaving) ends its own client, and
// leaving ends the open one.

function item(uuid: string): DriveItem {
	return { type: "file", data: { uuid } } as unknown as DriveItem
}

describe("useVideoEditMode", () => {
	it("opens a previewable source and ends its client on exit", async () => {
		const fake = fakeVideoEditClient()
		const { result } = renderHook(() => useVideoEditMode(() => fake.client))
		let outcome = ""

		await act(async () => {
			outcome = await result.current.enter(item("a"), "slot-a")
		})

		expect(outcome).toBe("ready")
		expect(result.current.state?.info).toBe(fake.info)
		expect(result.current.state?.frozenUuid).toBe("slot-a")
		expect(result.current.entering).toBe(false)

		act(() => {
			result.current.exit()
		})

		expect(result.current.state).toBeNull()
		expect(fake.client.dispose).toHaveBeenCalledTimes(1)
	})

	it("refuses a source with no picture to show and remembers it", async () => {
		const fake = fakeVideoEditClient({ info: { previewable: false } })
		const { result } = renderHook(() => useVideoEditMode(() => fake.client))
		let outcome = ""

		await act(async () => {
			outcome = await result.current.enter(item("b"), "slot-b")
		})

		expect(outcome).toBe("unavailable")
		expect(result.current.state).toBeNull()
		expect(fake.client.dispose).toHaveBeenCalledTimes(1)
		expect(knownUnpreviewable("b")).toBe(true)
		expect(knownUnpreviewable("a")).toBe(false)
	})

	it("ends the client of a failed read", async () => {
		const fake = fakeVideoEditClient()

		fake.client.loadSource.mockRejectedValueOnce(new Error("gone"))

		const { result } = renderHook(() => useVideoEditMode(() => fake.client))
		let outcome = ""

		await act(async () => {
			outcome = await result.current.enter(item("c"), "slot-c")
		})

		expect(outcome).toBe("failed")
		expect(fake.client.dispose).toHaveBeenCalledTimes(1)
	})

	it("ends an entry left before its source was read", async () => {
		const fake = fakeVideoEditClient()
		let release: () => void = () => undefined

		fake.client.loadSource.mockReturnValueOnce(
			new Promise(resolve => {
				release = () => {
					resolve(fake.info)
				}
			})
		)

		const { result } = renderHook(() => useVideoEditMode(() => fake.client))
		let pending: Promise<string> = Promise.resolve("")

		act(() => {
			pending = result.current.enter(item("d"), "slot-d")
		})

		expect(result.current.entering).toBe(true)

		act(() => {
			result.current.exit()
		})

		let outcome = ""

		await act(async () => {
			release()
			outcome = await pending
		})

		expect(outcome).toBe("superseded")
		expect(result.current.state).toBeNull()
		expect(fake.client.dispose).toHaveBeenCalledTimes(1)
	})

	it("ends the open client when the overlay goes", async () => {
		const fake = fakeVideoEditClient()
		const create = vi.fn(() => fake.client)
		const { result, unmount } = renderHook(() => useVideoEditMode(create))

		await act(async () => {
			await result.current.enter(item("e"), "slot-e")
		})

		unmount()

		expect(fake.client.dispose).toHaveBeenCalledTimes(1)
		expect(create).toHaveBeenCalledWith(item("e"))
	})
})
