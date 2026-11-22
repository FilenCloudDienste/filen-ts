// @vitest-environment jsdom

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createElement } from "react"
import { DocxBookmarkRows } from "@/features/preview/components/docxBookmarkRows"
import { stubElementSize } from "@/tests/stubElementSize"

const COUNT = 3_000
const names = Array.from({ length: COUNT }, (_, index) => `_Ref${String(index)}`)

let restoreSize: () => void = () => undefined

beforeAll(() => {
	restoreSize = stubElementSize({ clientHeight: 224, clientWidth: 400 })
})

afterAll(() => {
	restoreSize()
})

afterEach(cleanup)

describe("DocxBookmarkRows", () => {
	it("mounts a window of thousands of bookmarks, the last one reachable and selectable", () => {
		const onSelect = vi.fn()

		render(createElement(DocxBookmarkRows, { names, label: "Bookmarks", selected: names[0] ?? null, onSelect }))

		const list = screen.getByRole("list", { name: "Bookmarks" })

		expect(screen.getAllByRole("listitem").length).toBeLessThan(30)
		expect(screen.getByRole("button", { name: "_Ref0" }).getAttribute("aria-pressed")).toBe("true")

		act(() => {
			const scroller = list.parentElement

			if (scroller === null) throw new Error("no scroller")

			scroller.scrollTop = COUNT * 30
			scroller.dispatchEvent(new Event("scroll"))
		})

		fireEvent.click(screen.getByRole("button", { name: `_Ref${String(COUNT - 1)}` }))

		expect(onSelect).toHaveBeenCalledWith(`_Ref${String(COUNT - 1)}`)
	})
})
