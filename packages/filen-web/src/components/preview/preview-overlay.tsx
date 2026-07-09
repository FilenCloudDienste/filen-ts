import { useEffect, useRef, lazy, Suspense, type KeyboardEvent } from "react"
import { useTranslation } from "react-i18next"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { XIcon, ChevronLeftIcon, ChevronRightIcon, DownloadIcon } from "lucide-react"
import { asDirectoryOrFile, type DriveItem } from "@/lib/drive/item"
import { type DriveVariant } from "@/lib/drive/preferences"
import { previewType } from "@/lib/drive/preview.logic"
import { startDownloads } from "@/lib/drive/download"
import { ImageViewer } from "@/components/preview/image-viewer"
import { MediaViewer } from "@/components/preview/media-viewer"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"

// Lazy chunks: pdf.js (~1MB+) and docx-preview only ever download once a pdf/docx is actually
// opened, never on the app's own initial bundle — the first two categories to use React.lazy in
// this app (image/video/audio all stream or buffer directly, no heavy renderer library involved).
const PdfViewer = lazy(() => import("@/components/preview/pdf-viewer"))
const DocxViewer = lazy(() => import("@/components/preview/docx-viewer"))

export interface PreviewOverlayProps {
	variant: DriveVariant
	// Frozen previewable-sibling snapshot taken at open time (directory-listing.tsx's handleOpen) — the
	// pager's whole candidate list, not just the opened item.
	items: DriveItem[]
	index: number
	onStep: (delta: 1 | -1) => void
	onClose: () => void
}

// True while focus sits on (or inside) a <video>/<audio> element — its own native controls own
// Left/Right as a seek, so the pager below must not steal them. `instanceof` also covers the "target
// can be a non-Element EventTarget" case for free (null/Document/etc. all just return false), unlike a
// closest() call that would need its own Element check first. The user-agent shadow root the native
// `controls` UI renders into retargets any bubbled event's `target` back to this host element anyway,
// so no tree walk is needed even for a click on the scrubber itself.
function isMediaTarget(target: EventTarget | null): boolean {
	return target instanceof HTMLMediaElement
}

// Full-bleed preview surface, mounted by the drive dialog host (directory-listing.tsx) exactly like its
// sibling dialog kinds — composed directly from Base UI's dialog primitives (not the shared centered
// ui/dialog.tsx) since no full-screen surface exists yet to reuse. Unlike every other dialog in this
// app, closing here is NEVER blocked on a pending state: every viewer's own data load is a read-only,
// ephemeral fetch (a buffered whole-file download cancels on unmount, a streamed SW registration has
// nothing server-side to cancel in the first place), never a write worth protecting against an
// interrupted close.
export function PreviewOverlay({ variant, items, index, onStep, onClose }: PreviewOverlayProps) {
	const { t } = useTranslation(["preview", "common"])
	const item = items[index]
	const popupRef = useRef<HTMLDivElement>(null)

	// A step can disable the very pager button that triggered it (index lands on the first/last item,
	// see the Prev/Next Buttons' own `disabled` below) — the browser blurs a disabled focused control
	// straight to `<body>` with no app-level recovery, which strands keyboard/AT focus OUTSIDE the
	// dialog's own DOM subtree (body is an ancestor of the portaled popup, not a descendant, so no
	// handler scoped to the popup — including handleKeyDown below — ever sees another keypress there).
	// Live-verified (page.evaluate(() => document.activeElement) read "BODY" right after such a step).
	// Pulls focus back onto the popup container itself whenever that's happened; a no-op otherwise
	// (focus already on something valid inside the dialog, e.g. the other, still-enabled pager button).
	useEffect(() => {
		if (popupRef.current && !popupRef.current.contains(document.activeElement)) {
			popupRef.current.focus()
		}
	}, [index])

	function handleOpenChange(next: boolean): void {
		if (!next) {
			onClose()
		}
	}

	// Base UI's DialogPopup calls event.stopPropagation() for every composite key (Arrow*/Home/End) in
	// its own onKeyDown (dialog/popup/DialogPopup.js + internals/composite/composite.js's
	// COMPOSITE_KEYS, verified against the installed package) before it can bubble to the document-level
	// keymap listener useAction/react-hotkeys-hook registers — so ArrowLeft/ArrowRight can never reach a
	// global drive.previewPrev/drive.previewNext action while the dialog holds focus. Merged onKeyDown
	// props run right-to-left (merge-props.js), so a handler passed directly on Popup (below) still runs
	// BEFORE that internal stopPropagation — this is that handler, mirroring move-target-dialog.tsx's own
	// local onKeyDown for the identical in-dialog-focus-trap reason.
	function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
		// A focused media scrubber wins over the pager — native seek expectation (see isMediaTarget above).
		if (isMediaTarget(event.target)) {
			return
		}

		if (event.key === "ArrowLeft") {
			event.preventDefault()
			onStep(-1)
		} else if (event.key === "ArrowRight") {
			event.preventDefault()
			onStep(1)
		}
	}

	if (!item) {
		return null
	}

	const name = item.data.decryptedMeta?.name ?? item.data.uuid

	return (
		<DialogPrimitive.Root
			open
			onOpenChange={handleOpenChange}
		>
			<DialogPrimitive.Portal>
				<DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-background duration-100 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
				<DialogPrimitive.Popup
					ref={popupRef}
					onKeyDown={handleKeyDown}
					className="fixed inset-0 z-50 flex flex-col bg-background duration-100 outline-none data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
				>
					<header className="flex h-14 shrink-0 items-center gap-1 border-b border-border px-4">
						<PreviewName name={name} />
						<Button
							variant="ghost"
							size="icon-sm"
							disabled={index <= 0}
							aria-label={t("previewPreviousAction")}
							onClick={() => {
								onStep(-1)
							}}
						>
							<ChevronLeftIcon />
						</Button>
						<Button
							variant="ghost"
							size="icon-sm"
							disabled={index >= items.length - 1}
							aria-label={t("previewNextAction")}
							onClick={() => {
								onStep(1)
							}}
						>
							<ChevronRightIcon />
						</Button>
						{variant !== "trash" ? (
							<Button
								variant="ghost"
								size="icon-sm"
								aria-label={t("previewDownloadAction")}
								onClick={() => {
									void startDownloads([item])
								}}
							>
								<DownloadIcon />
							</Button>
						) : null}
						<DialogPrimitive.Close
							render={
								<Button
									variant="ghost"
									size="icon-sm"
									aria-label={t("common:close")}
								/>
							}
						>
							<XIcon />
						</DialogPrimitive.Close>
					</header>
					<div className="min-h-0 flex-1">
						<PreviewBody
							key={item.data.uuid}
							item={item}
						/>
					</div>
				</DialogPrimitive.Popup>
			</DialogPrimitive.Portal>
		</DialogPrimitive.Root>
	)
}

// Middle-ish ellipsis for a long filename: the head truncates with a CSS ellipsis while the tail
// (typically the extension) always stays visible, rather than the browser's default end-truncation
// swallowing it. Also carries the dialog's required accessible title.
function PreviewName({ name }: { name: string }) {
	const TAIL_LENGTH = 16
	const splitAt = name.length - TAIL_LENGTH

	return (
		<DialogPrimitive.Title className="flex min-w-0 flex-1 font-heading text-sm font-medium">
			{splitAt > 0 ? (
				<>
					<span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{name.slice(0, splitAt)}</span>
					<span className="shrink-0 whitespace-nowrap">{name.slice(splitAt)}</span>
				</>
			) : (
				<span className="truncate">{name}</span>
			)}
		</DialogPrimitive.Title>
	)
}

// Dispatches to the right viewer by category — remounted (keyed by uuid) on every item change so a
// viewer's own pending/success/error state never flashes the previous item's content. Bytes are no
// longer loaded centrally here: image/video/audio each own their own data source (a streamed SW URL or
// a buffered blob, see image-viewer.tsx/media-viewer.tsx), pdf/docx each own a lazy chunk plus their
// own whole-buffer load (see pdf-viewer.tsx/docx-viewer.tsx) — a category still rendered by the
// fallback below (text/code/markdown) has nothing to load yet.
function PreviewBody({ item }: { item: DriveItem }) {
	const { t } = useTranslation("preview")

	// Narrows `data.decryptedMeta` to the file-arm's DecryptedFileMeta (which alone carries `.mime`) —
	// previewType/canPreview already guarantee a file arm for every item that ever reaches this
	// component, but that guarantee lives in a plain function's return value, not a type predicate, so
	// TS needs this explicit narrow before a `.mime`/`.name` access type-checks.
	const base = asDirectoryOrFile(item)

	if (base.type !== "file") {
		return null
	}

	const alt = base.data.decryptedMeta?.name ?? base.data.uuid
	// Stored once (rather than switching on the previewType(item) call directly) so the "video"/"audio"
	// case below can pass it straight through as MediaViewer's own narrower category prop without a
	// second, redundant resolution — a raw switch on the call expression doesn't narrow across cases.
	const category = previewType(item)

	switch (category) {
		case "image":
			return (
				<ImageViewer
					item={item}
					alt={alt}
				/>
			)
		case "video":
		case "audio":
			return (
				<MediaViewer
					item={item}
					category={category}
					alt={alt}
				/>
			)
		case "pdf":
			return (
				<Suspense
					fallback={
						<div className="flex size-full items-center justify-center">
							<Spinner className="size-6" />
						</div>
					}
				>
					<PdfViewer
						item={item}
						alt={alt}
					/>
				</Suspense>
			)
		case "docx":
			return (
				<Suspense
					fallback={
						<div className="flex size-full items-center justify-center">
							<Spinner className="size-6" />
						</div>
					}
				>
					<DocxViewer
						item={item}
						alt={alt}
					/>
				</Suspense>
			)
		// Every other previewable category has no viewer yet — later tasks replace this branch with a
		// real one per category as they land, shrinking this fallback over time.
		case "text":
		case "code":
		case "markdown":
		case "other":
			return (
				<div className="flex size-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
					{t("previewUnsupportedType")}
				</div>
			)
	}
}
