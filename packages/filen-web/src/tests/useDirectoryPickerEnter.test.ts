// @vitest-environment jsdom

// A directory created in a picker is opened only while its parent is still the one open.
import { describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"

vi.mock("@/features/drive/queries/drive", () => ({
	useDirectoryListingQuery: () => ({ data: [] }),
	useDirectoryNamesQuery: () => ({ data: undefined }),
	useHiddenDotFilenRoot: () => null
}))

const { useDirectoryPicker } = await import("@/features/drive/hooks/useDirectoryPicker")

describe("useDirectoryPicker enter", () => {
	it("opens the new directory from the parent it was created in", () => {
		const { result } = renderHook(() => useDirectoryPicker(["docs"]))

		act(() => {
			result.current.enter("docs", "reports")
		})

		expect(result.current.pathStack).toEqual(["docs", "reports"])
	})

	it("stays where the user browsed meanwhile", () => {
		const { result } = renderHook(() => useDirectoryPicker(["docs"]))

		act(() => {
			result.current.goRoot()
		})
		act(() => {
			result.current.enter("docs", "reports")
		})

		expect(result.current.pathStack).toEqual([])
	})
})
