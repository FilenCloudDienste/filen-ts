// @vitest-environment jsdom

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { cleanup, render } from "@testing-library/react"
import { createElement, useState } from "react"
import type { ConversationMeta, HistoryGroup } from "@/features/assistant/store/history.logic"
import { AssistantHistoryList } from "@/features/assistant/components/assistantHistoryList"
import { stubElementSize } from "@/tests/stubElementSize"

let restore: () => void = () => undefined

beforeAll(() => {
	restore = stubElementSize({ clientHeight: 480, clientWidth: 320 })
})

afterAll(() => {
	restore()
})

afterEach(cleanup)

function metas(prefix: string, count: number): ConversationMeta[] {
	return Array.from({ length: count }, (_, index) => ({
		id: `${prefix}${String(index)}`,
		title: `${prefix} ${String(index)}`,
		createdAt: index,
		updatedAt: index,
		bytes: 10,
		rev: `r${String(index)}`
	}))
}

function List({ groups }: { groups: { group: HistoryGroup; conversations: ConversationMeta[] }[] }) {
	const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)

	return createElement(
		"div",
		{ ref: setScrollElement, style: { overflowY: "auto" } },
		createElement(AssistantHistoryList, {
			scrollElement,
			groups,
			label: "Saved conversations",
			groupLabel: group => group,
			renderRow: (meta, style) => createElement("li", { key: meta.id, style }, meta.title)
		})
	)
}

describe("AssistantHistoryList", () => {
	it("draws a window of a long history, not every conversation, each day still a labelled list", () => {
		const { container } = render(
			createElement(List, {
				groups: [
					{ group: "today", conversations: metas("today", 3) },
					{ group: "older", conversations: metas("older", 500) }
				]
			})
		)
		const rows = container.querySelectorAll("li")

		expect(rows.length).toBeGreaterThan(3)
		expect(rows.length).toBeLessThan(40)
		expect(container.textContent).toContain("today 0")
		expect(container.textContent).not.toContain("older 499")
		expect(container.querySelectorAll("section h3").length).toBe(2)
		expect(container.querySelector("section")?.getAttribute("aria-labelledby")).toBe("assistant-history-today")
	})

	it("sizes its layer to every heading and row, so the last conversation is reachable by scrolling", () => {
		const { container } = render(createElement(List, { groups: [{ group: "older", conversations: metas("older", 500) }] }))
		const nav = container.querySelector("nav")

		expect(nav?.style.height).toBe(`${String(32 + 500 * 34 - 2)}px`)
	})
})
