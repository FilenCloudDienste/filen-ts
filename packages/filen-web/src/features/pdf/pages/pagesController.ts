import type { TFunction } from "i18next"
import type { AnyFile } from "@filen/sdk-rs"
import { deleteOrder, rangesToPages } from "@filen/office/core/pdfedit/pageOrder"
import type { PageRange } from "@filen/office/core/pdfedit/pageRanges"
import { preparedPassword } from "@filen/office/core/pdfedit/security"
import type { PdfCommandResult, PdfMemoryProfile } from "@filen/office/core/pdfedit"
import type { CropMargins, CropRect } from "@filen/office/core/pdfedit/crop"
import { createSyncRangeBuffer, PdfEngineError, serveSyncRange, type PdfByteChannel, type PdfEngineArgs } from "@filen/office/dom/pdfedit"
import type { PdfEditSessionModel } from "@filen/office/react/pdfedit"
import { BLOCK_BYTES } from "@filen/shared/videos"
import type { DriveItem } from "@/features/drive/lib/item"
import type { PreviewAccessMode } from "@/features/preview/lib/accessMode"
import type { PdfEngine } from "@/features/pdf/session/engineWorker"
import { checkHeldOutput, serveHeldOutput, streamHeldOutput } from "@/features/pdf/save/pdfSave"
import { pageChangeAnnouncement, remapSelection, type PageChange } from "@/features/pdf/pages/organise.logic"
import type { CopySuffix } from "@/features/pdf/pages/names"
import { openSyncRange, syncRangeSlots } from "@/lib/media/syncRange"
import type { ActionOutcome } from "@/lib/actions/outcome"
import { log } from "@/lib/log"

// The pages rail's and Organise grid's state (stable page ids, the current page, the selection, the live region's
// sentence, thumbnails to draw again), and the page operations the tools run: each change one engine command through
// the editor session (started on first use), new files of pages (split, one file per page) made one at a time in the
// engine, checked by a verifying engine and uploaded beside the PDF, extracted pages opened as a new unsaved document
// (a draft: a second editing engine reads it from the first one's heap; saved as a copy beside the PDF, or dropped),
// and second PDFs read for inserting through their own sync range channel (from the drive, or a file on this device
// read in slices). A view subscribes (useSyncExternalStore).

export interface PdfPagesView {
	// Per page, an id kept across moves (a moved page keeps its thumbnail).
	readonly ids: readonly string[]
	// 0-based.
	readonly current: number
	readonly selected: ReadonlySet<number>
	readonly announcement: string
	// Ids whose thumbnails are to be drawn again.
	readonly changed: readonly string[]
	// The tags notice is due (shown once per session).
	readonly taggedNotice: boolean
	// A second PDF asks for its password.
	readonly password: { readonly attempt: "initial" | "retry" } | null
	// New files being saved: done of all.
	readonly progress: { readonly done: number; readonly count: number } | undefined
	// The crop drawn on a page (points, as the view shows the page), null before one is drawn.
	readonly crop: PdfCropDraft | null
	// The extracted pages open as a new document, null when none is.
	readonly draft: PdfDraft | null
}

// Extracted pages as a new document, saved nowhere yet: the engine that made it holds its bytes (the one copy) and
// serves them to the draft's own editing engine until the draft is saved (as a copy beside the PDF) or dropped.
export interface PdfDraft {
	readonly id: number
	readonly size: number
	readonly pageCount: number
	// The new file's name: the PDF's with this suffix ("report (pages 3-5).pdf").
	readonly suffix: CopySuffix
	// What the new document opens with (undefined: it is not encrypted).
	readonly password: string | undefined
	// Opens the draft's editing engine (again after a failed start).
	readonly open: (onPoisoned: (message: string) => void) => Promise<PdfEngine>
}

// A crop being drawn: its page, the page's box and the crop in points, as the view shows the page.
export interface PdfCropDraft {
	readonly page: number
	readonly bounds: CropRect
	readonly rect: CropRect
}

// A second PDF to insert.
export type PdfInsertSource = { readonly kind: "drive"; readonly file: AnyFile } | { readonly kind: "device"; readonly file: File }

// A new file to make: its pages (1-based ranges) and the suffix its name gets.
export interface PdfCopyFile {
	readonly ranges: readonly PageRange[]
	readonly suffix: CopySuffix
}

export type PdfCopyWrite = (
	content: { readonly port: MessagePort; readonly size: number },
	suffix: CopySuffix
) => Promise<{ outcome: ActionOutcome<DriveItem>; name: string } | null>

// What the controller works with, bound by the viewer on every render.
export interface PdfPagesHost {
	readonly t: TFunction<"preview">
	// Runs a change on the editor session (starting the editor first; a failure is reported by the host); `dropped` runs
	// instead when it never will (the editor did not start).
	readonly edit: (change: (session: PdfEditSessionModel) => Promise<unknown>, dropped?: () => void) => void
	readonly access: PreviewAccessMode
	// The password the PDF was opened with (memory only), undefined without one.
	readonly password: () => string | undefined
	readonly memory: () => PdfMemoryProfile
	readonly openVerifier: (channel: PdfByteChannel, password: string | undefined) => Promise<PdfEngine>
	// Opens an editing engine on a new document another engine serves (a draft).
	readonly openEditor: (
		channel: PdfByteChannel,
		password: string | undefined,
		onPoisoned: (message: string) => void
	) => Promise<PdfEngine>
	// Uploads a new file beside the PDF (writeEditedCopy).
	readonly write: PdfCopyWrite
	readonly fileSize: number
	readonly onCopied: (names: readonly string[], items: readonly DriveItem[]) => void
	readonly onFailed: (
		key:
			| "previewPdfExtractFailed"
			| "previewPdfSplitFailed"
			| "previewPdfPagesInsertFileFailed"
			| "previewPdfPagesInsertImageFailed"
			| "previewPdfPagesLastPage"
			| "previewPdfOverBudget"
	) => void
}

// The engine refused a change that would grow the document past what this browser edits.
function overBudget(error: unknown): boolean {
	return error instanceof PdfEngineError && error.failure === "overBudget"
}

// The largest picture inserted as a page (bytes).
export const PDF_INSERT_IMAGE_MAX_BYTES = 64 * 1024 * 1024

let nextId = 0
let nextDraft = 0

function newIds(count: number): string[] {
	return Array.from({ length: count }, () => `p${String(++nextId)}`)
}

// Per page of the result, the old index it came from (-1: new).
function insertFrom(count: number, at: number, added: number): number[] {
	const from = Array.from({ length: count }, (_, index) => index)

	from.splice(at, 0, ...Array.from({ length: added }, () => -1))

	return from
}

function duplicateFrom(count: number, pages: readonly number[]): number[] {
	const duplicated = new Set(pages)
	const from: number[] = []

	for (let page = 0; page < count; page++) {
		from.push(page)

		if (duplicated.has(page)) from.push(-1)
	}

	return from
}

interface HeldChannel {
	readonly channel: PdfByteChannel
	close(): void
}

// A file on this device served to the engine in slices (never read whole on the page).
function deviceChannel(file: File): HeldChannel {
	const buffer = createSyncRangeBuffer(syncRangeSlots(), BLOCK_BYTES)
	const { port1, port2 } = new MessageChannel()
	const lifetime = new AbortController()

	serveSyncRange(
		buffer,
		port2,
		{
			length: file.size,
			read: (start, end) =>
				file
					.slice(start, end)
					.arrayBuffer()
					.then(bytes => new Uint8Array(bytes))
		},
		{
			lifetime: lifetime.signal,
			readAhead: 2,
			onReaderClose: () => {
				lifetime.abort()
			}
		}
	)

	return {
		channel: { buffer, port: port1, length: file.size },
		close: () => {
			lifetime.abort()
			port2.close()
		}
	}
}

export class PdfPagesController {
	private host: PdfPagesHost | null = null
	private navigator: ((index: number) => void) | null = null
	// The current page was chosen (in the rail, by a page change) rather than scrolled to.
	private chosen = false
	// The selection changed in this task: a page chosen with it keeps it.
	private extended = false
	private view: PdfPagesView = {
		ids: [],
		current: 0,
		selected: new Set(),
		announcement: "",
		changed: [],
		taggedNotice: false,
		password: null,
		progress: undefined,
		crop: null,
		draft: null
	}
	// Ends the open draft: whether it was saved.
	private draftEnd: ((saved: boolean) => void) | null = null
	private readonly listeners = new Set<() => void>()
	private taggedShown = false
	private passwordAnswer: ((password: string | null) => void) | null = null
	// Channels of the second PDFs the engine holds open, closed with the session they belong to.
	private sources: { readonly session: PdfEditSessionModel; readonly channel: HeldChannel }[] = []

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener)

		return () => {
			this.listeners.delete(listener)
		}
	}

	getSnapshot = (): PdfPagesView => this.view

	private set(patch: Partial<PdfPagesView>): void {
		this.view = { ...this.view, ...patch }

		for (const listener of this.listeners) listener()
	}

	bind(host: PdfPagesHost): void {
		this.host = host
	}

	// How the viewer shows a page (0-based), set by the viewer while it shows the document.
	setNavigator(navigate: ((index: number) => void) | null): void {
		this.navigator = navigate
	}

	private navigate(index: number): void {
		this.navigator?.(index)
	}

	// The document's page count as the view shows it: ids follow it (new ones when it changed some other way than
	// through this controller, an undo or redo).
	sync(count: number): void {
		if (this.view.ids.length === count) return

		this.set({
			ids: newIds(count),
			selected: new Set([...this.view.selected].filter(page => page < count)),
			current: Math.min(this.view.current, Math.max(0, count - 1))
		})
	}

	// The editor's session ended or changed (a new engine): the second PDFs it held are gone with it.
	sessionChanged(session: PdfEditSessionModel | null): void {
		const keep = this.sources.filter(source => source.session === session)

		for (const source of this.sources) if (source.session !== session) source.channel.close()

		this.sources = keep
	}

	setCurrent(index: number): void {
		this.chosen = false

		if (index !== this.view.current) this.set({ current: index })
	}

	// The page the viewer shows most of. A page just chosen in the rail stays current while it is still in view: near
	// the end of a document the view cannot bring it to the top, so another page shows more of itself.
	viewerPage(index: number, visible: (page: number) => boolean): void {
		if (this.chosen && index !== this.view.current && visible(this.view.current)) return

		this.setCurrent(index)
	}

	// The selection as the rail or the grid changed it (a range or a toggle, which may make its page the current one).
	select(selected: ReadonlySet<number>): void {
		this.extended = true
		this.set({ selected })
		queueMicrotask(() => {
			this.extended = false
		})
	}

	// A thumbnail chosen: it becomes the current page, alone unless the selection was just extended to it (Shift with a
	// click or an arrow).
	choose(index: number): void {
		const extended = this.extended

		this.extended = false
		this.chosen = true
		this.set({ current: index, selected: extended && this.view.selected.has(index) ? this.view.selected : new Set() })
		this.navigate(index)
	}

	invalidate(ids: readonly string[]): void {
		if (ids.length > 0) this.set({ changed: ids })
	}

	setCrop(crop: PdfCropDraft | null): void {
		this.set({ crop })
	}

	dismissTagged(): void {
		this.set({ taggedNotice: false })
	}

	answerPassword(password: string | null): void {
		const answer = this.passwordAnswer

		this.passwordAnswer = null
		this.set({ password: null })
		answer?.(password)
	}

	// The pages a page action applies to: the selection, or the current page.
	targets(): number[] {
		const { selected, current } = this.view

		return selected.size > 0 ? [...selected].sort((a, b) => a - b) : [current]
	}

	// After a change: ids moved with their pages (`from`), the selection with them, the touched pages' thumbnails
	// redrawn, the sentence for the live region, the tags notice once.
	private changed(result: PdfCommandResult, from: readonly number[], change: PageChange, current?: number): void {
		const fresh = newIds(from.length)
		const ids = from.map((old, index) => (old >= 0 ? (this.view.ids[old] ?? fresh[index] ?? "") : (fresh[index] ?? "")))
		const changed = result.pages.map(page => ids[page]).filter((id): id is string => id !== undefined)
		const host = this.host
		const tagged = result.state.tagged && !this.taggedShown

		if (tagged) this.taggedShown = true
		if (current !== undefined) this.chosen = true

		this.set({
			ids,
			selected: remapSelection(this.view.selected, from),
			changed,
			current: current ?? Math.min(this.view.current, Math.max(0, ids.length - 1)),
			announcement: host === null ? "" : pageChangeAnnouncement(host.t, change),
			...(tagged ? { taggedNotice: true } : {})
		})
	}

	private run(change: (session: PdfEditSessionModel) => Promise<unknown>, dropped?: () => void): void {
		this.host?.edit(change, dropped)
	}

	rotate(pages: readonly number[], degrees: 90 | -90): void {
		this.run(async session => {
			const result = await session.dispatch("pages.rotate", { pages, degrees })

			this.changed(
				result,
				this.view.ids.map((_, index) => index),
				{ kind: "rotated", pages }
			)
		})
	}

	remove(pages: readonly number[]): void {
		if (pages.length >= this.view.ids.length) {
			this.host?.onFailed("previewPdfPagesLastPage")

			return
		}

		this.run(async session => {
			const count = session.getSnapshot().state.pageCount
			const result = await session.dispatch("pages.delete", { pages })

			this.changed(result, deleteOrder(count, pages), { kind: "deleted", pages })
		})
	}

	duplicate(pages: readonly number[]): void {
		this.run(async session => {
			const count = session.getSnapshot().state.pageCount
			const result = await session.dispatch("pages.duplicate", { pages })

			this.changed(result, duplicateFrom(count, pages), { kind: "duplicated", pages })
		})
	}

	// `order`: every old index once, in the new order.
	move(order: readonly number[]): void {
		const moved = this.targets()

		this.run(async session => {
			const result = await session.dispatch("pages.move", { order })
			const position = order.indexOf(moved[0] ?? 0)
			const current = Math.max(0, order.indexOf(this.view.current))

			// The current page goes on being the one in view, where it now stands.
			this.changed(result, order, { kind: "moved", pages: moved, position }, current)
			this.navigate(current)
		})
	}

	// Crops `pages` by `margins` (points off each side of each page as it shows); `removeOutside` also deletes what
	// lies outside.
	crop(pages: readonly number[], margins: CropMargins, removeOutside: boolean): void {
		this.run(async session => {
			const result = removeOutside
				? await session.dispatch("crop.removeOutside", { pages, margins })
				: await session.dispatch("crop.set", { pages, margins })

			this.cropped(result)
		})
	}

	// Crops each page to what it draws.
	cropToContent(pages: readonly number[]): void {
		this.run(async session => {
			this.cropped(await session.dispatch("crop.toContent", { pages, padding: 0 }))
		})
	}

	private cropped(result: PdfCommandResult): void {
		const host = this.host
		const count = result.pages.length

		this.changed(
			result,
			this.view.ids.map((_, index) => index),
			{ kind: "rotated", pages: result.pages }
		)
		this.set({
			crop: null,
			announcement: host === null || count === 0 ? "" : host.t("previewPdfPagesCropped", { count, page: (result.pages[0] ?? 0) + 1 })
		})
	}

	// New pages go after the current one.
	private insertAt(): number {
		return Math.min(this.view.ids.length, this.view.current + 1)
	}

	insertBlank(): void {
		const at = this.insertAt()

		this.run(async session => {
			const count = session.getSnapshot().state.pageCount
			const result = await session.dispatch("pages.insertBlank", { at, count: 1 })

			this.changed(result, insertFrom(count, at, 1), { kind: "inserted", count: 1, position: at }, at)
			this.navigate(at)
		})
	}

	insertImage(file: File): void {
		if (file.size > PDF_INSERT_IMAGE_MAX_BYTES || file.size === 0) {
			this.host?.onFailed("previewPdfPagesInsertImageFailed")

			return
		}

		const at = this.insertAt()

		this.run(async session => {
			const bytes = new Uint8Array(await file.arrayBuffer())
			const count = session.getSnapshot().state.pageCount
			const result = await session.dispatch("pages.insertImage", { at, bytes }).catch((error: unknown) => {
				log.warn("pdf", "inserting a picture failed", { error })
				this.host?.onFailed(overBudget(error) ? "previewPdfOverBudget" : "previewPdfPagesInsertImageFailed")

				return null
			})

			if (result === null) return

			this.changed(result, insertFrom(count, at, 1), { kind: "inserted", count: 1, position: at }, at)
			this.navigate(at)
		})
	}

	private askPassword(attempt: "initial" | "retry"): Promise<string | null> {
		this.passwordAnswer?.(null)

		return new Promise(resolve => {
			this.passwordAnswer = resolve
			this.set({ password: { attempt } })
		})
	}

	private async openChannel(source: PdfInsertSource): Promise<HeldChannel> {
		if (source.kind === "device") return deviceChannel(source.file)

		const host = this.host

		if (host === null) throw new Error("no host")

		const handle = await openSyncRange(source.file, host.access, crypto.randomUUID())

		return {
			channel: handle.channel,
			close: () => {
				handle.close()
			}
		}
	}

	// Every page of a second PDF, after the current page. An encrypted one asks for its password (again after a wrong
	// one); cancelling inserts nothing.
	insertPdf(source: PdfInsertSource): void {
		const at = this.insertAt()

		this.run(async session => {
			let password: string | undefined

			for (let attempt = 0; ; attempt++) {
				const held = await this.openChannel(source)
				const args: PdfEngineArgs<"attachSource"> = { channel: held.channel, ...(password === undefined ? {} : { password }) }
				const attached = await session.engine.call("attachSource", args, [held.channel.port]).catch((error: unknown) => {
					held.close()
					log.warn("pdf", "opening a PDF to insert failed", { error })
					this.host?.onFailed(overBudget(error) ? "previewPdfOverBudget" : "previewPdfPagesInsertFileFailed")

					return null
				})

				if (attached === null) return

				if (attached.status === "open") {
					this.sources.push({ session, channel: held })

					const count = session.getSnapshot().state.pageCount
					const pages = Array.from({ length: attached.pageCount }, (_, index) => index)
					const result = await session
						.dispatch("pages.insertFrom", { at, source: attached.source, pages })
						.catch((error: unknown) => {
							log.warn("pdf", "inserting pages failed", { error })
							this.host?.onFailed(overBudget(error) ? "previewPdfOverBudget" : "previewPdfPagesInsertFileFailed")

							return null
						})

					if (result === null) {
						void session.engine.call("detachSource", { source: attached.source }).catch(() => undefined)

						return
					}

					this.changed(result, insertFrom(count, at, pages.length), { kind: "inserted", count: pages.length, position: at }, at)
					this.navigate(at)

					return
				}

				held.close()

				const answer = await this.askPassword(attempt === 0 ? "initial" : "retry")

				if (answer === null) return

				password = answer
			}
		})
	}

	// The password new files would carry cannot be (an AES-256 file takes SASLprep'd passwords only).
	passwordUnsupported(): boolean {
		const password = this.host?.password()

		return password !== undefined && !preparedPassword(password).ok
	}

	// New files of pages beside the PDF, one at a time: written in the engine, checked by a verifying engine, uploaded.
	// Then the pages in `deletes` go from this PDF (only when every file was saved).
	makeCopies(
		files: readonly PdfCopyFile[],
		options: {
			readonly protect: boolean
			readonly deletes: readonly number[]
			readonly failedKey: "previewPdfExtractFailed" | "previewPdfSplitFailed"
		}
	): Promise<boolean> {
		const done = Promise.withResolvers<boolean>()

		this.set({ progress: { done: 0, count: files.length } })
		this.run(async session => {
			const saved = await this.copies(session, files, options.protect).catch((error: unknown) => {
				log.warn("pdf", "making new files of pages failed", { error })

				return null
			})

			this.set({ progress: undefined })

			if (saved === null) {
				this.host?.onFailed(options.failedKey)
				done.resolve(false)

				return
			}

			this.host?.onCopied(
				saved.map(entry => entry.name),
				saved.map(entry => entry.item)
			)

			if (options.deletes.length > 0) {
				const count = session.getSnapshot().state.pageCount
				const result = await session.dispatch("pages.delete", { pages: options.deletes })

				this.changed(result, deleteOrder(count, options.deletes), { kind: "deleted", pages: options.deletes })
			}

			done.resolve(true)
		})

		return done.promise
	}

	// Extracted pages as a new unsaved document (the draft view shows it): written in the engine and checked by a
	// verifying engine, then held there while the draft is open. The pages in `deletes` go from this PDF only once the
	// draft was saved. Resolves whether the draft opened.
	openDraft(file: PdfCopyFile, options: { readonly protect: boolean; readonly deletes: readonly number[] }): Promise<boolean> {
		const opened = Promise.withResolvers<boolean>()

		this.set({ progress: { done: 0, count: 1 } })
		this.run(
			async session => {
				const saved = await this.heldDraft(session, file, options.protect, () => {
					opened.resolve(true)
				}).catch((error: unknown) => {
					log.warn("pdf", "extracting pages failed", { error })

					return null
				})

				this.set({ progress: undefined, draft: null })

				if (saved === null) {
					this.host?.onFailed("previewPdfExtractFailed")
					opened.resolve(false)

					return
				}

				if (saved && options.deletes.length > 0) {
					const count = session.getSnapshot().state.pageCount
					const result = await session.dispatch("pages.delete", { pages: options.deletes })

					this.changed(result, deleteOrder(count, options.deletes), { kind: "deleted", pages: options.deletes })
				}
			},
			() => {
				// The editor did not start: nothing was made.
				this.set({ progress: undefined })
				this.host?.onFailed("previewPdfExtractFailed")
				opened.resolve(false)
			}
		)

		return opened.promise
	}

	// The open draft ends: saved (as a copy beside the PDF), or dropped.
	closeDraft(saved: boolean): void {
		const end = this.draftEnd

		this.draftEnd = null
		end?.(saved)
	}

	// Makes the draft and holds it until it ends; resolves whether it was saved.
	private async heldDraft(session: PdfEditSessionModel, file: PdfCopyFile, protect: boolean, onOpen: () => void): Promise<boolean> {
		const host = this.host

		if (host === null) throw new Error("no host")

		const { engine } = session
		const pages = rangesToPages(file.ranges)
		const begun = await engine.call("extractBegin", { pages, protect, inputBytes: host.fileSize, memory: host.memory() })

		if (begun.status === "refused") throw new Error(begun.reason)

		// Encrypted whenever the engine says (without owner access it always is): opened with the document's password.
		const password = begun.encryption === "None" ? undefined : host.password()
		// The draft's editing engines, closed before the bytes they read go.
		const editors: PdfEngine[] = []
		let saved = false

		try {
			const check = await checkHeldOutput(engine, host.openVerifier, password, begun.size, {
				pageCount: begun.pageCount,
				versions: 1,
				encryption: begun.encryption
			})

			if (!check.ok) throw new Error(`the new file failed its check: ${"reason" in check ? check.reason : "redaction"}`)

			const ended = Promise.withResolvers<boolean>()

			this.draftEnd = ended.resolve
			this.set({
				progress: undefined,
				draft: {
					id: ++nextDraft,
					size: begun.size,
					pageCount: begun.pageCount,
					suffix: file.suffix,
					password,
					open: async onPoisoned => {
						const editor = await host.openEditor(await serveHeldOutput(engine, begun.size), password, onPoisoned)

						editors.push(editor)

						return editor
					}
				}
			})
			onOpen()
			saved = await ended.promise
		} finally {
			await Promise.all(editors.map(editor => editor.close()))
			await engine.call("saveEnd", { outcome: saved ? "copied" : "failed", next: "continue" }).catch(() => undefined)
		}

		return saved
	}

	private async copies(
		session: PdfEditSessionModel,
		files: readonly PdfCopyFile[],
		protect: boolean
	): Promise<{ readonly name: string; readonly item: DriveItem }[]> {
		const host = this.host

		if (host === null) throw new Error("no host")

		const { engine } = session
		const saved: { readonly name: string; readonly item: DriveItem }[] = []

		for (const file of files) {
			const pages = rangesToPages(file.ranges)
			const begun = await engine.call("extractBegin", { pages, protect, inputBytes: host.fileSize, memory: host.memory() })

			if (begun.status === "refused") throw new Error(begun.reason)

			let made = false

			try {
				// Encrypted whenever the engine says (without owner access it always is): opened with the document's password.
				const check = await checkHeldOutput(
					engine,
					host.openVerifier,
					begun.encryption === "None" ? undefined : host.password(),
					begun.size,
					{
						pageCount: begun.pageCount,
						versions: 1,
						encryption: begun.encryption
					}
				)

				if (!check.ok) throw new Error(`the new file failed its check: ${"reason" in check ? check.reason : "redaction"}`)

				const upload = streamHeldOutput(engine)
				const [written, uploaded] = await Promise.all([
					upload.announced.then(() => host.write({ port: upload.port, size: begun.size }, file.suffix)),
					upload.uploaded
				])

				if (!uploaded || written?.outcome.status !== "success") throw new Error("the upload failed")

				made = true
				saved.push({ name: written.name, item: written.outcome.item })
			} finally {
				await engine.call("saveEnd", { outcome: made ? "copied" : "failed", next: "continue" }).catch(() => undefined)
			}

			this.set({ progress: { done: saved.length, count: files.length } })
		}

		return saved
	}
}
