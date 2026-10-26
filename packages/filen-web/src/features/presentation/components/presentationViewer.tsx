import { useEffect, useEffectEvent, useRef, useState, type KeyboardEvent } from "react"
import { useTranslation } from "react-i18next"
import type { TFunction } from "i18next"
import * as Comlink from "comlink"
import { DownloadIcon, MaximizeIcon, PanelLeftIcon, PresentationIcon, StickyNoteIcon } from "lucide-react"
import { driveItemName } from "@filen/shared"
import type { Action, Format, GateReason, PresentationRefusal, SlideRef } from "@filen/office/core/presentation"
import type { SlideLayer, SourceSpec } from "@filen/office/dom/presentation"
import {
	createPresentationStore,
	paintSlide,
	presentationActions,
	SlideView,
	StaticShow,
	usePresentationDocument,
	type PresentationDocument,
	type PresentationJump,
	type PresentationStore
} from "@filen/office/react/presentation"
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
import { PresentationNotesPane } from "@/features/presentation/components/notesPane"
import { PresentationSlideRail } from "@/features/presentation/components/slideRail"
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
import { useTrustedLinkGate } from "@/lib/trustedLinks/useTrustedLinkGate"
import { isSafeAbsoluteHref } from "@/lib/safeUrl"
import { fullscreenSupported } from "@/lib/media/fullscreen"
import { log } from "@/lib/log"
import { isAnyMenuOpen } from "@/lib/keymap/dialogGuard"
import type { PreviewKey } from "@/lib/i18n"

// A presentation in the preview: the slide in view (fit inside the canvas), the slide list beside it (a strip under
// it at phone widths), the speaker notes under it and a read-only command bar (slides, Present, the list and notes
// toggles, full screen, Download where the file may be saved). The deck lives in a presentation worker: a drive file
// is read there in ranges straight from the SDK worker, so no deck of any size is ever held whole on the page; an
// archive's entry is handed over as bytes. Arrow keys page slides, not files; Escape ends the slide show before it
// closes the preview.

export interface PresentationViewerProps {
	item: DriveItem
	alt: string
	// The drive listing the file was opened from (every deck is view-only here for now).
	variant?: DriveVariant
	canSaveCopy?: boolean
	onOpenFile?: (item: DriveItem) => void
}

// Slides rendered first around the one shown.
const OPEN_WINDOW = 3

export function PresentationViewer({ item, alt }: PresentationViewerProps) {
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
			onRetry={undefined}
		/>
	)
}

// A drive file (or a public link's): a range port from the SDK worker, served for as long as the deck is open. The
// port follows the file's content (uuid and size), not the item object: a rename or a favourite hands the viewer a
// new item for the same bytes, and the open deck keeps reading through its port.
function DriveDeck({ item, alt }: { item: DriveItem; alt: string }) {
	const anon = usePreviewAccessMode() === "anon"
	const [prepared, setPrepared] = useState<Prepared>({ status: "pending" })
	const [sniffed, setSniffed] = useState<Format | "text" | undefined>(undefined)
	const [attempt, setAttempt] = useState(0)
	const uuid = item.data.uuid
	const size = item.data.size
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
				setPrepared({ status: "ready", source: { kind: "range", port, size: Number(file.size), checked: false }, format, attempt })
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
	onRetry
}: {
	prepared: Prepared
	item: DriveItem
	alt: string
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

const GATE_KEYS: Record<GateReason, PreviewKey> = {
	signed: "previewPptxReadOnlySigned",
	strict: "previewPptxReadOnlyStrict",
	writeProtected: "previewPptxReadOnlyWriteProtected",
	malformed: "previewPptxReadOnlyMalformed"
}

// Failures a second try can fix (the worker went away, the open was called off).
const RETRYABLE: ReadonlySet<PresentationRefusal> = new Set(["failed", "aborted", "closed"])

function DeckSession({
	source,
	format,
	alt,
	onRetry
}: {
	source: SourceSpec
	format: Format
	alt: string
	onRetry: (() => void) | undefined
}) {
	const { t } = useTranslation("preview")
	const [store] = useState(() =>
		createPresentationStore({
			host: (spec, listener, options) => connectPresentation(presentationPool, spec, listener, options),
			// A copy of an entry's bytes is what goes over (transferred): the preview cache keeps its buffer.
			source: source.kind === "bytes" ? { kind: "bytes", bytes: source.bytes.slice() } : source,
			options: { format, fileName: alt, viewOnly: true, window: { from: 0, count: OPEN_WINDOW } }
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

	return (
		<DeckSurface
			store={store}
			document={document}
			alt={alt}
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

// The accessible name of a clickable shape: what a click does, after the shape's alt text when it has one.
function actionLabel(t: TFunction<"preview">, action: Action, layer: SlideLayer): string {
	const does =
		action.kind === "url"
			? t("previewPptxActionLink", { target: action.href })
			: action.kind === "media"
				? t("previewPptxActionMedia")
				: action.kind === "refused"
					? t("previewPptxActionRefused")
					: t("previewPptxActionJump")
	const name = layer.alt?.trim() ?? ""

	return name === "" ? does : t("previewPptxActionNamed", { name, action: does.charAt(0).toLowerCase() + does.slice(1) })
}

// How long the note about a refused action stays.
const REFUSED_NOTE_MS = 4000

// Keys that page slides (and never the preview's files): the rail and the show take their own first.
const PAGE_KEYS: Readonly<Record<string, -1 | 1 | "first" | "last">> = {
	ArrowLeft: -1,
	ArrowUp: -1,
	PageUp: -1,
	ArrowRight: 1,
	ArrowDown: 1,
	PageDown: 1,
	Home: "first",
	End: "last"
}

function isTextField(target: EventTarget | null): boolean {
	return target instanceof HTMLElement && (target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA")
}

function DeckSurface({ store, document: deck, alt }: { store: PresentationStore; document: PresentationDocument; alt: string }) {
	const { t } = useTranslation("preview")
	const phone = usePhoneWidth()
	const download = usePreviewDownload()
	const linkGate = useTrustedLinkGate()
	const [current, setCurrent] = useState(0)
	const [railOpen, setRailOpen] = useState(true)
	const [notesOpen, setNotesOpen] = useState(true)
	const [showing, setShowing] = useState(false)
	const [dismissed, setDismissed] = useState(false)
	// Counts refused actions while their note is up (0: none shown).
	const [refusedAt, setRefusedAt] = useState(0)
	const lastViewed = useRef(0)
	const enteredFullscreen = useRef(false)
	const canvasRef = useRef<HTMLDivElement | null>(null)
	const count = deck.slides.length
	const index = Math.min(current, Math.max(0, count - 1))
	const ref: SlideRef | undefined = deck.slides[index]?.ref
	const render = ref === undefined ? undefined : deck.renders.get(ref)
	const size = deck.info?.size ?? { cx: 12_192_000, cy: 6_858_000 }

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

		const clamped = Math.min(Math.max(0, next), count - 1)

		if (clamped !== index) lastViewed.current = index

		setCurrent(clamped)
	}

	const jump = (target: PresentationJump): void => {
		switch (target.kind) {
			case "internal":
				switch (target.jump) {
					case "next":
						go(index + 1)
						return
					case "previous":
						go(index - 1)
						return
					case "first":
						go(0)
						return
					case "last":
						go(count - 1)
						return
					case "lastViewed":
						go(lastViewed.current)
						return
					// Ending the show means nothing outside it.
					case "end":
						return
				}

				return
			case "slide":
				go(deck.slides.findIndex(slide => slide.ref === target.slide))
				return
			case "customShow": {
				const first = deck.info?.customShows.find(show => show.id === target.id)?.slides[0]

				if (first !== undefined) go(deck.slides.findIndex(slide => slide.ref === first))
			}
		}
	}

	// A refused action (a program, a macro, a local file) says so for a moment, in the viewer and in the show.
	useEffect(() => {
		if (refusedAt === 0) return

		const timer = setTimeout(() => {
			setRefusedAt(0)
		}, REFUSED_NOTE_MS)

		return () => {
			clearTimeout(timer)
		}
	}, [refusedAt])

	const actions = presentationActions({
		link: {
			allow: isSafeAbsoluteHref,
			open: href => {
				if (!linkGate.intercept(href)) window.open(href, "_blank", "noopener,noreferrer")
			}
		},
		navigate: jump,
		refused: () => {
			setRefusedAt(at => at + 1)
		}
	})

	// In the show it sits over the stage, which stacks itself at the top (presentation.css --fo-show-z).
	const refusedNote = (over: "canvas" | "show") =>
		refusedAt === 0 ? null : (
			<div
				role="status"
				className={`pointer-events-none absolute bottom-3 left-1/2 max-w-[90%] -translate-x-1/2 rounded-md bg-popover px-3 py-1.5 text-center text-xs text-popover-foreground shadow-md ${over === "show" ? "z-[2147483647]" : "z-10"}`}
			>
				{t("previewPptxRefusedAction")}
			</div>
		)

	const startShow = (): void => {
		setShowing(true)

		// The whole page, inside the click's activation (menus and dialogs portal to the body).
		if (fullscreenSupported() && document.fullscreenElement === null) {
			enteredFullscreen.current = true
			document.documentElement.requestFullscreen().catch((error: unknown) => {
				enteredFullscreen.current = false
				log.warn("presentation", "full screen refused", { error })
			})
		}
	}

	const endShow = (): void => {
		setShowing(false)

		if (enteredFullscreen.current && document.fullscreenElement !== null) void document.exitFullscreen().catch(() => undefined)

		enteredFullscreen.current = false
		canvasRef.current?.focus({ preventScroll: true })
	}

	// Escape in full screen is the browser's (Firefox and Safari never pass it on): leaving the full screen the show
	// entered ends the show too.
	useEffect(() => {
		if (!showing) return

		const onChange = (): void => {
			if (document.fullscreenElement === null && enteredFullscreen.current) {
				enteredFullscreen.current = false
				setShowing(false)
				canvasRef.current?.focus({ preventScroll: true })
			}
		}

		document.addEventListener("fullscreenchange", onChange)

		return () => {
			document.removeEventListener("fullscreenchange", onChange)
		}
	}, [showing])

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
		const step = PAGE_KEYS[event.key]

		// A key in an open menu (it portals inside this subtree) is the menu's, and the slide under it stays.
		if (step === undefined || showing || event.altKey || event.ctrlKey || event.metaKey || isAnyMenuOpen()) return

		// Slides page, files don't, whoever handled the key.
		event.stopPropagation()

		if (event.defaultPrevented || isTextField(event.target)) return

		event.preventDefault()
		go(step === "first" ? 0 : step === "last" ? count - 1 : index + step)
	}

	const groups: RibbonGroup[] = [
		{
			id: "slides",
			label: t("previewPptxSlidesGroup"),
			icon: PresentationIcon,
			width: pageControlsWidth(!phone),
			priority: Infinity,
			content: (
				<PageControls
					page={index + 1}
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
					onClick={startShow}
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
						pressed={railOpen}
						onClick={() => {
							setRailOpen(open => !open)
						}}
					/>
					<RibbonButton
						label={t(notesOpen ? "previewPptxNotesHide" : "previewPptxNotesShow")}
						icon={<StickyNoteIcon />}
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

	const notes: string[] = [
		...(deck.info?.gate ?? []).map(reason => t(GATE_KEYS[reason])),
		...deck.notices.flatMap(notice =>
			notice.kind === "macros" ? [t("previewPptxMacros")] : notice.kind === "linkedFile" ? [t("previewPptxLinkedFile")] : []
		)
	]

	return (
		<div
			role="region"
			aria-label={alt}
			className="flex size-full flex-col"
			onKeyDown={event => {
				onCommandBarF6(event, () => {
					canvasRef.current?.focus()
				})
				onKeyDown(event)
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
			{notes.length > 0 && !dismissed ? (
				<div
					role="status"
					className="flex shrink-0 items-start gap-2 border-b border-border px-3 py-1.5 text-xs text-muted-foreground"
				>
					<div className="flex min-w-0 flex-1 flex-col gap-0.5">
						{[...new Set(notes)].map(note => (
							<p key={note}>{note}</p>
						))}
					</div>
					<button
						type="button"
						className="shrink-0 underline-offset-2 hover:underline"
						onClick={() => {
							setDismissed(true)
						}}
					>
						{t("previewPptxDismiss")}
					</button>
				</div>
			) : null}
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
						{showing ? null : (
							<SlideView
								render={render}
								size={size}
								painter={paintSlide}
								{...(deck.session === undefined ? {} : { session: deck.session })}
								label={t("previewPptxSlideLabel", { current: index + 1, total: count })}
								actionLabel={(action, layer) => actionLabel(t, action, layer)}
								mode="view"
								actions={actions}
								className="size-full"
							/>
						)}
						{showing ? null : refusedNote("canvas")}
					</div>
					{notesOpen ? (
						<PresentationNotesPane
							text={render?.notesText ?? ""}
							phone={phone}
						/>
					) : null}
				</div>
			</div>
			{showing ? (
				<div
					data-preview-surface
					className="fixed inset-0 z-50 bg-black"
				>
					<StaticShow
						slides={deck.slides}
						customShows={deck.info?.customShows ?? []}
						renders={deck.renders}
						size={size}
						painter={paintSlide}
						{...(deck.session === undefined ? {} : { session: deck.session })}
						from={{ index }}
						onSlide={slide => {
							setCurrent(slide)
							store.setWindow(slide)
						}}
						onEnd={endShow}
						label={t("previewPptxShowLabel")}
						slideLabel={(slide, total) => t("previewPptxSlideLabel", { current: slide + 1, total })}
						actionLabel={(action, layer) => actionLabel(t, action, layer)}
						actions={actions}
					/>
					{refusedNote("show")}
				</div>
			) : null}
			{linkGate.dialog}
		</div>
	)
}
