// @vitest-environment jsdom

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, screen } from "@testing-library/react"
import { highlightCodeRuns } from "@filen/office/dom/code"
import "@/lib/i18n"
import { createTestQueryClient, queryClientWrapper } from "@/tests/testQueryClient"
import { PreviewMarkdown } from "@/features/preview/components/previewMarkdown"
import { HighlightedFence } from "@/features/preview/components/highlightedFence"
import { FENCE_MAX_LINES, FenceBudgetContext, type FenceBudget } from "@/features/preview/lib/fenceBudget"

vi.mock("@filen/office/dom/code", async importOriginal => {
	const actual = await importOriginal<typeof import("@filen/office/dom/code")>()

	return { ...actual, highlightCodeRuns: vi.fn(actual.highlightCodeRuns) }
})

// A markdown file's fences: highlighted once near the viewport, one an idle task, none past the document's line budget.

beforeAll(() => {
	// Every fence is in view at once.
	globalThis.IntersectionObserver = class {
		private readonly callback: IntersectionObserverCallback

		constructor(callback: IntersectionObserverCallback) {
			this.callback = callback
		}

		observe(target: Element): void {
			this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
		}

		disconnect(): void {
			return undefined
		}
	} as unknown as typeof IntersectionObserver
})

afterEach(() => {
	cleanup()
	vi.unstubAllGlobals()
	vi.mocked(highlightCodeRuns).mockClear()
})

// An IntersectionObserver the test moves across the margin itself.
function stubCrossings(): (near: boolean) => void {
	const observers: { callback: IntersectionObserverCallback; target: Element }[] = []

	vi.stubGlobal(
		"IntersectionObserver",
		class {
			private readonly callback: IntersectionObserverCallback

			constructor(callback: IntersectionObserverCallback) {
				this.callback = callback
			}

			observe(target: Element): void {
				observers.push({ callback: this.callback, target })
			}

			disconnect(): void {
				return undefined
			}
		}
	)

	return near => {
		act(() => {
			for (const { callback, target } of observers) {
				callback([{ isIntersecting: near, target } as IntersectionObserverEntry], {} as IntersectionObserver)
			}
		})
	}
}

describe("HighlightedFence", () => {
	it("highlights and charges the budget once although the fence comes near again", async () => {
		const cross = stubCrossings()
		const budget: FenceBudget = { lines: 0, chars: 0 }
		const text = "def f():\n    pass"

		render(
			<FenceBudgetContext value={budget}>
				<HighlightedFence
					language="python"
					text={text}
					className=""
				/>
			</FenceBudgetContext>
		)

		cross(true)
		await vi.waitFor(() => {
			expect(document.querySelector("code span")).not.toBeNull()
		})

		cross(false)
		cross(true)
		cross(false)
		cross(true)
		await new Promise(resolve => setTimeout(resolve, 100))

		expect(vi.mocked(highlightCodeRuns)).toHaveBeenCalledTimes(1)
		expect(budget).toEqual({ lines: 2, chars: text.length })
		expect(document.querySelector("code span")).not.toBeNull()
	})

	it("charges once for a fence mounted again with the same text", async () => {
		const cross = stubCrossings()
		const budget: FenceBudget = { lines: 0, chars: 0 }
		const text = "x = 1"
		const fence = (
			<FenceBudgetContext value={budget}>
				<HighlightedFence
					language="python"
					text={text}
					className=""
				/>
			</FenceBudgetContext>
		)
		const first = render(fence)

		cross(true)
		await vi.waitFor(() => {
			expect(document.querySelector("code span")).not.toBeNull()
		})
		first.unmount()

		render(fence)
		cross(true)
		await vi.waitFor(() => {
			expect(document.querySelector("code span")).not.toBeNull()
		})

		expect(budget).toEqual({ lines: 1, chars: text.length })
	})

	it("shows the new text plain, not the old runs, when the new text is refused", async () => {
		const cross = stubCrossings()
		// Room for the first text's two lines, not for the second's five.
		const budget: FenceBudget = { lines: FENCE_MAX_LINES - 3, chars: 0 }
		const fence = (text: string) => (
			<FenceBudgetContext value={budget}>
				<HighlightedFence
					language="python"
					text={text}
					className=""
				/>
			</FenceBudgetContext>
		)
		const view = render(fence("def f():\n    pass"))

		cross(true)
		await vi.waitFor(() => {
			expect(document.querySelector("code span")).not.toBeNull()
		})

		view.rerender(fence("y = 2\ny = 3\ny = 4\ny = 5\ny = 6"))
		await new Promise(resolve => setTimeout(resolve, 100))

		const code = document.querySelector("code")

		expect(code?.querySelector("span")).toBeNull()
		expect(code?.textContent).toBe("y = 2\ny = 3\ny = 4\ny = 5\ny = 6")
		expect(vi.mocked(highlightCodeRuns)).toHaveBeenCalledTimes(1)
	})
})

describe("PreviewMarkdown fences", () => {
	it("measures a fence's nearness against the markdown file's own scroller, not the page", async () => {
		const roots: (Element | Document | null | undefined)[] = []

		vi.stubGlobal(
			"IntersectionObserver",
			class {
				constructor(_callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
					roots.push(options?.root)
				}

				observe(): void {
					return undefined
				}

				disconnect(): void {
					return undefined
				}
			}
		)

		render(
			<PreviewMarkdown
				text={"```python\ndef f():\n    pass\n```\n"}
				alt="doc"
			/>,
			{ wrapper: queryClientWrapper(createTestQueryClient()) }
		)

		const scroller = await screen.findByRole("document", { name: "doc" })

		await vi.waitFor(() => {
			expect(roots.length).toBeGreaterThan(0)
		})
		expect(roots.every(root => root === scroller)).toBe(true)
	})

	it("highlights a fence in a known language and leaves an unknown one plain", async () => {
		render(
			<PreviewMarkdown
				text={"```python\ndef f():\n    pass\n```\n\n```nosuchlang\ndef g\n```\n"}
				alt="doc"
			/>,
			{ wrapper: queryClientWrapper(createTestQueryClient()) }
		)

		expect((await screen.findByText("def")).tagName).toBe("SPAN")
		expect(screen.getByText("def g").tagName).toBe("CODE")
	})

	it("leaves fences plain past the document's line budget", async () => {
		const fence = `\`\`\`python\n${"a = 1\n".repeat(6000)}\`\`\`\n\n`

		render(
			<PreviewMarkdown
				text={fence + fence}
				alt="doc"
			/>,
			{ wrapper: queryClientWrapper(createTestQueryClient()) }
		)

		await screen.findAllByText("a")

		const fences = [...document.querySelectorAll("code.fo-code-static")]

		expect(fences.map(code => code.querySelector("span") !== null)).toEqual([true, false])
	})

	it("leaves fences plain past the document's character budget", async () => {
		// One long line a fence: lines stay few, characters run out after 17 fences of 60,000.
		const fence = `\`\`\`python\nx = "${"a".repeat(60_000)}"\n\`\`\`\n\n`

		render(
			<PreviewMarkdown
				text={fence.repeat(20)}
				alt="doc"
			/>,
			{ wrapper: queryClientWrapper(createTestQueryClient()) }
		)

		await vi.waitFor(
			() => {
				expect(document.querySelectorAll("code.fo-code-static span").length).toBeGreaterThan(0)
			},
			{ timeout: 10_000 }
		)
		await new Promise(resolve => setTimeout(resolve, 500))

		const highlighted = [...document.querySelectorAll("code.fo-code-static")].map(code => code.querySelector("span") !== null)

		expect(highlighted.filter(Boolean)).toHaveLength(17)
		expect(highlighted.slice(17)).toEqual([false, false, false])
	}, 20_000)
})
