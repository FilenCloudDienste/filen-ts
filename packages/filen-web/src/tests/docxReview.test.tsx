// @vitest-environment happy-dom

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { docxComments, type PagedEditor } from "@filen/office/core/docx/paged"
import { reviewView } from "@/features/preview/components/docxReview.logic"
import type { FontExtents, TextMeasurer } from "@filen/office/core/text"
import type { DocxEditingHost } from "@filen/office/dom/docx/editing"
import { registerAllActions } from "@/lib/keymap/actions"

// Comments and tracked changes in the DOCX editor on a real document: margin balloons composed and edited in
// place, the popover where the margin has no room, and the ribbon's Review tab. Text is measured by a stand-in.

interface OfficeView {
	authorName: string | null
	autosave: boolean
	loaded: boolean
}

const hooks = vi.hoisted(() => ({
	hosts: [] as DocxEditingHost[],
	settings: ((): OfficeView => ({ authorName: "Ann Lee", autosave: false, loaded: true }))(),
	// The width the pages' scroll area reports (happy-dom lays nothing out).
	viewport: 1600
}))

const measurer: TextMeasurer = {
	kerningControl: true,
	measure(font, _kerning, texts, count, widths) {
		const size = Number(/([\d.]+)px/.exec(font)?.[1] ?? "16")

		for (let i = 0; i < count; i++) widths[i] = (texts[i] ?? "").length * size * 0.5
	},
	fontExtents(font): FontExtents {
		const size = Number(/([\d.]+)px/.exec(font)?.[1] ?? "16")

		return { ascent: size * 0.8, descent: size * 0.2 }
	}
}

vi.mock("@/features/preview/lib/docxEngine", () => ({ DOCX_FONT_URLS: {} }))
vi.mock("@/features/preview/lib/docxEditing", async () => {
	const actual = await vi.importActual<typeof import("@/features/preview/lib/docxEditing")>("@/features/preview/lib/docxEditing")
	const { inThreadEditingHost } = await vi.importActual<typeof import("@filen/office/dom/docx/editing")>("@filen/office/dom/docx/editing")
	const { prepareDocxSave, writerProof } =
		await vi.importActual<typeof import("@filen/office/core/docx/write")>("@filen/office/core/docx/write")

	return {
		...actual,
		docxEditingHost: () => {
			const host = inThreadEditingHost(
				() => ({
					fontHost: { addBytes: () => Promise.resolve(true), addLocal: () => Promise.resolve(false), remove: () => undefined },
					replayFonts: false,
					fontAssets: { read: () => Promise.resolve(new Uint8Array(4)) },
					measurer,
					yield: () => new Promise<void>(resolve => setTimeout(resolve, 0)),
					sliceMs: 8
				}),
				{ proof: writerProof, writer: { prepare: prepareDocxSave } }
			)

			hooks.hosts.push(host)

			return host
		}
	}
})
vi.mock("@/features/spellcheck/lib/spellcheck", () => ({
	defaultSpellingLanguage: () => "en-US",
	documentSpellingChecker: {
		dictionaryFor: () => undefined,
		known: () => undefined,
		check: () => Promise.resolve(),
		suggest: () => Promise.resolve([]),
		addToDictionary: () => Promise.resolve(),
		subscribe: () => () => undefined
	}
}))
vi.mock("@/features/office/lib/officeSettings", () => ({
	loadOfficeSettings: () => Promise.resolve(),
	saveOfficeAutosave: () => Promise.resolve(),
	useOfficeSettings: () => hooks.settings,
	// Asked through the gate's dialog until the user gave a name.
	ensureAuthorName: (ask: () => Promise<string | null>) =>
		hooks.settings.authorName === null ? ask() : Promise.resolve(hooks.settings.authorName)
}))
vi.mock("sonner", () => ({
	toast: { warning: vi.fn(), info: vi.fn(), success: vi.fn(), error: vi.fn(), loading: vi.fn(), dismiss: vi.fn() }
}))
vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => true }))
vi.mock("@/lib/log", () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

const { DocxEditView } = await import("@/features/preview/components/docxEditor")
const { DocxCommentPopover } = await import("@/features/preview/components/docxCommentPopover")

registerAllActions()

const BYTES = new Uint8Array(readFileSync(join(process.cwd(), "../filen-office/src/tests/fixtures/04-comments-tracked.docx")))
const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth")
const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight")

beforeAll(() => {
	Object.defineProperty(HTMLElement.prototype, "clientWidth", {
		configurable: true,
		get(this: HTMLElement) {
			return this.classList.contains("fo-docx-pages") ? hooks.viewport : 0
		}
	})
	Object.defineProperty(HTMLElement.prototype, "clientHeight", {
		configurable: true,
		get(this: HTMLElement) {
			return this.classList.contains("fo-docx-pages") ? 1200 : 0
		}
	})
})

afterAll(() => {
	if (clientWidth !== undefined) {
		Object.defineProperty(HTMLElement.prototype, "clientWidth", clientWidth)
	}

	if (clientHeight !== undefined) {
		Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeight)
	}
})

afterEach(() => {
	cleanup()
	hooks.hosts.length = 0
	hooks.settings = { authorName: "Ann Lee", autosave: false, loaded: true }
	hooks.viewport = 1600
	vi.clearAllMocks()
})

async function openEditor(writable = true): Promise<PagedEditor> {
	render(
		<DocxEditView
			bytes={BYTES}
			alt="review.docx"
			writable={writable}
			renamed={false}
			onDirtyChange={() => undefined}
			saveRef={{ current: null }}
			onAutosave={() => true}
			viewer={() => <div>viewer</div>}
		/>
	)

	const host = hooks.hosts.at(-1)

	if (host === undefined) {
		throw new Error("no editing host")
	}

	const editor: PagedEditor = await act(() => host.editor)

	await waitFor(() => {
		expect(screen.getByRole("textbox", { name: "review.docx" })).toBeTruthy()
	})

	return editor
}

function firstOf(elements: readonly HTMLElement[]): HTMLElement {
	const element = elements[0]

	if (element === undefined) {
		throw new Error("none found")
	}

	return element
}

function balloons(): HTMLElement[] {
	return [...document.querySelectorAll<HTMLElement>("article[data-balloon^='c:']")]
}

// The ribbon's Review tab.
async function openReview(): Promise<void> {
	fireEvent.click(await screen.findByRole("tab", { name: "Review" }))
}

describe("comments in the margin", () => {
	it("shows each thread in a balloon beside the pages and composes a new comment there", async () => {
		const editor = await openEditor()
		const store = docxComments(editor)

		await waitFor(() => {
			expect(balloons()).toHaveLength(2)
		})
		expect(balloons()[0]?.getAttribute("aria-label")).toBe("Comments by Alice")
		await openReview()
		fireEvent.click(await screen.findByRole("button", { name: "New comment" }))

		const field = await screen.findByRole("textbox", { name: "Add a comment" })

		fireEvent.change(field, { target: { value: "Looks right\nSecond line" } })
		fireEvent.click(screen.getByRole("button", { name: "Comment" }))
		await waitFor(() => {
			expect(store.threads()).toHaveLength(3)
		})
		expect(
			store.threads().some(thread => thread.comment.text === "Looks right\nSecond line" && thread.comment.author === "Ann Lee")
		).toBe(true)
		await waitFor(() => {
			expect(balloons()).toHaveLength(3)
		})
	})

	it("drops a new comment on Cancel", async () => {
		const editor = await openEditor()

		await openReview()
		fireEvent.click(await screen.findByRole("button", { name: "New comment" }))
		fireEvent.change(await screen.findByRole("textbox", { name: "Add a comment" }), { target: { value: "never" } })
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
		await waitFor(() => {
			expect(screen.queryByRole("textbox", { name: "Add a comment" })).toBeNull()
		})
		expect(docxComments(editor).threads()).toHaveLength(2)
	})

	it("replies, edits, resolves and deletes from a balloon", async () => {
		const editor = await openEditor()
		const store = docxComments(editor)

		await waitFor(() => {
			expect(balloons()).toHaveLength(2)
		})

		const first = store.threads()[0]

		if (first === undefined) {
			throw new Error("no thread")
		}

		const balloon = (): HTMLElement => {
			const found = document.querySelector<HTMLElement>(`article[data-balloon='c:${first.id}']`)

			if (found === null) {
				throw new Error("no balloon")
			}

			return found
		}

		fireEvent.click(balloon())
		fireEvent.click(await within(balloon()).findByRole("button", { name: "Reply" }))
		fireEvent.change(await within(balloon()).findByRole("textbox", { name: "Reply" }), { target: { value: "Agreed" } })
		fireEvent.click(within(balloon()).getByRole("button", { name: "Reply" }))
		await waitFor(() => {
			expect(store.threads()[0]?.replies.map(reply => reply.text)).toEqual(["Agreed"])
		})

		// The first comment's own menu (the replies have theirs).
		fireEvent.click(firstOf(await within(balloon()).findAllByRole("button", { name: "Comment actions" })))
		fireEvent.click(await screen.findByRole("menuitem", { name: "Edit" }))

		const edit = await within(balloon()).findByDisplayValue(first.comment.text)

		fireEvent.change(edit, { target: { value: "Changed text" } })
		fireEvent.click(within(balloon()).getByRole("button", { name: "Save" }))
		await waitFor(() => {
			expect(store.threads()[0]?.comment.text).toBe("Changed text")
		})

		fireEvent.click(firstOf(await within(balloon()).findAllByRole("button", { name: "Comment actions" })))
		fireEvent.click(await screen.findByRole("menuitem", { name: "Resolve" }))
		await waitFor(() => {
			expect(store.threads()[0]?.done).toBe(true)
		})

		fireEvent.click(firstOf(await within(balloon()).findAllByRole("button", { name: "Comment actions" })))
		fireEvent.click(await screen.findByRole("menuitem", { name: "Reopen" }))
		await waitFor(() => {
			expect(store.threads()[0]?.done).toBe(false)
		})

		fireEvent.click(firstOf(await within(balloon()).findAllByRole("button", { name: "Comment actions" })))
		fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }))
		await waitFor(() => {
			expect(store.threads()).toHaveLength(1)
		})
		await waitFor(() => {
			expect(balloons()).toHaveLength(1)
		})
	})

	it("offers no reply, edit or delete while the document is view-only", async () => {
		await openEditor(false)

		await waitFor(() => {
			expect(balloons()).toHaveLength(2)
		})
		fireEvent.click(firstOf(balloons()))
		expect(screen.queryByRole("button", { name: "Comment actions" })).toBeNull()
		expect(screen.queryByRole("button", { name: "Reply" })).toBeNull()
	})

	it("opens threads from markers and composes in a popover where the margin has no room", async () => {
		hooks.viewport = 860

		const editor = await openEditor()
		const store = docxComments(editor)

		const markers = await screen.findAllByRole("button", { name: /^Comment by / })

		expect(balloons()).toHaveLength(0)
		fireEvent.click(firstOf(markers))
		expect(await screen.findByText(store.threads()[0]?.comment.text ?? "?")).toBeTruthy()
		fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })

		await openReview()
		fireEvent.click(await screen.findByRole("button", { name: "New comment" }))
		fireEvent.change(await screen.findByRole("textbox", { name: "Add a comment" }), { target: { value: "From the popover" } })
		fireEvent.click(screen.getByRole("button", { name: "Comment" }))
		await waitFor(() => {
			expect(store.threads().some(thread => thread.comment.text === "From the popover")).toBe(true)
		})
	})
})

describe("what a keystroke costs the review layer", () => {
	it("tells nothing for an edit that moves no annotation, and gives a page that changed a new object", async () => {
		const editor = await openEditor()
		const view = reviewView(editor)

		await waitFor(() => {
			expect(view.page(0)?.threads).toHaveLength(2)
		})

		// Untracked typing (the document tracks changes).
		await act(() => editor.execute({ type: "review.track", on: false }))
		await act(() => new Promise(resolve => setTimeout(resolve, 50)))

		const before = view.page(0)
		const threads = view.threads()
		const heard = vi.fn()
		const stop = view.subscribe(heard)
		const plain = editor.state.doc.textContent.indexOf("Plain")
		let after = -1

		editor.state.doc.descendants((node, pos) => {
			if (after < 0 && node.isText && node.text?.includes("fox jumps") === true) after = pos + (node.text.indexOf("fox jumps") + 9)

			return after < 0
		})
		expect(plain).toBeLessThan(0)
		heard.mockClear()

		// Typed at the end of a paragraph after both comments: no box moves.
		act(() => {
			editor.dispatch(editor.state.tr.insertText("!", after))
		})
		await act(() => new Promise(resolve => setTimeout(resolve, 50)))
		expect(view.page(0)).toBe(before)
		expect(view.threads()).toBe(threads)
		expect(heard).not.toHaveBeenCalled()

		// Typed inside the first comment's text: that page's object is new, told once.
		let inside = -1

		editor.state.doc.descendants((node, pos) => {
			if (inside < 0 && node.isText && node.text?.includes("This sentence") === true)
				inside = pos + node.text.indexOf("This sentence") + 4

			return inside < 0
		})
		act(() => {
			editor.dispatch(editor.state.tr.insertText("xx", inside))
		})
		await act(() => new Promise(resolve => setTimeout(resolve, 50)))
		expect(view.page(0)).not.toBe(before)
		expect(heard).toHaveBeenCalledTimes(1)
		stop()
	})
	it("keeps a page's frame and threads for a change typed into it, so its balloons and markers are not drawn again", async () => {
		const editor = await openEditor()
		const view = reviewView(editor)

		await waitFor(() => {
			expect(view.page(0)?.threads).toHaveLength(2)
		})
		expect(editor.snapshot().review.tracking).toBe(true)

		const before = view.page(0)
		let after = -1

		editor.state.doc.descendants((node, pos) => {
			if (after < 0 && node.isText && node.text?.includes("fox jumps") === true) after = pos + (node.text.indexOf("fox jumps") + 9)

			return after < 0
		})

		// Typed while tracking: a new insertion on the page (its revisions and bars change), no thread moves.
		act(() => {
			editor.dispatch(editor.state.tr.insertText("!", after))
		})
		await act(() => new Promise(resolve => setTimeout(resolve, 50)))

		const page = view.page(0)

		expect(page).not.toBe(before)
		expect(page?.revisions.length).toBeGreaterThan(before?.revisions.length ?? 0)
		expect(page?.frame).toBe(before?.frame)
		expect(page?.threads).toBe(before?.threads)
		expect(page?.changes).toBe(before?.changes)
	})
})

describe("following the pages", () => {
	it("moves the balloons with a page that moved without drawing again (the view resized at a fixed zoom)", async () => {
		const editor = await openEditor()
		const view = reviewView(editor)

		await waitFor(() => {
			expect(view.layout().frames.length).toBeGreaterThan(0)
		})

		const page = document.querySelector<HTMLElement>('[data-fo-page="0"]')

		if (page === null) {
			throw new Error("no page")
		}

		act(() => {
			page.style.left = "120px"
		})
		await waitFor(() => {
			expect(view.layout().frames[0]?.left).toBe(120)
		})
		await waitFor(() => {
			expect(balloons()[0]?.style.left).toBe(`${String(120 + (view.page(0)?.frame.width ?? 0) + 16)}px`)
		})
	})
})

describe("the input request for a new comment", () => {
	it("is held while the comment is composed and done with once it is dropped", async () => {
		const editor = await openEditor()
		const done = vi.fn()

		render(
			<DocxCommentPopover
				editor={editor}
				snapshot={undefined}
				surface="reflow"
				container={document.body as HTMLDivElement}
				zoom={1}
				readOnly={false}
				execute={() => undefined}
				withAuthor={run => {
					run("Ann Lee")
				}}
				press={null}
				onPressDone={() => undefined}
				inputRequest={{ type: "comment.add", nonce: 7 }}
				requestInput={() => undefined}
				onInputDone={done}
			/>
		)

		const field = await screen.findByRole("textbox", { name: "Add a comment" })

		expect(done).not.toHaveBeenCalled()
		fireEvent.change(field, { target: { value: "dropped" } })
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
		expect(done).toHaveBeenCalledWith(7)
	})
})

describe("composing without a name", () => {
	it("keeps the comment typed when the name is not given", async () => {
		hooks.settings = { authorName: null, autosave: false, loaded: true }

		const editor = await openEditor()

		await openReview()
		fireEvent.click(await screen.findByRole("button", { name: "New comment" }))
		fireEvent.change(await screen.findByRole("textbox", { name: "Add a comment" }), { target: { value: "Kept draft" } })
		fireEvent.click(screen.getByRole("button", { name: "Comment" }))

		const name = await screen.findByRole("textbox", { name: "Name" })

		fireEvent.keyDown(name, { key: "Escape" })
		await waitFor(() => {
			expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull()
		})
		expect(screen.getByRole("textbox", { name: "Add a comment" })).toHaveProperty("value", "Kept draft")
		expect(docxComments(editor).threads()).toHaveLength(2)
	})
})

describe("the Review tab", () => {
	it("switches tracking, steps through and resolves changes, and switches the markup", async () => {
		const editor = await openEditor()

		await openReview()

		// The document tracks changes (w:trackRevisions): the switch says so.
		const track = await screen.findByRole("button", { name: "Track changes" })

		expect(editor.snapshot().review.tracking).toBe(true)
		expect(track.getAttribute("aria-pressed")).toBe("true")
		fireEvent.click(track)
		await waitFor(() => {
			expect(editor.snapshot().review.tracking).toBe(false)
		})
		await waitFor(() => {
			expect(screen.getByRole("button", { name: "Track changes" }).getAttribute("aria-pressed")).toBe("false")
		})
		fireEvent.click(screen.getByRole("button", { name: "Track changes" }))
		await waitFor(() => {
			expect(editor.snapshot().review.tracking).toBe(true)
		})

		fireEvent.click(screen.getByRole("button", { name: "Next change" }))
		await waitFor(() => {
			expect(editor.snapshot().review.current).not.toBeNull()
		})

		const before = editor.snapshot().review.revisionCount

		fireEvent.click(within(screen.getByRole("toolbar", { name: "Commands" })).getByRole("button", { name: "Accept" }))
		fireEvent.click(await screen.findByRole("menuitem", { name: "Accept change" }))
		await waitFor(() => {
			expect(editor.snapshot().review.revisionCount).toBe(before - 1)
		})

		fireEvent.click(within(screen.getByRole("toolbar", { name: "Commands" })).getByRole("button", { name: "Reject" }))
		fireEvent.click(await screen.findByRole("menuitem", { name: "Reject all changes" }))
		await waitFor(() => {
			expect(editor.snapshot().review.revisionCount).toBe(0)
		})

		fireEvent.click(screen.getByRole("button", { name: "Markup" }))
		fireEvent.click(await screen.findByRole("menuitemradio", { name: "All markup" }))
		await waitFor(() => {
			expect(editor.view).toBe(0)
		})
	})

	it("accepts the change at the caret from its card", async () => {
		const editor = await openEditor()

		await openReview()
		fireEvent.click(await screen.findByRole("button", { name: "Next change" }))

		const card = await screen.findByRole("dialog", { name: /^Change by / })
		const before = editor.snapshot().review.revisionCount

		fireEvent.click(within(card).getByRole("button", { name: "Accept" }))
		await waitFor(() => {
			expect(editor.snapshot().review.revisionCount).toBe(before - 1)
		})
	})
})
