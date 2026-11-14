// @vitest-environment happy-dom

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { PdfAnnotationRef, PdfComment, PdfCommentThread, PdfReviewState } from "@filen/office/core/pdfedit/annotations"
import { PdfCommentsPanel, type PdfCommentsPanelProps } from "@/features/pdf/comments/pdfCommentsPanel"
import "@/lib/i18n"

// The PDF Comments panel on the generic thread list: lists the document's threads with page, replies and state, opens
// one whole, and replies, edits one's own, deletes and resolves through the host's callbacks; the first reply asks the
// author name once; a selection on the page opens its thread; text is shown as text, never markup.

const settings = vi.hoisted(() => ({ authorName: null as string | null }))

vi.mock("@/lib/useElementSize", () => ({ useElementSize: () => ({ width: 288, height: 600 }) }))
vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve(),
	kvDelete: () => Promise.resolve()
}))
vi.mock("@/features/office/lib/officeSettings", () => ({
	ensureAuthorName: (ask: () => Promise<string | null>) =>
		settings.authorName !== null
			? Promise.resolve(settings.authorName)
			: ask().then(name => {
					if (name !== null) settings.authorName = name

					return name
				}),
	useOfficeSettings: () => ({ authorName: settings.authorName, authorInitials: null, autosave: true, loaded: true })
}))

// An opened thread's virtualizer sizes its viewport (clientHeight) and rows (offsetHeight) off layout, which happy-dom
// leaves 0 (no rows at all).
beforeAll(() => {
	Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
		configurable: true,
		get(this: HTMLElement) {
			return this.hasAttribute("data-index") ? 64 : 0
		}
	})
	Object.defineProperty(HTMLElement.prototype, "clientHeight", {
		configurable: true,
		get(this: HTMLElement) {
			return this.classList.contains("overflow-y-auto") ? 600 : 0
		}
	})
})

afterAll(() => {
	Reflect.deleteProperty(HTMLElement.prototype, "offsetHeight")
	Reflect.deleteProperty(HTMLElement.prototype, "clientHeight")
})

afterEach(() => {
	cleanup()
	settings.authorName = null
})

const CREATED = Date.UTC(2024, 2, 1, 9)

function note(id: number, text: string, author = "Ann Lee"): PdfComment {
	return { id, author, text, created: CREATED, modified: null }
}

function thread(page: number, id: number, text: string, extra: Partial<PdfCommentThread> = {}): PdfCommentThread {
	return {
		page,
		root: { ...note(id, text), type: "Text", rect: [10, 10, 30, 30] },
		replies: [],
		state: "None",
		...extra
	}
}

interface Calls {
	reply: [PdfAnnotationRef, string, string][]
	edit: [PdfAnnotationRef, string][]
	remove: [PdfAnnotationRef, boolean][]
	state: [PdfAnnotationRef, PdfReviewState, string][]
	select: PdfAnnotationRef[]
}

function panel(threads: readonly PdfCommentThread[], extra: Partial<PdfCommentsPanelProps> = {}) {
	const calls: Calls = { reply: [], edit: [], remove: [], state: [], select: [] }
	const props: PdfCommentsPanelProps = {
		threads,
		editable: true,
		phone: false,
		open: true,
		onClose: () => undefined,
		onSelect: ref => {
			calls.select.push(ref)
		},
		onReply: (root, text, author) => {
			calls.reply.push([root, text, author])

			return Promise.resolve(true)
		},
		onEdit: (ref, text) => {
			calls.edit.push([ref, text])

			return Promise.resolve(true)
		},
		onDelete: (ref, isRoot) => {
			calls.remove.push([ref, isRoot])

			return Promise.resolve(true)
		},
		onSetState: (root, state, author) => {
			calls.state.push([root, state, author])

			return Promise.resolve(true)
		},
		...extra
	}
	const view = render(<PdfCommentsPanel {...props} />)

	return { calls, props, view }
}

function first(elements: readonly HTMLElement[]): HTMLElement {
	const element = elements[0]

	if (element === undefined) throw new Error("no element")

	return element
}

describe("PDF comments panel", () => {
	it("lists threads with author, page, replies and state; a window of a 1,000-thread document", async () => {
		const threads: PdfCommentThread[] = [
			thread(0, 5, "Check this figure", { replies: [note(6, "Done", "Bo Ek")], state: "Accepted" }),
			thread(2, 9, "Typo", { state: "Completed" })
		]

		for (let k = 0; k < 1000; k++) threads.push(thread(3, 100 + k, `Note ${String(k)}`))

		panel(threads)

		const list = await screen.findByRole("list", { name: "Comment threads in this document" })
		const rows = within(list).getAllByRole("button")

		expect(rows.length).toBeGreaterThan(5)
		expect(rows.length).toBeLessThan(40)
		expect(first(rows).getAttribute("aria-label")).toMatch(/^Ann Lee, .+: Check this figure, 1 reply, Accepted, Page 1$/u)
		expect(rows[1]?.getAttribute("aria-label")).toMatch(/: Typo, Resolved, Page 3$/u)
		expect(within(list).getByText("1 reply")).toBeTruthy()
		expect(within(list).getAllByText("Page 1")).toHaveLength(1)
	})

	it("shows the empty state and the New button only with onNew", () => {
		const onNew = vi.fn()

		panel([], { onNew })

		expect(screen.getByText("This document has no comments.")).toBeTruthy()
		fireEvent.click(screen.getByRole("button", { name: "New comment" }))
		expect(onNew).toHaveBeenCalledTimes(1)

		cleanup()
		panel([])
		expect(screen.queryByRole("button", { name: "New comment" })).toBeNull()
	})

	it("opening a thread selects its annotation; the first reply asks the author name once", async () => {
		const { calls } = panel([thread(1, 7, "Root", { replies: [note(8, "First reply", "Bo Ek")] })])

		fireEvent.click(await screen.findByRole("button", { name: /: Root, 1 reply, Page 2$/u }))
		expect(await screen.findByText("First reply")).toBeTruthy()
		expect(calls.select).toEqual([{ page: 1, id: 7 }])

		fireEvent.click(screen.getByRole("button", { name: "Reply" }))
		fireEvent.change(screen.getByRole("textbox", { name: "Reply" }), { target: { value: "Fixed" } })
		fireEvent.click(screen.getByRole("button", { name: "Reply" }))

		fireEvent.change(await screen.findByRole("textbox", { name: "Name" }), { target: { value: "Tess Ter" } })
		fireEvent.click(screen.getByRole("button", { name: "Save" }))

		await waitFor(() => {
			expect(calls.reply).toEqual([[{ page: 1, id: 7 }, "Fixed", "Tess Ter"]])
		})

		fireEvent.click(await screen.findByRole("button", { name: "Reply" }))
		fireEvent.change(screen.getByRole("textbox", { name: "Reply" }), { target: { value: "Again" } })
		fireEvent.click(screen.getByRole("button", { name: "Reply" }))

		await waitFor(() => {
			expect(calls.reply).toHaveLength(2)
		})
		expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull()
	})

	it("edits one's own comment only, and deletes a reply or the whole thread", async () => {
		settings.authorName = "Ann Lee"

		const { calls } = panel([thread(0, 3, "Mine", { replies: [note(4, "Theirs", "Bo Ek")] })])

		fireEvent.click(await screen.findByRole("button", { name: /: Mine, 1 reply, Page 1$/u }))
		await screen.findByText("Theirs")

		const triggers = screen.getAllByRole("button", { name: "Comment actions" })

		fireEvent.click(first(triggers.slice(1)))
		expect(await screen.findByRole("menuitem", { name: "Delete comment" })).toBeTruthy()
		expect(screen.queryByRole("menuitem", { name: "Edit" })).toBeNull()
		fireEvent.click(screen.getByRole("menuitem", { name: "Delete comment" }))

		await waitFor(() => {
			expect(calls.remove).toEqual([[{ page: 0, id: 4 }, false]])
		})

		fireEvent.click(first(screen.getAllByRole("button", { name: "Comment actions" })))
		fireEvent.click(await screen.findByRole("menuitem", { name: "Edit" }))
		fireEvent.change(await screen.findByRole("textbox", { name: "Edit" }), { target: { value: "Mine, edited" } })
		fireEvent.click(screen.getByRole("button", { name: "Save" }))

		await waitFor(() => {
			expect(calls.edit).toEqual([[{ page: 0, id: 3 }, "Mine, edited"]])
		})

		fireEvent.click(first(screen.getAllByRole("button", { name: "Comment actions" })))
		fireEvent.click(await screen.findByRole("menuitem", { name: "Delete thread" }))

		await waitFor(() => {
			expect(calls.remove).toEqual([
				[{ page: 0, id: 4 }, false],
				[{ page: 0, id: 3 }, true]
			])
		})
	})

	it("resolves as Completed and reopens as None, with the author name", async () => {
		settings.authorName = "Tess Ter"

		const { calls, props, view } = panel([thread(0, 3, "Open")])

		fireEvent.click(await screen.findByRole("button", { name: /: Open, Page 1$/u }))
		fireEvent.click(await screen.findByRole("button", { name: "Resolve thread" }))

		await waitFor(() => {
			expect(calls.state).toEqual([[{ page: 0, id: 3 }, "Completed", "Tess Ter"]])
		})

		view.rerender(
			<PdfCommentsPanel
				{...props}
				threads={[thread(0, 3, "Open", { state: "Completed" })]}
			/>
		)
		fireEvent.click(await screen.findByRole("button", { name: "Reopen thread" }))

		await waitFor(() => {
			expect(calls.state[1]).toEqual([{ page: 0, id: 3 }, "None", "Tess Ter"])
		})
	})

	it("a selection on the page opens its thread, also once a new note's thread arrives, without taking focus", async () => {
		const outside = document.createElement("button")

		document.body.append(outside)
		outside.focus()

		const threads = [thread(0, 3, "Zero"), thread(4, 11, "Eleven", { replies: [note(12, "Reply to eleven")] })]
		const { props, view } = panel(threads)

		await screen.findByRole("list")
		view.rerender(
			<PdfCommentsPanel
				{...props}
				selected={{ page: 4, id: 12 }}
			/>
		)
		expect(await screen.findByText("Reply to eleven")).toBeTruthy()
		expect(document.activeElement).toBe(outside)

		fireEvent.click(screen.getByRole("button", { name: "All comments" }))
		await screen.findByRole("list")

		// A note just placed: selected before its thread is in the list.
		view.rerender(
			<PdfCommentsPanel
				{...props}
				selected={{ page: 1, id: 20 }}
			/>
		)
		expect(screen.getByRole("list")).toBeTruthy()
		view.rerender(
			<PdfCommentsPanel
				{...props}
				threads={[...threads, thread(1, 20, "Brand new")]}
				selected={{ page: 1, id: 20 }}
			/>
		)
		await waitFor(() => {
			expect(screen.queryByRole("list")).toBeNull()
		})
		expect(screen.getByText("Brand new")).toBeTruthy()
		outside.remove()
	})

	it("shows text as text, never as markup", async () => {
		panel([thread(0, 3, "<b>bold</b><img src=x onerror=alert(1)>")])

		const list = await screen.findByRole("list")

		expect(within(list).getByText("<b>bold</b><img src=x onerror=alert(1)>")).toBeTruthy()
		expect(document.querySelector("b, img")).toBeNull()
	})

	it("a read-only panel offers no actions, and a closed one renders nothing", async () => {
		const { props, view } = panel([thread(0, 3, "Look")], { editable: false })

		fireEvent.click(await screen.findByRole("button", { name: /: Look, Page 1$/u }))
		await screen.findByText("All comments")
		expect(screen.queryByRole("button", { name: "Comment actions" })).toBeNull()
		expect(screen.queryByRole("button", { name: "Reply" })).toBeNull()

		act(() => {
			view.rerender(
				<PdfCommentsPanel
					{...props}
					open={false}
				/>
			)
		})
		expect(document.querySelector("[data-comments-pane]")).toBeNull()
	})
})
