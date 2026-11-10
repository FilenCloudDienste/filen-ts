// @vitest-environment happy-dom

import "@/tests/support/officeKeys"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import type { ReactNode } from "react"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { slideRef, type CommentView, type DeckOp, type SlideReview } from "@filen/office/core/presentation"
import type { CommandResult, OpenInfo, PresentationSessionApi, SlideRender } from "@filen/office/dom/presentation"
import { createShapeSelection, createTextEditing } from "@filen/office/react/presentation"
import { OfficeRibbon } from "@/features/office/components/ribbon/officeRibbon"
import { PresentationCommentsPane } from "@/features/presentation/components/commentsPane"
import { slideReview } from "@/features/presentation/components/commentsPane.logic"
import { PresentationNotesPane } from "@/features/presentation/components/notesPane"
import { reviewGroups } from "@/features/presentation/components/ribbon/review"
import { PresentationEditorContext, type PresentationEditorScope } from "@/features/presentation/hooks/usePresentationSession"
import type { PresentationRibbonContext, PresentationRibbonEditor } from "@/features/presentation/components/ribbon/tabs"
import i18n from "i18next"
import "@/lib/i18n"

// The Review tab, the Comments pane and the notes pane against a fake editor: the pane lists a slide's threads as a
// window over its rows, opens one whole, and posts, replies, resolves and deletes through comment ops with the user's
// author name; a slide without notes starts them with notes.setNotes.

const { toast } = vi.hoisted(() => ({ toast: { error: vi.fn(), success: vi.fn(), dismiss: vi.fn() } }))

vi.mock("sonner", () => ({ toast }))
vi.mock("@/lib/useElementSize", () => ({ useElementSize: () => ({ width: 288, height: 600 }) }))
vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve(),
	kvDelete: () => Promise.resolve()
}))
vi.mock("@/features/office/lib/officeSettings", () => ({
	ensureAuthorName: () => Promise.resolve("Tess Ter"),
	useOfficeSettings: () => ({ authorName: "Tess Ter", autosave: true, loaded: true })
}))

const ref = slideRef(256)

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

function first(elements: readonly HTMLElement[]): HTMLElement {
	const element = elements[0]

	if (element === undefined) throw new Error("no element")

	return element
}
let revision = 1

function renderOf(): SlideRender {
	return {
		ref,
		index: 0,
		revision: revision++,
		hidden: false,
		background: {},
		layers: [],
		notesText: "",
		animated: false
	} as unknown as SlideRender
}

function comment(id: string, text: string, extra: Partial<CommentView> = {}): CommentView {
	return {
		id,
		format: "modern",
		author: "Ann Lee",
		authorId: "{A}",
		text,
		created: "2024-03-01T09:00:00.000Z",
		resolved: false,
		editable: true,
		...extra
	}
}

// A review as a test writes it: the notes' text only where it matters.
type ReviewFixture = Omit<SlideReview, "notesText"> & { readonly notesText?: string }

function editorWith(
	review: ReviewFixture | (() => ReviewFixture),
	answer: (op: DeckOp) => CommandResult = () => ({ ok: true, revision: 2, dirty: true })
): { editor: PresentationRibbonEditor; ops: DeckOp[]; needs: (boolean | undefined)[]; retracts: number[]; seeds: number[] } {
	const ops: DeckOp[] = []
	// Per review asked: whether it asked for the comments (undefined: the default, with them).
	const needs: (boolean | undefined)[] = []
	const retracts: number[] = []
	const seeds: number[] = []
	const session = {
		review: (_slide: unknown, options?: { readonly comments?: boolean }) => {
			needs.push(options?.comments)

			const answer = typeof review === "function" ? review() : review

			return Promise.resolve<SlideReview>({ notesText: "", ...answer })
		},
		// The pane takes back its own notes by retracting their step, never by an undo (which would leave a redo step).
		undo: () => Promise.reject(new Error("no undo from the pane")),
		retract: (revision: number) => {
			retracts.push(revision)

			return Promise.resolve({ ok: true, revision: 3, dirty: false } satisfies CommandResult)
		},
		// The body's seed never comes: the editor stays before its first focus.
		textSeed: () => {
			seeds.push(1)

			return new Promise(() => undefined)
		}
	} as unknown as PresentationSessionApi
	const editor: PresentationRibbonEditor = {
		info: { slides: [{ ref, hidden: false }], editable: true } as unknown as OpenInfo,
		render: renderOf(),
		selection: createShapeSelection(),
		session,
		text: createTextEditing(),
		command: op => {
			ops.push(op)

			return Promise.resolve(answer(op))
		}
	}

	return { editor, ops, needs, retracts, seeds }
}

// The editor's history as the panes see it (the store's revision), bumped as an op, undo or redo would.
function historyScope(): { scope: (children: ReactNode) => ReactNode; bump: () => void } {
	let revision = 1
	const listeners = new Set<() => void>()
	const store = {
		subscribe: (listener: () => void) => {
			listeners.add(listener)

			return () => {
				listeners.delete(listener)
			}
		},
		getSnapshot: () => ({ revision })
	}
	const value = { editor: { store }, view: {} } as unknown as PresentationEditorScope

	return {
		scope: children => <PresentationEditorContext value={value}>{children}</PresentationEditorContext>,
		bump: () => {
			revision++

			for (const listener of listeners) listener()
		}
	}
}

afterEach(() => {
	cleanup()
	toast.error.mockClear()
	act(() => {
		slideReview.setOpen(false)
		slideReview.openThread(undefined)
	})
})

describe("presentation review", () => {
	it("the Review tab shows the Comments pane and starts a comment in it; posting adds one with the user's name", async () => {
		const { editor, ops } = editorWith({ slide: ref, format: "modern", comments: [], can: { reply: true, resolve: true } })
		const context = {
			editable: true,
			phone: false,
			selection: new Set(),
			t: i18n.t.bind(i18n),
			editor
		} as unknown as PresentationRibbonContext

		render(
			<>
				<OfficeRibbon
					label="Ribbon"
					commandsLabel="Commands"
					tabs={[{ id: "review", label: "Review" }]}
					tab="review"
					onTab={() => undefined}
					file={null}
					groups={reviewGroups(context)}
				/>
				<PresentationCommentsPane
					editor={editor}
					editable
					phone={false}
				/>
			</>
		)

		fireEvent.click(screen.getByRole("button", { name: "Show comments" }))
		expect(await screen.findByText("This slide has no comments.")).toBeTruthy()

		fireEvent.click(first(screen.getAllByRole("button", { name: "New comment" })))
		fireEvent.change(screen.getByRole("textbox", { name: "Add a comment" }), { target: { value: "Needs a source" } })
		fireEvent.click(screen.getByRole("button", { name: "Post" }))

		await waitFor(() => {
			expect(ops).toHaveLength(1)
		})

		const op = ops[0]

		expect(op?.family === "comment" && op.kind === "add" ? [op.slide, op.comment.text, op.authorName] : undefined).toEqual([
			ref,
			"Needs a source",
			"Tess Ter"
		])
		expect(
			op?.family === "comment" && op.kind === "add"
				? /^\{[0-9A-F-]{36}\}$/u.test(op.comment.id) && /^\{[0-9A-F-]{36}\}$/u.test(op.comment.author)
				: false
		).toBe(true)
	})

	it("draws a window of a 1,000-thread list and opens a thread whole: reply, resolve and delete go out as ops", async () => {
		const comments: CommentView[] = []

		for (let k = 0; k < 1000; k++) comments.push(comment(`{T${String(k)}}`, `Thread ${String(k)}`))

		comments.splice(1, 0, comment("{R}", "First reply", { parent: "{T0}", author: "Bo Ek", authorId: "{B}" }))

		const { editor, ops } = editorWith({ slide: ref, format: "modern", comments, can: { reply: true, resolve: true } })

		act(() => {
			slideReview.setOpen(true)
		})
		render(
			<PresentationCommentsPane
				editor={editor}
				editable
				phone={false}
			/>
		)

		const list = await screen.findByRole("list", { name: "Comment threads on this slide" })
		const rows = within(list).getAllByRole("button")

		expect(rows.length).toBeGreaterThan(5)
		expect(rows.length).toBeLessThan(40)
		expect(within(list).getByText("1 reply")).toBeTruthy()

		fireEvent.click(first(rows))
		expect(await screen.findByText("First reply")).toBeTruthy()

		fireEvent.click(screen.getByRole("button", { name: "Reply" }))
		fireEvent.change(screen.getByRole("textbox", { name: "Reply" }), { target: { value: "Fixed" } })
		fireEvent.click(screen.getByRole("button", { name: "Reply" }))
		fireEvent.click(screen.getByRole("button", { name: "Resolve thread" }))

		await waitFor(() => {
			expect(ops.map(op => (op.family === "comment" ? op.kind : op.family))).toEqual(["reply", "resolve"])
		})

		const reply = ops[0]

		expect(
			reply?.family === "comment" && reply.kind === "reply" ? [reply.parent, reply.comment.text, reply.authorName] : undefined
		).toEqual(["{T0}", "Fixed", "Tess Ter"])
		expect(ops[1]).toEqual({ family: "comment", kind: "resolve", slide: ref, id: "{T0}", resolved: true })
	})

	it("a legacy thread offers no resolve", async () => {
		const { editor } = editorWith({
			slide: ref,
			format: "legacy",
			comments: [comment("legacy:0:1", "Old", { format: "legacy" })],
			can: { reply: true, resolve: false }
		})

		act(() => {
			slideReview.setOpen(true)
		})
		render(
			<PresentationCommentsPane
				editor={editor}
				editable
				phone={false}
			/>
		)

		fireEvent.click(await screen.findByRole("button", { name: /^Ann Lee, .*: Old$/u }))
		expect(await screen.findByText("Comments of this kind cannot be marked resolved.")).toBeTruthy()
		expect(screen.queryByRole("button", { name: "Resolve thread" })).toBeNull()
	})

	it("a slide without notes offers to start them: a click is one notes.setNotes", async () => {
		const { editor, ops } = editorWith({ slide: ref, format: "modern", comments: [], can: { reply: true, resolve: true } })

		render(
			<PresentationNotesPane
				text=""
				phone={false}
				editor={editor}
			/>
		)

		fireEvent.click(await screen.findByRole("button", { name: "Click to add notes" }))

		await waitFor(() => {
			expect(ops).toEqual([{ family: "notes", kind: "setNotes", slide: ref, body: { bodyPr: {}, paragraphs: [] } }])
		})
	})

	it("the notes pane asks for the notes without the comments and shows what the worker last answered after each op", async () => {
		let notesText = "First"
		const { editor, needs } = editorWith(() => ({
			slide: ref,
			format: "modern",
			comments: [],
			notesText,
			can: { reply: true, resolve: true }
		}))
		const history = historyScope()

		render(
			history.scope(
				<PresentationNotesPane
					text="First"
					phone={false}
					editor={editor}
				/>
			)
		)

		expect(await screen.findByText("First")).toBeTruthy()

		// A notes edit (or its undo) renders no slide again: the history's next revision brings the new text.
		notesText = "First Second"
		act(() => {
			history.bump()
		})

		expect(await screen.findByText("First Second")).toBeTruthy()
		expect(needs.length).toBeGreaterThan(1)
		expect(needs.every(need => need === false)).toBe(true)
	})

	it("a refused comment keeps its field and text with no toast of its own; a soft line break posts as a line break", async () => {
		let refuse = true
		const { editor, ops } = editorWith({ slide: ref, format: "modern", comments: [], can: { reply: true, resolve: true } }, () =>
			refuse ? { ok: false, refusal: "malformed" } : { ok: true, revision: 2, dirty: true }
		)

		act(() => {
			slideReview.setOpen(true)
		})
		render(
			<PresentationCommentsPane
				editor={editor}
				editable
				phone={false}
			/>
		)
		expect(await screen.findByText("This slide has no comments.")).toBeTruthy()
		act(() => {
			slideReview.compose(true)
		})

		const field = await screen.findByRole("textbox", { name: "Add a comment" })

		fireEvent.change(field, { target: { value: "bad\u000bchar" } })
		fireEvent.click(screen.getByRole("button", { name: "Post" }))

		await waitFor(() => {
			expect(ops).toHaveLength(1)
		})

		const op = ops[0]

		expect(op?.family === "comment" && op.kind === "add" ? op.comment.text : undefined).toBe("bad\nchar")
		await act(() => Promise.resolve())
		expect(screen.getByRole("textbox", { name: "Add a comment" })).toHaveProperty("value", "bad\u000bchar")
		expect(toast.error).not.toHaveBeenCalled()

		refuse = false
		fireEvent.click(screen.getByRole("button", { name: "Post" }))

		await waitFor(() => {
			expect(screen.queryByRole("textbox", { name: "Add a comment" })).toBeNull()
		})
	})

	it("thread rows of one author have names of their own: date, opening words, replies and resolved", async () => {
		const { editor } = editorWith({
			slide: ref,
			format: "modern",
			comments: [
				comment("{T0}", "Check the figures on this slide"),
				comment("{R0}", "Done", { parent: "{T0}" }),
				comment("{T1}", "Typo in the title", { resolved: true }),
				comment("{T2}", "Typo in the title", { created: "" })
			],
			can: { reply: true, resolve: true }
		})

		act(() => {
			slideReview.setOpen(true)
		})
		render(
			<PresentationCommentsPane
				editor={editor}
				editable
				phone={false}
			/>
		)

		const list = await screen.findByRole("list", { name: "Comment threads on this slide" })
		const names = within(list)
			.getAllByRole("button")
			.map(row => row.getAttribute("aria-label") ?? "")

		expect(new Set(names).size).toBe(3)
		expect(names[0]).toMatch(/^Ann Lee, .+: Check the figures on this slide, 1 reply$/u)
		expect(names[1]).toMatch(/^Ann Lee, .+: Typo in the title, Resolved$/u)
		expect(names[2]).toBe("Ann Lee: Typo in the title")
	})

	it("focus follows the pane: a thread's first comment when opened, its row after All comments, a posted thread's row", async () => {
		const comments = [comment("{T0}", "Zero"), comment("{T1}", "One"), comment("{T2}", "Two")]
		const { editor, ops } = editorWith(() => ({
			slide: ref,
			format: "modern",
			comments: [...comments],
			can: { reply: true, resolve: true }
		}))

		act(() => {
			slideReview.setOpen(true)
		})

		const view = render(
			<PresentationCommentsPane
				editor={editor}
				editable
				phone={false}
			/>
		)
		const list = await screen.findByRole("list", { name: "Comment threads on this slide" })

		fireEvent.click(first(within(list).getAllByRole("button").slice(1)))

		await waitFor(() => {
			expect(document.activeElement?.getAttribute("data-index")).toBe("0")
		})
		expect(document.activeElement?.textContent).toContain("One")

		fireEvent.click(screen.getByRole("button", { name: "All comments" }))

		await waitFor(() => {
			expect(document.activeElement?.getAttribute("data-thread")).toBe("{T1}")
		})

		act(() => {
			slideReview.compose(true)
		})
		fireEvent.change(await screen.findByRole("textbox", { name: "Add a comment" }), { target: { value: "Three" } })
		fireEvent.click(screen.getByRole("button", { name: "Post" }))

		await waitFor(() => {
			expect(ops).toHaveLength(1)
		})

		const op = ops[0]
		const id = op?.family === "comment" && op.kind === "add" ? op.comment.id : ""

		// The op renders the slide again, and its new render asks for the review.
		comments.push(comment(id, "Three"))
		view.rerender(
			<PresentationCommentsPane
				editor={{ ...editor, render: renderOf() }}
				editable
				phone={false}
			/>
		)

		await waitFor(() => {
			expect(document.activeElement?.getAttribute("data-thread")).toBe(id)
		})
	})

	it("a thread of 1,000 replies mounts a window of its comments and one actions menu for them", async () => {
		const comments = [comment("{T0}", "Root")]

		for (let k = 0; k < 1000; k++) comments.push(comment(`{R${String(k)}}`, `Reply ${String(k)}`, { parent: "{T0}" }))

		const { editor } = editorWith({ slide: ref, format: "modern", comments, can: { reply: true, resolve: true } })

		act(() => {
			slideReview.setOpen(true)
		})
		render(
			<PresentationCommentsPane
				editor={editor}
				editable
				phone={false}
			/>
		)

		fireEvent.click(await screen.findByRole("button", { name: /: Root, 1000 replies$/u }))
		expect(await screen.findByText("Root")).toBeTruthy()

		const triggers = screen.getAllByRole("button", { name: "Comment actions" })

		expect(document.querySelectorAll("[data-index]").length).toBeLessThan(40)
		expect(triggers.length).toBeLessThan(40)

		fireEvent.click(first(triggers))
		expect(await screen.findByRole("menuitem", { name: "Delete thread" })).toBeTruthy()
		fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" })
		await waitFor(() => {
			expect(screen.queryByRole("menu")).toBeNull()
		})

		fireEvent.click(first(triggers.slice(1)))
		expect(await screen.findByRole("menuitem", { name: "Delete comment" })).toBeTruthy()
		expect(screen.getAllByRole("menu")).toHaveLength(1)
	})

	it("New Comment before the pane has read the slide keeps the field open; another slide in view closes it", async () => {
		const { editor } = editorWith({ slide: ref, format: "modern", comments: [], can: { reply: true, resolve: true } })

		act(() => {
			slideReview.compose(true)
		})

		const view = render(
			<PresentationCommentsPane
				editor={editor}
				editable
				phone={false}
			/>
		)

		expect(await screen.findByText("This slide has no comments.")).toBeTruthy()
		expect(screen.getByRole("textbox", { name: "Add a comment" })).toBeTruthy()

		view.rerender(
			<PresentationCommentsPane
				editor={{ ...editor, render: { ...renderOf(), ref: slideRef(512) } }}
				editable
				phone={false}
			/>
		)

		await waitFor(() => {
			expect(screen.queryByRole("textbox", { name: "Add a comment" })).toBeNull()
		})
	})

	it("notes started and left at once take nothing: Escape before they open is the notes', and their step is retracted", async () => {
		const history = historyScope()
		let answer: (result: CommandResult) => void = () => undefined
		const { editor, ops, retracts } = editorWith(
			{ slide: ref, format: "modern", comments: [], can: { reply: true, resolve: true } },
			() => ({ ok: true, revision: 2, dirty: true })
		)
		const pending: PresentationRibbonEditor = {
			...editor,
			command: op => {
				ops.push(op)

				return new Promise(resolve => {
					answer = resolve
				})
			}
		}

		render(
			history.scope(
				<PresentationNotesPane
					text=""
					phone={false}
					editor={pending}
				/>
			)
		)

		const add = await screen.findByRole("button", { name: "Click to add notes" })

		fireEvent.keyDown(add, { key: "Enter" })

		// Escape within the same frame: taken here, never the overlay's (it closes the file on an Escape nobody took).
		expect(fireEvent.keyDown(add, { key: "Escape" })).toBe(false)

		// The notes slide the op made is taken back, and nothing else.
		act(() => {
			history.bump()
			answer({ ok: true, revision: 2, dirty: true })
		})

		await waitFor(() => {
			expect(retracts).toEqual([2])
		})
		expect(ops).toHaveLength(1)
	})

	it("notes opened and closed with Escape before the editor focused keep the file open and take back the empty notes", async () => {
		const history = historyScope()
		let made = false
		const { editor, retracts } = editorWith(
			() => ({
				slide: ref,
				format: "modern",
				comments: [],
				...(made ? { notes: { slide: slideRef(512), id: 3 }, notesBox: { x: 0, y: 0, width: 400, height: 200 } } : {}),
				can: { reply: true, resolve: true }
			}),
			() => {
				made = true
				history.bump()

				return { ok: true, revision: 2, dirty: true }
			}
		)

		render(
			history.scope(
				<PresentationNotesPane
					text=""
					phone={false}
					editor={editor}
				/>
			)
		)

		fireEvent.keyDown(await screen.findByRole("button", { name: "Click to add notes" }), { key: "Enter" })

		const page = await screen.findByLabelText("Notes page")

		expect(document.activeElement).toBe(page)
		expect(fireEvent.keyDown(page, { key: "Escape" })).toBe(false)

		await waitFor(() => {
			expect(retracts).toEqual([2])
		})
		// The read view again (the fake keeps answering the notes slide the undo took back).
		expect(await screen.findByRole("button", { name: "Speaker notes" })).toBeTruthy()
	})

	it("notes left by going to another slide are taken back, and coming back offers to start them again", async () => {
		const history = historyScope()
		const { editor, ops, retracts } = editorWith(
			{ slide: ref, format: "modern", comments: [], can: { reply: true, resolve: true } },
			() => {
				history.bump()

				return { ok: true, revision: 2, dirty: true }
			}
		)
		const pane = (render: SlideRender) =>
			history.scope(
				<PresentationNotesPane
					text=""
					phone={false}
					editor={{ ...editor, render }}
				/>
			)
		const here = renderOf()
		const view = render(pane(here))

		fireEvent.keyDown(await screen.findByRole("button", { name: "Click to add notes" }), { key: "Enter" })
		await waitFor(() => {
			expect(ops).toHaveLength(1)
		})

		view.rerender(pane({ ...renderOf(), ref: slideRef(512) }))
		await waitFor(() => {
			expect(retracts).toEqual([2])
		})

		view.rerender(pane(here))
		fireEvent.keyDown(await screen.findByRole("button", { name: "Click to add notes" }), { key: "Enter" })
		await waitFor(() => {
			expect(ops).toHaveLength(2)
		})
	})

	it("empty notes it started taken away under the open editor (an undo) close it, focus back on the notes", async () => {
		const history = historyScope()
		let made = false
		const { editor } = editorWith(
			() => ({
				slide: ref,
				format: "modern",
				comments: [],
				...(made ? { notes: { slide: slideRef(512), id: 3 }, notesBox: { x: 0, y: 0, width: 400, height: 200 } } : {}),
				can: { reply: true, resolve: true }
			}),
			() => {
				made = true
				history.bump()

				return { ok: true, revision: 2, dirty: false }
			}
		)

		render(
			history.scope(
				<PresentationNotesPane
					text=""
					phone={false}
					editor={editor}
				/>
			)
		)

		fireEvent.keyDown(await screen.findByRole("button", { name: "Click to add notes" }), { key: "Enter" })
		expect(await screen.findByLabelText("Notes page")).toBeTruthy()

		// The worker's undo took the notes back (and undid the step before them).
		made = false
		act(() => {
			history.bump()
		})

		const add = await screen.findByRole("button", { name: "Click to add notes" })

		await waitFor(() => {
			expect(document.activeElement).toBe(add)
		})
		expect(screen.queryByLabelText("Notes page")).toBeNull()
	})

	it("notes an undo took back before they opened end the opening: no key is held, and they can be started again", async () => {
		const history = historyScope()
		const { editor, ops } = editorWith(
			() => ({ slide: ref, format: "modern", comments: [], can: { reply: true, resolve: true } }),
			() => {
				history.bump()

				return { ok: true, revision: 2, dirty: false }
			}
		)

		render(
			history.scope(
				<PresentationNotesPane
					text=""
					phone={false}
					editor={editor}
				/>
			)
		)

		fireEvent.keyDown(await screen.findByRole("button", { name: "Click to add notes" }), { key: "Enter" })
		await waitFor(() => {
			expect(ops).toHaveLength(1)
		})
		// The undo (Mod+Z in the opening window) took the notes away before any review named them.
		act(() => {
			history.bump()
		})

		await waitFor(() => {
			const key = new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true })

			document.body.dispatchEvent(key)
			expect(key.defaultPrevented).toBe(false)
		})
		fireEvent.keyDown(await screen.findByRole("button", { name: "Click to add notes" }), { key: "Enter" })
		await waitFor(() => {
			expect(ops).toHaveLength(2)
		})
	})

	it("notes a save took back meanwhile (a new revision) are still given back to the worker when left", async () => {
		const history = historyScope()
		let made = false
		const { editor, retracts } = editorWith(
			() => ({
				slide: ref,
				format: "modern",
				comments: [],
				...(made ? { notes: { slide: slideRef(512), id: 3 }, notesBox: { x: 0, y: 0, width: 400, height: 200 } } : {}),
				can: { reply: true, resolve: true }
			}),
			() => {
				made = true
				history.bump()

				return { ok: true, revision: 2, dirty: false }
			}
		)

		render(
			history.scope(
				<PresentationNotesPane
					text=""
					phone={false}
					editor={editor}
				/>
			)
		)

		fireEvent.keyDown(await screen.findByRole("button", { name: "Click to add notes" }), { key: "Enter" })

		const page = await screen.findByLabelText("Notes page")

		// A save took them back (the worker still answers their body, so the editor stays): a new revision.
		act(() => {
			history.bump()
		})
		expect(screen.getByLabelText("Notes page")).toBe(page)

		fireEvent.keyDown(page, { key: "Escape" })

		await waitFor(() => {
			expect(retracts).toEqual([2])
		})
	})

	it("the open notes editor is not started again when their review is answered again for the same body", async () => {
		const history = historyScope()
		let made = false
		const { editor, seeds } = editorWith(
			() => ({
				slide: ref,
				format: "modern",
				comments: [],
				...(made ? { notes: { slide: slideRef(512), id: 3 }, notesBox: { x: 0, y: 0, width: 400, height: 200 } } : {}),
				can: { reply: true, resolve: true }
			}),
			() => {
				made = true
				history.bump()

				return { ok: true, revision: 2, dirty: false }
			}
		)

		render(
			history.scope(
				<PresentationNotesPane
					text=""
					phone={false}
					editor={editor}
				/>
			)
		)

		fireEvent.keyDown(await screen.findByRole("button", { name: "Click to add notes" }), { key: "Enter" })
		expect(await screen.findByLabelText("Notes page")).toBeTruthy()
		await waitFor(() => {
			expect(seeds).toHaveLength(1)
		})

		// A save (or any op) gives a new revision while the notes are still empty: they are asked for again.
		for (let k = 0; k < 3; k++)
			act(() => {
				history.bump()
			})

		await act(() => new Promise(resolve => setTimeout(resolve, 50)))
		expect(seeds).toHaveLength(1)
	})

	it("notes typed in and then undone by any path (the ribbon's Undo) close the editor, focus back on the notes", async () => {
		const history = historyScope()
		let notes: "none" | "typed" = "none"
		const { editor } = editorWith(
			() => ({
				slide: ref,
				format: "modern",
				comments: [],
				...(notes === "none" ? {} : { notes: { slide: slideRef(512), id: 3 }, notesBox: { x: 0, y: 0, width: 400, height: 200 } }),
				notesText: notes === "typed" ? "ALPHA three" : "",
				can: { reply: true, resolve: true }
			}),
			() => {
				notes = "typed"
				history.bump()

				return { ok: true, revision: 2, dirty: true }
			}
		)

		render(
			history.scope(
				<PresentationNotesPane
					text=""
					phone={false}
					editor={editor}
				/>
			)
		)

		fireEvent.keyDown(await screen.findByRole("button", { name: "Click to add notes" }), { key: "Enter" })
		expect(await screen.findByLabelText("Notes page")).toBeTruthy()

		// Typed in (a new revision with text), then undone from the ribbon (the notes go, a new revision).
		act(() => {
			history.bump()
		})
		await act(() => new Promise(resolve => setTimeout(resolve, 20)))
		notes = "none"
		act(() => {
			history.bump()
		})

		const add = await screen.findByRole("button", { name: "Click to add notes" })

		await waitFor(() => {
			expect(document.activeElement).toBe(add)
		})
		expect(screen.queryByLabelText("Notes page")).toBeNull()
	})
})
