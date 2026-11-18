// @vitest-environment jsdom

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import "@/lib/i18n"
import { createTestQueryClient, queryClientWrapper } from "@/tests/testQueryClient"
import { PreviewMarkdown } from "@/features/preview/components/previewMarkdown"

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
})

describe("PreviewMarkdown fences", () => {
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
