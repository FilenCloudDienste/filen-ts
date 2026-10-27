import { useEffect, useEffectEvent, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import * as Comlink from "comlink"
import { DownloadIcon, MaximizeIcon, PanelLeftIcon, PresentationIcon, StickyNoteIcon } from "lucide-react"
import { driveItemName } from "@filen/shared"
import type { Format, PresentationRefusal, SlideRef } from "@filen/office/core/presentation"
import type { SourceSpec } from "@filen/office/dom/presentation"
import {
	createPresentationStore,
	paintSlide,
	SlideView,
	usePresentationDocument,
	type PresentationDocument,
	type PresentationStore
} from "@filen/office/react/presentation"
// The slide text's paragraph classes (hanging indents, link underlines) are the docx engine's.
import "@filen/office/css/docx.css"
import "@filen/office/css/presentation.css"
import "@/features/presentation/components/presentationTheme.css"
import { DropdownMenuItem } from "@/components/ui/dropdown-menu"
import { recordContentVerdict } from "@/features/drive/lib/contentVerdicts"
import { narrowToAnyFile } from "@/features/drive/lib/download"
import { driveItemMime, type DriveItem } from "@/features/drive/lib/item"
import { itemFileKind } from "@/features/drive/lib/preview.logic"
import { OfficeCommandBar, type RibbonGroup } from "@/features/office/components/ribbon/officeRibbon"
import { RibbonButton } from "@/features/office/components/ribbon/ribbonControls"
import { usePhoneWidth } from "@/features/office/components/ribbon/phoneMedia"
import { BAR_BUTTON, pageControlsWidth, useLeaveViewerFullScreen } from "@/features/preview/components/commandBar.logic"
import { CommandFileMenu, FullScreenButton, PageControls } from "@/features/preview/components/commandBarControls"
import { onCommandBarF6 } from "@/features/office/components/ribbon/ribbonFocus"
import { DocxPasswordGate, type PasswordVerdict } from "@/features/preview/components/docxPasswordPrompt"
import { PreviewDownloadButton, PreviewErrorState, PreviewGate, PreviewLoading } from "@/features/preview/components/previewErrorState"
import { TextViewer } from "@/features/preview/components/textViewer"
import { usePreviewBytes } from "@/features/preview/hooks/usePreviewBytes"
import { usePreviewAccessMode, usePreviewByteSource, usePreviewDownload } from "@/features/preview/lib/accessMode"
import { DeckNotes } from "@/features/presentation/components/deckChrome"
import { actionLabel, DEFAULT_SLIDE_SIZE, onPageKey } from "@/features/presentation/components/deckChrome.logic"
import { useDeckPresentation } from "@/features/presentation/hooks/useDeckPresentation"
import { PresentationEditor } from "@/features/presentation/components/presentationEditor"
import type { PresentationEditing } from "@/features/presentation/hooks/usePresentationSession"
import { PresentationNotesPane } from "@/features/presentation/components/notesPane"
import { PresentationSlideRail } from "@/features/presentation/components/slideRail"
import { LegacyPresentationBar, type LegacySaveCopy } from "@/features/presentation/components/legacyView"
import {
	PRESENTATION_SNIFF_BYTES,
	presentationFileKind,
	presentationVerdict,
	sniffPresentationKind
} from "@/features/presentation/lib/fileKind"
import { connectPresentation, presentationPool } from "@/features/presentation/lib/presentationEngine"
import type { DriveVariant } from "@/features/drive/lib/preferences"
import { rangePortReader } from "@/lib/media/rangePort"
import { sdkApi } from "@/lib/sdk/client"
import { PresentationMediaFrames } from "@/features/presentation/components/mediaFrame"
import { fullscreenSupported } from "@/lib/media/fullscreen"
import { log } from "@/lib/log"
import type { PreviewKey } from "@/lib/i18n"

// A presentation in the preview: the slide in view (fit inside the canvas), the slide list beside it (a strip under
// it at phone widths), the speaker notes under it and a read-only command bar (slides, Present, the list and notes
// toggles, full screen, Download where the file may be saved). A drive deck the overlay may edit opens in the editor
// (presentationEditor.tsx) instead. The deck lives in a presentation worker: a drive file
// is read there in ranges straight from the SDK worker, so no deck of any size is ever held whole on the page; an
// archive's entry is handed over as bytes. Arrow keys page slides, not files; Escape ends the slide show before it
// closes the preview.

export interface PresentationViewerProps {
	item: DriveItem
	alt: string
	// The drive listing the file was opened from (a view-only reason outside the user's own drive).
	variant?: DriveVariant
	// The overlay's editing side: the deck opens in the editor (view-only there when it cannot be saved). Absent (a
	// public link, an archive's entry, outside the drive): the viewer.
	editing?: PresentationEditing
	canSaveCopy?: boolean
	onOpenFile?: (item: DriveItem) => void
}

// Where a drive deck opens: the editor (with the overlay's editing side) or the viewer.
interface DeckPlace {
	readonly item: DriveItem
	readonly variant: DriveVariant | undefined
	readonly editing: PresentationEditing | undefined
	// A copy may be saved beside the file (Save as .pptx of a PowerPoint 97–2003 deck), opened where it lands.
	readonly copy?: { readonly onOpenFile: ((item: DriveItem) => void) | undefined } | undefined
}

// Slides rendered first around the one shown.
const OPEN_WINDOW = 3

export function PresentationViewer({ item, alt, variant, editing, canSaveCopy, onOpenFile }: PresentationViewerProps) {
	useLeaveViewerFullScreen()

	const archive = usePreviewByteSource() !== null

	return archive ? (
		<ArchiveDeck
			item={item}
			alt={alt}
		/>
	) : (
		<DriveDeck
			item={item}
			alt={alt}
			place={{ item, variant, editing, copy: canSaveCopy === true ? { onOpenFile } : undefined }}
		/>
	)
}

type Prepared =
	| { readonly status: "pending" }
	// attempt: a retry opens a new source (a range port goes to the worker with the deck).
	| { readonly status: "ready"; readonly source: SourceSpec; readonly format: Format; readonly attempt: number }
	| { readonly status: "text" }
	| { readonly status: "error"; readonly key: PreviewKey }

// The reader a file goes to: its extension's, or for a `.pot` still to be told apart, its first bytes' (a gettext
// template is text).
function formatOf(item: DriveItem, head: Uint8Array | undefined): Format | "text" | null {
	const kind = itemFileKind(item)
	const known = kind === null ? null : presentationFileKind(kind.extension)

	if (head === undefined || kind?.sniffable !== true) return known?.format ?? null

	return sniffPresentationKind(head) ?? "text"
}

function needsHead(item: DriveItem): boolean {
	const kind = itemFileKind(item)

	return kind !== null && kind.sniffable && kind.extension === "pot"
}

// What a sniffed `.pot` was, kept for its next open (presentationVerdict).
function useRecordVerdict(item: DriveItem, sniffed: Format | "text" | undefined): void {
	const anon = usePreviewAccessMode() === "anon"
	const uuid = item.data.uuid
	const name = driveItemName(item)
	const mime = driveItemMime(item)
	const size = item.data.size

	useEffect(() => {
		const verdict = sniffed === undefined ? undefined : presentationVerdict(sniffed)

		if (verdict === undefined) return

		recordContentVerdict({ uuid, name, mime, size }, verdict, { memoryOnly: anon })
	}, [uuid, name, mime, size, anon, sniffed])
}

// An archive's entry: its bytes (the deck copies them for the worker; the preview cache keeps its own).
function ArchiveDeck({ item, alt }: { item: DriveItem; alt: string }) {
	const result = usePreviewBytes(item)

	return (
		<PreviewGate result={result}>
			{ready => (
				<ArchiveBytes
					bytes={ready.bytes}
					item={item}
					alt={alt}
				/>
			)}
		</PreviewGate>
	)
}

function ArchiveBytes({ bytes, item, alt }: { bytes: Uint8Array; item: DriveItem; alt: string }) {
	const head = needsHead(item) ? bytes.subarray(0, PRESENTATION_SNIFF_BYTES) : undefined
	const format = formatOf(item, head)

	useRecordVerdict(item, head === undefined || format === null ? undefined : format)

	return (
		<PreparedDeck
			prepared={
				format === null
					? { status: "error", key: "previewPptxMalformed" }
					: format === "text"
						? { status: "text" }
						: { status: "ready", source: { kind: "bytes", bytes }, format, attempt: 0 }
			}
			item={item}
			alt={alt}
			place={undefined}
			onRetry={undefined}
		/>
	)
}

// A drive file (or a public link's): a range port from the SDK worker, served for as long as the deck is open. The
// port follows the file's content (uuid and size), not the item object: a rename or a favourite hands the viewer a
// new item for the same bytes, and the open deck keeps reading through its port.
function DriveDeck({ item, alt, place }: { item: DriveItem; alt: string; place: DeckPlace }) {
	const anon = usePreviewAccessMode() === "anon"
	const [prepared, setPrepared] = useState<Prepared>({ status: "pending" })
	const [sniffed, setSniffed] = useState<Format | "text" | undefined>(undefined)
	const [attempt, setAttempt] = useState(0)
	// An editor's session moves onto each file it saves (commitSaved): its deck is opened once per mount, whatever
	// uuid the saves give the item. The viewer follows the file's content.
	const [mounted] = useState(() => ({ uuid: item.data.uuid, size: item.data.size }))
	const editing = place.editing !== undefined
	const uuid = editing ? mounted.uuid : item.data.uuid
	const size = editing ? mounted.size : item.data.size
	const latestItem = useEffectEvent(() => item)

	useRecordVerdict(item, sniffed)

	useEffect(() => {
		const item = latestItem()
		const file = narrowToAnyFile(item)
		const token = crypto.randomUUID()
		// Mutated by the cleanup while the reads await.
		const alive = { current: true }
		const ended = (): boolean => !alive.current
		// After the worker took it, closing this end does nothing; before, it frees the SDK worker's side.
		let handed: MessagePort | null = null
		const openPort = async (): Promise<MessagePort> => {
			const { port1, port2 } = new MessageChannel()
			const transferred = Comlink.transfer(port1, [port1])

			if (anon) await sdkApi.openLinkedRangePortAnon(transferred, file, token)
			else await sdkApi.openRangePort(transferred, file, token)

			return port2
		}

		void (async () => {
			try {
				let head: Uint8Array | undefined

				if (needsHead(item)) {
					const reader = rangePortReader(await openPort())

					try {
						head = await reader.readRange(
							0,
							Math.min(PRESENTATION_SNIFF_BYTES, Number(file.size)),
							new AbortController().signal
						)
					} finally {
						reader.close()
					}
				}

				const format = formatOf(item, head)

				if (ended()) return

				if (head !== undefined && format !== null) setSniffed(format)

				if (format === null || format === "text") {
					setPrepared(format === null ? { status: "error", key: "previewPptxMalformed" } : { status: "text" })

					return
				}

				const port = await openPort()

				if (ended()) {
					port.close()

					return
				}

				handed = port
				setPrepared({ status: "ready", source: { kind: "range", port, size: Number(file.size), checked: true }, format, attempt })
			} catch (error) {
				log.warn("presentation", "range port not opened", { error })

				if (!ended()) setPrepared({ status: "error", key: "previewPptxLoadFailed" })
			}
		})()

		return () => {
			alive.current = false
			handed?.close()
			// Ends every read still served on the deck's ports.
			void sdkApi.cancelPreviewDownload(token)
		}
	}, [uuid, size, anon, attempt])

	return (
		<PreparedDeck
			prepared={prepared}
			item={item}
			alt={alt}
			place={place}
			onRetry={() => {
				setPrepared({ status: "pending" })
				setAttempt(value => value + 1)
			}}
		/>
	)
}

function PreparedDeck({
	prepared,
	item,
	alt,
	place,
	onRetry
}: {
	prepared: Prepared
	item: DriveItem
	alt: string
	place: DeckPlace | undefined
	onRetry: (() => void) | undefined
}) {
	const { t } = useTranslation("preview")

	switch (prepared.status) {
		case "pending":
			return <PreviewLoading />
		case "text":
			return (
				<TextViewer
					item={item}
					alt={alt}
					rejectBinary
				/>
			)
		case "error":
			return (
				<PreviewErrorState
					message={t(prepared.key)}
					{...(onRetry === undefined || prepared.key !== "previewPptxLoadFailed" ? {} : { onRetry })}
					action={<PreviewDownloadButton />}
				/>
			)
		case "ready":
			return (
				<DeckSession
					key={prepared.attempt}
					source={prepared.source}
					format={prepared.format}
					alt={alt}
					place={place}
					onRetry={onRetry}
				/>
			)
	}
}

const REFUSAL_KEYS: Partial<Record<PresentationRefusal, PreviewKey>> = {
	malformed: "previewPptxMalformed",
	tooLarge: "previewPptxTooLarge",
	tooDeep: "previewPptxTooLarge",
	rightsManaged: "previewPptxRightsManaged",
	unsupportedEncryption: "previewPptxUnsupportedEncryption",
	damagedEncryption: "previewPptxDamagedEncryption",
	unsupported: "previewPptxUnsupported",
	notImplemented: "previewPptxUnsupported"
}

// Failures a second try can fix (the worker went away, the open was called off).
const RETRYABLE: ReadonlySet<PresentationRefusal> = new Set(["failed", "aborted", "closed"])

function DeckSession({
	source,
	format,
	alt,
	place,
	onRetry
}: {
	source: SourceSpec
	format: Format
	alt: string
	place: DeckPlace | undefined
	onRetry: (() => void) | undefined
}) {
	const { t } = useTranslation("preview")
	const [store] = useState(() =>
		createPresentationStore({
			host: (spec, listener, options) => connectPresentation(presentationPool, spec, listener, options),
			// A copy of an entry's bytes is what goes over (transferred): the preview cache keeps its buffer.
			source: source.kind === "bytes" ? { kind: "bytes", bytes: source.bytes.slice() } : source,
			// Editable only where the overlay can save the file as it mounts (the worker gates the deck's own reasons).
			options: { format, fileName: alt, viewOnly: place?.editing?.writable !== true, window: { from: 0, count: OPEN_WINDOW } }
		})
	)
	const document = usePresentationDocument(store)

	if (document.status === "error") {
		const reason = document.error?.reason ?? "failed"
		// A deck that was open and then failed (its worker went away) stopped; it was never refused.
		const stopped = document.info !== undefined && RETRYABLE.has(reason)

		return (
			<PreviewErrorState
				message={t(stopped ? "previewPptxStoppedWorking" : (REFUSAL_KEYS[reason] ?? "previewPptxLoadFailed"))}
				{...(RETRYABLE.has(reason) && onRetry !== undefined ? { onRetry } : {})}
				action={<PreviewDownloadButton />}
			/>
		)
	}

	// The prompt stays mounted while a password is checked, so it shows its progress and then a wrong password.
	if (document.password !== undefined) {
		return (
			<DocxPasswordGate
				message={t("previewPptxPasswordMessage")}
				enterLabel={t("previewPptxPasswordEnter")}
				title={t("previewPptxPasswordTitle")}
				body={t("previewPptxPasswordBody", { name: alt })}
				wrongMessage={t("previewPptxPasswordWrong")}
				label={t("previewPptxPasswordLabel")}
				submitLabel={t("previewPptxPasswordSubmit")}
				progressLabel={t("previewPptxPasswordChecking")}
				verify={(password, signal) => verifyPassword(store, password, signal)}
			/>
		)
	}

	if (document.info === undefined) return <PreviewLoading />

	const saveCopy: LegacySaveCopy | undefined =
		place?.copy === undefined || document.session === undefined
			? undefined
			: {
					item: place.item,
					session: document.session,
					encrypted: document.info.protection.encrypted,
					onOpenFile: place.copy.onOpenFile
				}

	if (place?.editing !== undefined) {
		return (
			<PresentationEditor
				store={store}
				document={document}
				alt={alt}
				item={place.item}
				variant={place.variant}
				editing={place.editing}
				saveCopy={saveCopy}
			/>
		)
	}

	return (
		<DeckSurface
			store={store}
			document={document}
			alt={alt}
			saveCopy={saveCopy}
		/>
	)
}

// Answers the prompt once the store has heard back: opened, a wrong password, or the user's cancel.
function verifyPassword(store: PresentationStore, password: string, signal: AbortSignal): Promise<PasswordVerdict> {
	return new Promise(resolve => {
		let done = false
		const finish = (verdict: PasswordVerdict): void => {
			if (done) return

			done = true
			unsubscribe()
			resolve(verdict)
		}
		const unsubscribe = store.subscribe(() => {
			const snapshot = store.getSnapshot()

			if (snapshot.status === "password") finish(snapshot.password?.wrong === true ? "wrong" : "aborted")
			else if (snapshot.status !== "loading") finish("accepted")
		})

		signal.addEventListener(
			"abort",
			() => {
				finish("aborted")
			},
			{ once: true }
		)
		store.unlock(password)
	})
}

function DeckSurface({
	store,
	document: deck,
	alt,
	saveCopy
}: {
	store: PresentationStore
	document: PresentationDocument
	alt: string
	saveCopy: LegacySaveCopy | undefined
}) {
	const { t } = useTranslation("preview")
	const phone = usePhoneWidth()
	const download = usePreviewDownload()
	const [current, setCurrent] = useState(0)
	const [railOpen, setRailOpen] = useState(true)
	const [notesOpen, setNotesOpen] = useState(true)
	const canvasRef = useRef<HTMLDivElement | null>(null)
	const count = deck.slides.length
	const index = Math.min(current, Math.max(0, count - 1))
	const ref: SlideRef | undefined = deck.slides[index]?.ref
	const render = ref === undefined ? undefined : deck.renders.get(ref)
	const size = deck.info?.size ?? DEFAULT_SLIDE_SIZE

	useEffect(() => {
		store.setWindow(index)
	}, [store, index])

	// The slide takes focus as the deck opens (unless something else already has it), so the keys page slides from
	// the start instead of reaching the preview's own file paging.
	useEffect(() => {
		const active = document.activeElement

		if (active === null || active === document.body || active.contains(canvasRef.current))
			canvasRef.current?.focus({ preventScroll: true })
	}, [])

	// A slide's index; a negative one (a jump to a slide the deck no longer has) goes nowhere.
	const go = (next: number): void => {
		if (count === 0 || next < 0) return

		setCurrent(Math.min(Math.max(0, next), count - 1))
	}

	const show = useDeckPresentation({ store, deck, index, go, focusSlide: canvasRef })
	// SlideView's fit: the media frames over the slide are placed in screen px.
	const [scale, setScale] = useState(1)

	const groups: RibbonGroup[] = [
		{
			id: "slides",
			label: t("previewPptxSlidesGroup"),
			icon: PresentationIcon,
			width: pageControlsWidth(!phone),
			priority: Infinity,
			content: (
				<PageControls
					page={count === 0 ? 0 : index + 1}
					total={count}
					ends={!phone}
					canPrevious={index > 0}
					canNext={index < count - 1}
					onGo={page => {
						go(page - 1)
					}}
					onPrevious={() => {
						go(index - 1)
					}}
					onNext={() => {
						go(index + 1)
					}}
					onFirst={() => {
						go(0)
					}}
					onLast={() => {
						go(count - 1)
					}}
				/>
			)
		},
		{
			id: "show",
			label: t("previewPptxStartShow"),
			icon: PresentationIcon,
			width: BAR_BUTTON,
			priority: 8,
			single: true,
			content: (
				<RibbonButton
					label={t("previewPptxStartShow")}
					icon={<PresentationIcon />}
					disabled={count === 0}
					onClick={show.startShow}
				/>
			)
		},
		{
			id: "panes",
			label: t("previewPptxRailToggle"),
			icon: PanelLeftIcon,
			width: 2 * BAR_BUTTON,
			priority: 4,
			content: (
				<>
					<RibbonButton
						label={t("previewPptxRailToggle")}
						icon={<PanelLeftIcon />}
						disabled={count === 0}
						pressed={railOpen}
						onClick={() => {
							setRailOpen(open => !open)
						}}
					/>
					<RibbonButton
						label={t(notesOpen ? "previewPptxNotesHide" : "previewPptxNotesShow")}
						icon={<StickyNoteIcon />}
						disabled={count === 0}
						pressed={notesOpen}
						onClick={() => {
							setNotesOpen(open => !open)
						}}
					/>
				</>
			)
		}
	]

	if (fullscreenSupported()) {
		groups.push({
			id: "fullscreen",
			label: t("previewCommandBarFullScreen"),
			icon: MaximizeIcon,
			width: BAR_BUTTON,
			priority: 2,
			single: true,
			content: <FullScreenButton />
		})
	}

	return (
		<div
			role="region"
			aria-label={alt}
			className="flex size-full flex-col"
			onKeyDown={event => {
				if (show.onKey(event)) return

				onCommandBarF6(event, () => {
					canvasRef.current?.focus()
				})
				onPageKey(event, show.showing, step => {
					go(step === "first" ? 0 : step === "last" ? count - 1 : index + step)
				})
			}}
		>
			<OfficeCommandBar
				label={t("previewPptxCommandBar")}
				file={
					download === null ? null : (
						<CommandFileMenu>
							<DropdownMenuItem onClick={download}>
								<DownloadIcon />
								{t("previewDownloadAction")}
							</DropdownMenuItem>
						</CommandFileMenu>
					)
				}
				groups={groups}
			/>
			<LegacyPresentationBar
				format={deck.info?.format}
				saveCopy={saveCopy}
			/>
			<DeckNotes deck={deck} />
			<div className={phone ? "flex min-h-0 flex-1 flex-col-reverse" : "flex min-h-0 flex-1"}>
				{railOpen && count > 0 ? (
					<PresentationSlideRail
						document={deck}
						store={store}
						current={index}
						onSelect={go}
					/>
				) : null}
				<div className="flex min-h-0 min-w-0 flex-1 flex-col">
					<div
						ref={canvasRef}
						data-preview-surface
						tabIndex={0}
						className="relative min-h-0 flex-1 bg-muted/40 p-3 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/30"
					>
						{/* Nothing of it is seen under the show: it is painted again once, when the show ends. */}
						{count === 0 ? (
							<p className="flex size-full items-center justify-center p-4 text-center text-sm text-muted-foreground">
								{t("previewPptxEmptyDeck")}
							</p>
						) : show.showing ? null : (
							<SlideView
								render={render}
								size={size}
								painter={paintSlide}
								{...(deck.session === undefined ? {} : { session: deck.session })}
								label={t("previewPptxSlideLabel", { current: index + 1, total: count })}
								actionLabel={(action, layer) => actionLabel(t, action, layer)}
								mode="view"
								actions={show.actions}
								className="size-full"
								onScale={setScale}
								overlay={
									<PresentationMediaFrames
										render={render}
										session={deck.session}
										scale={scale}
										notices={deck.notices}
										actions={show.actions}
									/>
								}
							/>
						)}
						{show.showing ? null : show.refusedNote("canvas")}
					</div>
					{notesOpen && count > 0 ? (
						<PresentationNotesPane
							text={render?.notesText ?? ""}
							phone={phone}
						/>
					) : null}
				</div>
			</div>
			{show.layer}
		</div>
	)
}
