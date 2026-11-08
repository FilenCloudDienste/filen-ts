// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest"
import { act, render, screen, waitFor } from "@testing-library/react"
import { Toaster, toast } from "sonner"

// Real sonner with the workspace patch (patches/sonner@2.0.8.patch). Focus entering the toast list
// remembers the element focused before it; sonner gives focus back to that element when the list
// unmounts or loses focus. Unpatched it did so even after focus had moved on, which pulled focus off a
// row menu opening at that moment and closed it.

function Page() {
	return (
		<>
			<button type="button">first</button>
			<button type="button">second</button>
			<Toaster theme="light" />
		</>
	)
}

function button(name: string): HTMLElement {
	return screen.getByRole("button", { name })
}

async function showToast(label: string): Promise<string | number> {
	let id: string | number = ""

	act(() => {
		id = toast(label, { duration: Infinity, action: { label: `act ${label}`, onClick: () => undefined } })
	})
	await waitFor(() => {
		expect(screen.getByRole("button", { name: `act ${label}` })).toBeTruthy()
	})

	return id
}

async function dismissAndWaitGone(id: string | number, label: string): Promise<void> {
	act(() => {
		toast.dismiss(id)
	})
	await waitFor(() => {
		expect(screen.queryByRole("button", { name: `act ${label}` })).toBeNull()
	})
}

// sonner runs its restore in the cleanup of an effect keyed on the list ref, so on the Toaster's first
// render after the list unmounted (in the app something always renders it again: offsets, heights).
async function listGone(rerender: (ui: React.ReactNode) => void): Promise<void> {
	await waitFor(() => {
		expect(document.querySelector("[data-sonner-toaster]")).toBeNull()
	})
	rerender(<Page />)
}

// sonner's toast state is module-global: a test that fails before its dismiss must not leave a toast behind.
afterEach(async () => {
	act(() => {
		toast.dismiss()
	})
	await waitFor(() => {
		expect(document.querySelector("[data-sonner-toast]")).toBeNull()
	})
})

describe("sonner focus restore (patched)", () => {
	it("leaves focus where it moved when the last toast leaves after a toast was focused", async () => {
		const { rerender } = render(<Page />)

		const kept = await showToast("kept")
		const focused = await showToast("focused")

		button("first").focus()
		button("act focused").focus()
		// The focused toast goes away with its button: focus falls to the body, no blur reaches the list.
		await dismissAndWaitGone(focused, "focused")
		button("second").focus()
		await dismissAndWaitGone(kept, "kept")
		await listGone(rerender)

		expect(document.activeElement).toBe(button("second"))
	})

	it("leaves focus on the element it moved to out of the list", async () => {
		render(<Page />)

		const id = await showToast("one")

		button("first").focus()
		button("act one").focus()
		button("second").focus()
		const active = document.activeElement

		await dismissAndWaitGone(id, "one")

		expect(active).toBe(button("second"))
	})

	it("still gives focus back when it went down with the list", async () => {
		const { rerender } = render(<Page />)

		const id = await showToast("only")

		button("first").focus()
		button("act only").focus()
		await dismissAndWaitGone(id, "only")
		await listGone(rerender)

		expect(document.activeElement).toBe(button("first"))
	})
})
