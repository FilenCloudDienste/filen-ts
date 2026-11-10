// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { useState } from "react"
import { DocxFindField } from "@/features/preview/components/docxToolbar"
import type { DocxFindControls } from "@/features/preview/components/docxViewer.logic"
import { registerAllActions } from "@/lib/keymap/actions"
import "@/lib/i18n"

// The find bar's replace buttons disable themselves once no match is left: focus goes back to the find field, never to
// the overlay (where the next Escape would close the editor instead of the find bar).

registerAllActions()

afterEach(() => {
	cleanup()
})

function Bar({ matches, replaceOpen }: { matches: number; replaceOpen?: boolean }) {
	const [count, setCount] = useState(matches)
	const find: DocxFindControls = {
		query: "old",
		caseSensitive: false,
		count,
		capped: false,
		active: count === 0 ? -1 : 0,
		search: () => undefined,
		step: () => undefined,
		close: () => undefined,
		replace: {
			disabled: false,
			one: () => {
				setCount(left => left - 1)
			},
			all: () => {
				setCount(0)
			}
		}
	}

	return (
		<DocxFindField
			find={find}
			focus={0}
			onClosed={() => undefined}
			replaceOpen={replaceOpen ?? true}
		/>
	)
}

describe("the find bar after a replace", () => {
	it("Replace all leaves the find field focused", () => {
		render(<Bar matches={3} />)

		const replaceAll = screen.getByRole("button", { name: "Replace all" })

		replaceAll.focus()
		fireEvent.click(replaceAll)

		expect(document.activeElement).toBe(screen.getByRole("searchbox", { name: "Find" }))
	})

	it("replacing the last match leaves the find field focused", () => {
		render(<Bar matches={1} />)

		const replace = screen.getByRole("button", { name: "Replace" })

		replace.focus()
		fireEvent.click(replace)

		expect(document.activeElement).toBe(screen.getByRole("searchbox", { name: "Find" }))
	})
})

// editor.replace (Mod+Alt+F) in the find field shows the replace field and moves there, as the ribbon's Replace does.
describe("the replace key in the find field", () => {
	it("opens the replace field and focuses it", () => {
		render(
			<Bar
				matches={2}
				replaceOpen={false}
			/>
		)

		const field = screen.getByRole("searchbox", { name: "Find" })

		field.focus()
		expect(screen.queryByRole("textbox", { name: "Replace with" })).toBeNull()

		const accepted = fireEvent.keyDown(field, { key: "f", code: "KeyF", ctrlKey: true, altKey: true })

		expect(accepted).toBe(false)
		expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Replace with" }))
	})
})
