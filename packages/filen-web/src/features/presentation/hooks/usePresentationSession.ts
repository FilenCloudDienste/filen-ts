import { createContext, use, useEffect, useState, type RefObject } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import * as Comlink from "comlink"
import {
	addSectionOp,
	addSlideOp,
	deleteSlidesOp,
	duplicateSlideOps,
	newSlideLayout,
	nudgeSlidesOp,
	moveSlidesOp,
	removeSectionOp,
	renameSectionOp,
	resetSlideOps,
	setLayoutOps,
	toggleHiddenOp,
	type DeckOp,
	type PresentationRefusal,
	type Section,
	type SlideRef
} from "@filen/office/core/presentation"
import {
	PresentationCallError,
	type CommandResult,
	type PresentationLayoutInfo,
	type PresentationSessionApi,
	type SaveResult
} from "@filen/office/dom/presentation"
import type { PresentationDocument, PresentationStore, ShowFrom } from "@filen/office/react/presentation"
import { narrowToAnyFile } from "@/features/drive/lib/download"
import { presentationSaveEdits, type PresentationSaveSource } from "@/features/drive/lib/previewSave.logic"
import { autosaveTier, type AutosaveTier } from "@/features/presentation/lib/autosavePolicy"
import { usePresentationAutosave } from "@/features/presentation/hooks/usePresentationAutosave"
import { sdkApi } from "@/lib/sdk/client"
import { log } from "@/lib/log"
import { useLatestRef } from "@/lib/useLatestRef"
import type { PreviewKey } from "@/lib/i18n"

// The presentation editor's session on the page: the slide in view and the rail's selection, the commands (every
// one an op the worker applies, refused with a typed reason the user is told), undo and redo, and the save the
// overlay asks for (the worker writes the package to the upload's port; this page never holds it). Its value is
// given to the ribbon's group files and the menus through PresentationEditorContext, so a group file stays a pure
// list of groups whose controls read the editor where they render.

export interface PresentationEditing {
	// Saving is possible now (false after a rename to another format, or a save that failed for good).
	readonly writable: boolean
	// Renamed to another format while open: its changes can't be saved to it.
	readonly renamed: boolean
	readonly onDirtyChange: (dirty: boolean) => void
	readonly saveRef: RefObject<PresentationSaveSource | null>
	// Asks the overlay to save (File ▸ Save, an idle autosave); true when a save started.
	readonly onSave: () => boolean
	readonly onAutosave: () => boolean
}

export interface PresentationEditor {
	readonly store: PresentationStore
	readonly document: PresentationDocument
	// Commands are possible: the deck opened editable, the file may be saved, and no view-only reason holds.
	readonly editable: boolean
	// The slide in view, and its ref.
	readonly current: number
	readonly currentRef: SlideRef | undefined
	// The rail's selection in deck order (always holding the current slide while the deck has one).
	readonly selection: readonly SlideRef[]
	readonly selectedIndices: ReadonlySet<number>
	readonly layouts: readonly PresentationLayoutInfo[]
	// The layout of the slide in view, once it rendered.
	readonly currentLayout: SlideRef | undefined
	readonly canUndo: boolean
	readonly canRedo: boolean
	readonly autosave: { readonly tier: AutosaveTier; readonly active: boolean }
	// A save is in flight.
	readonly saving: boolean
	go: (index: number) => void
	extend: (index: number, mode: "range" | "toggle") => void
	selectAll: () => void
	// One op through the session; a refusal is told (a toast) before the answer resolves.
	command: (op: DeckOp) => Promise<CommandResult>
	// Runs ops in order (each its own step); `select`: the slide shown once they applied. False when one was refused.
	run: (ops: DeckOp | readonly DeckOp[], select?: number) => Promise<boolean>
	undo: () => void
	redo: () => void
	readonly slides: PresentationSlideCommands
	// What the overlay's save calls (the editor puts it in the overlay's ref while the deck can be saved).
	readonly saveSource: PresentationSaveSource | undefined
}

// The slide commands on the selection (the rail's, the ribbon's and the keys').
export interface PresentationSlideCommands {
	// A new slide after the current one, on `layout` or the one PowerPoint would pick.
	readonly add: (layout?: SlideRef) => void
	readonly duplicate: () => void
	readonly remove: () => void
	readonly toggleHidden: () => void
	readonly setLayout: (layout: SlideRef) => void
	readonly reset: () => void
	readonly nudge: (step: -1 | 1 | "first" | "last") => void
	// The selection dropped before slide `before`.
	readonly moveTo: (before: number) => void
	// The section the current slide is in.
	readonly section: Section | undefined
	readonly addSection: (name: string) => void
	readonly renameSection: (name: string) => void
	readonly removeSection: () => void
}

// What the editor's frame shows, for the View tab and the menus.
export interface PresentationEditorView {
	readonly railOpen: boolean
	readonly notesOpen: boolean
	readonly toggleRail: () => void
	readonly toggleNotes: () => void
	readonly startShow: () => void
	// From a slide or as a custom show (the show's first slide without one), and with the presenter view (the Slide
	// Show tab).
	readonly startShowFrom: (from?: ShowFrom) => void
	readonly startPresenter?: (from: ShowFrom) => void
	// Saves now (the overlay's save, as Mod+S).
	readonly save: () => void
	// Opens the section dialog for a new section at the current slide, or to rename its section.
	readonly askSection: (mode: "add" | "rename") => void
	// Opens the find field in place of the command row (with its replace field).
	readonly openFind: (replace: boolean) => void
}

export interface PresentationEditorScope {
	readonly editor: PresentationEditor
	readonly view: PresentationEditorView
}

export const PresentationEditorContext = createContext<PresentationEditorScope | null>(null)

// The editor around a ribbon control or menu entry; undefined outside one (the viewer's command bar).
export function usePresentationEditor(): PresentationEditorScope | undefined {
	return use(PresentationEditorContext) ?? undefined
}

// A new section's id as PresentationML writes one ({GUID}, upper case).
function newSectionId(): string {
	return `{${crypto.randomUUID().toUpperCase()}}`
}

// The section a slide is in: the one listing it, else (a slide before the first section's own) the first.
export function sectionOf(sections: readonly Section[], ref: SlideRef | undefined): Section | undefined {
	if (ref === undefined || sections.length === 0) {
		return undefined
	}

	return sections.find(section => section.slides.includes(ref)) ?? sections[0]
}

const REFUSAL_KEYS: Partial<Record<PresentationRefusal, PreviewKey>> = {
	viewOnly: "previewPptxEditorRefusedViewOnly",
	locked: "previewPptxEditorRefusedLocked",
	notImplemented: "previewPptxEditorRefusedUnsupported",
	unsupported: "previewPptxEditorRefusedUnsupported",
	tooLarge: "previewPptxEditorRefusedTooLarge",
	tooDeep: "previewPptxEditorRefusedTooLarge",
	stale: "previewPptxEditorRefusedStale",
	notFound: "previewPptxEditorRefusedStale",
	malformed: "previewPptxEditorRefusedMalformed"
}

// A command the session could not answer: the reason a worker call error carries (a session closed meanwhile), else
// "failed".
export function commandFailure(error: unknown): CommandResult {
	return { ok: false, refusal: error instanceof PresentationCallError ? error.reason : "failed" }
}

// Whether a refusal is told: not one a closed session gave (the file closed meanwhile; nothing the user did was refused).
export function refusalToTell(refusal: PresentationRefusal): boolean {
	return refusal !== "closed"
}

export function refusalKey(refusal: PresentationRefusal): PreviewKey {
	return REFUSAL_KEYS[refusal] ?? "previewPptxEditorRefused"
}

const NO_LAYOUTS: readonly PresentationLayoutInfo[] = []

function opList(ops: DeckOp | readonly DeckOp[]): readonly DeckOp[] {
	return "family" in ops ? [ops] : ops
}

// The text editing store as the session path needs it (react/presentation's TextEditing): the open body's pending text
// is sent before any other command, undo, redo or save, and undo/redo with a body open are its own.
export interface PresentationTextFlush {
	readonly active: { undo(): Promise<CommandResult>; redo(): Promise<CommandResult> } | undefined
	flush(): Promise<void>
	// A command through the session after the open body's pending text, naming the body so its answer reseeds it.
	command(op: DeckOp, session: PresentationSessionApi): Promise<CommandResult>
}

export interface PresentationSessionInput {
	readonly store: PresentationStore
	readonly text?: PresentationTextFlush
	readonly document: PresentationDocument
	// The file may be saved here now, and no reason outside the deck keeps it view-only.
	readonly writable: boolean
	// Asks the overlay to save (an idle autosave); undefined: nothing autosaves (a view-only deck).
	readonly onAutosave: (() => boolean) | undefined
}

export function usePresentationSession({
	store,
	document: deck,
	text,
	writable,
	onAutosave
}: PresentationSessionInput): PresentationEditor {
	const { t } = useTranslation("preview")
	const [currentState, setCurrentState] = useState<{ readonly ref: SlideRef | undefined; readonly index: number }>({
		ref: undefined,
		index: 0
	})
	// Selected besides the current slide, and where a Shift range starts.
	const [extra, setExtra] = useState<{ readonly refs: ReadonlySet<SlideRef>; readonly anchor: SlideRef | undefined }>({
		refs: new Set(),
		anchor: undefined
	})
	const [saving, setSaving] = useState(false)
	// The saved file's range port belongs to this editor: closed when it unmounts.
	const [token] = useState(() => crypto.randomUUID())
	const slides = deck.slides
	const count = slides.length
	const found = currentState.ref === undefined ? -1 : slides.findIndex(slide => slide.ref === currentState.ref)
	const current = found >= 0 ? found : Math.min(currentState.index, Math.max(0, count - 1))
	const currentRef = slides[current]?.ref

	// The slide in view is followed by its ref, so a move, an add or a delete before it keeps it in view; the first
	// slide list (and a deleted current slide) gives it one.
	if (currentRef !== undefined && currentState.ref !== currentRef) {
		setCurrentState({ ref: currentRef, index: current })
	}
	const info = deck.info
	const editable = writable && info?.editable === true
	const present = new Set(slides.map(slide => slide.ref))
	const selection: SlideRef[] = []
	const selectedIndices = new Set<number>()

	slides.forEach((slide, index) => {
		if (index === current || extra.refs.has(slide.ref)) {
			selection.push(slide.ref)
			selectedIndices.add(index)
		}
	})

	const tier = autosaveTier(info?.packageBytes ?? 0, info?.protection.encrypted ?? false)
	const autosave = usePresentationAutosave({
		tier,
		revision: deck.revision,
		dirty: deck.dirty,
		dirtyBytes: deck.dirtyBytes,
		canSave: editable && !saving,
		onAutosave
	})
	const settled = useLatestRef(autosave.settled)

	// The overlay's save asks the session for one save at a time; how it ended feeds the autosave times.
	const session = deck.session
	const saveSource: PresentationSaveSource | undefined =
		session === undefined
			? undefined
			: async ({ auto }) => {
					await text?.flush()

					const edits = presentationSaveEdits(
						session,
						(port, file) => {
							void sdkApi
								.openRangePort(Comlink.transfer(port, [port]), narrowToAnyFile(file), token)
								.catch((error: unknown) => {
									log.warn("presentation", "the saved file's range port did not open", { error })
								})
						},
						auto
					)

					setSaving(true)
					void edits.result
						.catch((): SaveResult => ({ kind: "refused", reason: "failed" }))
						.then(result => {
							setSaving(false)
							settled.current({ stored: result.kind === "written", failed: result.kind === "refused" })
						})

					return edits
				}

	useEffect(
		() => () => {
			void sdkApi.cancelPreviewDownload(token)
		},
		[token]
	)

	const go = (index: number): void => {
		if (count === 0) {
			return
		}

		const clamped = Math.min(Math.max(0, index), count - 1)

		setCurrentState({ ref: slides[clamped]?.ref, index: clamped })
		setExtra({ refs: new Set(), anchor: slides[clamped]?.ref })
	}

	const extend = (index: number, mode: "range" | "toggle"): void => {
		const target = slides[index]?.ref

		if (target === undefined) {
			return
		}

		if (mode === "toggle") {
			const refs = new Set(extra.refs)

			if (index === current) {
				// The current slide leaves the selection: the next selected one becomes current.
				const next = selection.find(ref => ref !== target)

				if (next === undefined) {
					return
				}

				refs.delete(next)
				setCurrentState({ ref: next, index: slides.findIndex(slide => slide.ref === next) })
				setExtra({ refs, anchor: next })

				return
			}

			if (refs.has(target)) {
				refs.delete(target)
			} else {
				refs.add(target)
			}

			setExtra({ refs, anchor: target })
			setCurrentState({ ref: currentRef, index: current })

			return
		}

		const anchorIndex = extra.anchor === undefined ? current : slides.findIndex(slide => slide.ref === extra.anchor)
		const from = Math.min(anchorIndex < 0 ? current : anchorIndex, index)
		const to = Math.max(anchorIndex < 0 ? current : anchorIndex, index)
		const refs = new Set<SlideRef>()

		for (let at = from; at <= to; at++) {
			const ref = slides[at]?.ref

			if (ref !== undefined) {
				refs.add(ref)
			}
		}

		setCurrentState({ ref: target, index })
		setExtra({ refs, anchor: extra.anchor ?? currentRef })
	}

	const selectAll = (): void => {
		setExtra({ refs: present, anchor: currentRef })
	}

	// One op through the session; a refusal is told before the answer resolves.
	const command = async (op: DeckOp): Promise<CommandResult> => {
		if (session === undefined || !editable) {
			return { ok: false, refusal: "viewOnly" }
		}

		const result = await (text === undefined ? session.command(op) : text.command(op, session)).catch(
			(error: unknown): CommandResult => {
				log.warn("presentation", "a command failed", { error })

				return commandFailure(error)
			}
		)

		if (!result.ok && refusalToTell(result.refusal)) {
			toast.error(t(refusalKey(result.refusal)))
		}

		return result
	}

	const run = async (ops: DeckOp | readonly DeckOp[], select?: number): Promise<boolean> => {
		const list = opList(ops)

		if (session === undefined || !editable || list.length === 0) {
			return false
		}

		for (const op of list) {
			if (!(await command(op)).ok) {
				return false
			}
		}

		if (select !== undefined) {
			const index = Math.max(0, select)

			// The slide list the store holds after the ops' "changed" events (they arrive before the answers).
			const now = store.getSnapshot().slides

			setCurrentState({ ref: now[Math.min(index, now.length - 1)]?.ref, index })
			setExtra({ refs: new Set(), anchor: undefined })
		}

		return true
	}

	const step = (direction: "undo" | "redo"): void => {
		if (session === undefined || !editable) {
			return
		}

		const open = text?.active
		// A body open in the text editor: its own step (it sends its text first and reseeds from the answer).
		const stepped =
			open === undefined ? (direction === "undo" ? session.undo() : session.redo()) : direction === "undo" ? open.undo() : open.redo()

		void stepped
			.then(result => {
				if (!result.ok) {
					toast.error(t(refusalKey(result.refusal)))
				}
			})
			.catch((error: unknown) => {
				log.warn("presentation", `${direction} failed`, { error })
			})
	}

	const order = slides.map(slide => slide.ref)
	const sections = info?.sections ?? []
	const section = sectionOf(sections, currentRef)
	const firstSelected = selection[0] === undefined ? current : slides.findIndex(slide => slide.ref === selection[0])
	const lastSelected = selection.length === 0 ? current : slides.findIndex(slide => slide.ref === selection.at(-1))
	const commands: PresentationSlideCommands = {
		add: layout => {
			const chosen =
				layout ??
				newSlideLayout(info?.layouts ?? NO_LAYOUTS, currentRef === undefined ? undefined : deck.renders.get(currentRef)?.layout)

			if (chosen !== undefined) {
				void run(addSlideOp(count === 0 ? 0 : current + 1, chosen), count === 0 ? 0 : current + 1)
			}
		},
		duplicate: () => {
			const ops = duplicateSlideOps(order, selection)

			void run(ops, lastSelected + 1)
		},
		remove: () => {
			const op = deleteSlidesOp(order, selection)

			if (op !== undefined) {
				void run(op, Math.max(0, Math.min(firstSelected, count - op.slides.length - 1)))
			}
		},
		toggleHidden: () => {
			const op = toggleHiddenOp(slides, selection)

			if (op !== undefined) {
				void run(op)
			}
		},
		setLayout: layout => {
			void run(setLayoutOps(order, selection, layout))
		},
		reset: () => {
			void run(resetSlideOps(order, selection))
		},
		nudge: step => {
			const op = nudgeSlidesOp(order, selection, step)

			if (op !== undefined) {
				void run(op)
			}
		},
		moveTo: before => {
			const op = moveSlidesOp(order, selection, before)

			if (op !== undefined) {
				void run(op)
			}
		},
		section,
		addSection: name => {
			const op = addSectionOp(
				order,
				sections,
				current,
				{ id: newSectionId(), name: name.trim() === "" ? t("previewPptxEditorUntitledSection") : name.trim() },
				t("previewPptxEditorDefaultSection"),
				newSectionId()
			)

			if (op !== undefined) {
				void run(op)
			}
		},
		renameSection: name => {
			const op = section === undefined ? undefined : renameSectionOp(sections, section.id, name)

			if (op !== undefined) {
				void run(op)
			}
		},
		removeSection: () => {
			const op = section === undefined ? undefined : removeSectionOp(order, sections, section.id)

			if (op !== undefined) {
				void run(op)
			}
		}
	}

	return {
		store,
		document: deck,
		saveSource,
		slides: commands,
		editable,
		current,
		currentRef,
		selection,
		selectedIndices,
		layouts: info?.layouts ?? NO_LAYOUTS,
		currentLayout: currentRef === undefined ? undefined : deck.renders.get(currentRef)?.layout,
		canUndo: editable && deck.canUndo,
		canRedo: editable && deck.canRedo,
		autosave: { tier, active: autosave.active },
		saving,
		go,
		extend,
		selectAll,
		command,
		run,
		undo: () => {
			step("undo")
		},
		redo: () => {
			step("redo")
		}
	}
}
