// @vitest-environment jsdom

// A long-running show's season mounts a window of its episodes over the title page's scroller; the arrow keys walk
// the rows (scrolling the next one in), and the heights it measured lay the list out the same when it mounts again.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { useState } from "react"
import { EpisodeRows } from "@/features/videos/components/detail/episodeRows"
import { TitleScrollContext } from "@/features/videos/lib/titleScroll"
import { recallRowSize } from "@/features/videos/lib/scrollMemory"
import { stubElementSize } from "@/tests/stubElementSize"

const COUNT = 300
const ROW = 120

let restoreSize: () => void = () => undefined
const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight")

beforeAll(() => {
	restoreSize = stubElementSize({ clientHeight: 600, clientWidth: 800 })
	// Rows are measured, and jsdom measures every box as empty: each one reports a real row's height.
	Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => ROW })
})

afterAll(() => {
	restoreSize()

	if (offsetHeight !== undefined) {
		Object.defineProperty(HTMLElement.prototype, "offsetHeight", offsetHeight)
	}
})

afterEach(cleanup)

function rowKey(index: number): string {
	return `episode-${String(index)}`
}

function Page() {
	const [scroller, setScroller] = useState<HTMLDivElement | null>(null)

	return (
		<div
			ref={setScroller}
			data-testid="scroller"
		>
			<TitleScrollContext value={scroller}>
				<EpisodeRows
					count={COUNT}
					rowKey={rowKey}
					renderRow={index => (
						<>
							<a href={`#${String(index)}`}>{`Episode ${String(index + 1)}`}</a>
							<button type="button">{`Menu ${String(index + 1)}`}</button>
						</>
					)}
				/>
			</TitleScrollContext>
		</div>
	)
}

async function frames(): Promise<void> {
	await act(async () => {
		for (let i = 0; i < 3; i++) {
			await new Promise(resolve => requestAnimationFrame(resolve))
		}
	})
}

describe("EpisodeRows", () => {
	it("mounts a window of the episodes, each placed among all of them", () => {
		render(<Page />)

		const rows = screen.getAllByRole("listitem")

		expect(rows.length).toBeGreaterThan(0)
		expect(rows.length).toBeLessThan(20)
		expect(rows[0]?.getAttribute("aria-setsize")).toBe(String(COUNT))
	})

	it("moves between rows with the arrow keys, keeping the control, and reaches the last with End", async () => {
		render(<Page />)

		const link = screen.getByRole("link", { name: "Episode 1" })

		link.focus()
		fireEvent.keyDown(link, { key: "ArrowDown" })

		expect(document.activeElement).toBe(screen.getByRole("link", { name: "Episode 2" }))

		const menu = screen.getByRole("button", { name: "Menu 2" })

		menu.focus()
		fireEvent.keyDown(menu, { key: "End" })

		// Not mounted yet: the list scrolls to it, jsdom reports the scroll, and it mounts.
		const scroller = screen.getByTestId("scroller")

		act(() => {
			scroller.scrollTop = COUNT * ROW
			scroller.dispatchEvent(new Event("scroll"))
		})
		await frames()

		expect(document.activeElement).toBe(screen.getByRole("button", { name: `Menu ${String(COUNT)}` }))
	})

	it("remembers each row's measured height for the next mount", () => {
		render(<Page />)

		expect(recallRowSize(rowKey(0))).toBe(ROW)
	})
})
