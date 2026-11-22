// @vitest-environment jsdom

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { cleanup, render } from "@testing-library/react"
import { createElement } from "react"
import type { LogEntry } from "@/lib/log"
import { LogsList } from "@/features/settings/components/advanced/logsList"
import { stubElementSize } from "@/tests/stubElementSize"

let restore: () => void = () => undefined

beforeAll(() => {
	restore = stubElementSize({ clientHeight: 288, clientWidth: 512 })
})

afterAll(() => {
	restore()
})

afterEach(cleanup)

function entries(count: number): LogEntry[] {
	return Array.from({ length: count }, (_, index): LogEntry => ({
		t: index,
		level: index % 2 === 0 ? "info" : "error",
		scope: "test",
		msg: `entry ${String(index)}`
	}))
}

describe("LogsList", () => {
	it("draws a window of a few thousand entries, not all of them", () => {
		const { container } = render(createElement(LogsList, { entries: entries(2000) }))
		const rows = container.querySelectorAll("p")

		expect(rows.length).toBeGreaterThan(0)
		expect(rows.length).toBeLessThan(60)
		expect(container.textContent).toContain("entry 0")
		expect(container.textContent).not.toContain("entry 1999")
	})

	it("sizes its layer to every entry, so the last one is reachable by scrolling", () => {
		const { container } = render(createElement(LogsList, { entries: entries(2000) }))
		const layer = container.firstElementChild?.firstElementChild

		expect(layer instanceof HTMLElement ? layer.style.height : undefined).toBe(`${String(2000 * 16 + 24)}px`)
	})
})
