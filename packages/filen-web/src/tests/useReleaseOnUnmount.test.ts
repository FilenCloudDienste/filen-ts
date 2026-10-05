// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, renderHook } from "@testing-library/react"
import { useReleaseOnUnmount } from "@/lib/media/useReleaseOnUnmount"

afterEach(() => {
	cleanup()
})

describe("useReleaseOnUnmount", () => {
	it("drops a detached media element's source and empties it", () => {
		const video = document.createElement("video")
		const load = vi.spyOn(video, "load").mockImplementation(() => undefined)

		video.src = "/sw/download/id"

		const { unmount } = renderHook(() => {
			useReleaseOnUnmount(video)
		})

		unmount()

		expect(video.hasAttribute("src")).toBe(false)
		expect(load).toHaveBeenCalledTimes(1)
	})

	it("drops a detached image's source", () => {
		const image = document.createElement("img")

		image.src = "/sw/download/id"

		const { unmount } = renderHook(() => {
			useReleaseOnUnmount(image)
		})

		unmount()

		expect(image.hasAttribute("src")).toBe(false)
	})

	// StrictMode's rehearsal unmount leaves the element in the page, still showing its source.
	it("keeps the source of an element still in the page", () => {
		const image = document.createElement("img")

		image.src = "/sw/download/id"
		document.body.append(image)

		const { unmount } = renderHook(() => {
			useReleaseOnUnmount(image)
		})

		unmount()

		expect(image.getAttribute("src")).toBe("/sw/download/id")
		image.remove()
	})
})
