import { useEffect, useRef, useState, lazy, Suspense, Component, type KeyboardEvent, type ReactNode, type RefObject } from "react"
import { useTranslation } from "react-i18next"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { XIcon, ChevronLeftIcon, ChevronRightIcon, DownloadIcon, SaveIcon } from "lucide-react"
import { toast } from "sonner"
import { asDirectoryOrFile, type DriveItem } from "@/lib/drive/item"
import { type DriveVariant } from "@/lib/drive/preferences"
import { previewType } from "@/lib/drive/preview.logic"
import { startDownloads } from "@/lib/drive/download"
import { isEditable, runPreviewSave } from "@/lib/drive/preview-save.logic"
import { currentRootUuid } from "@/lib/drive/actions"
import { driveListingQueryUpdate } from "@/queries/drive"
import { sdkApi } from "@/lib/sdk/client"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { registerAction } from "@/lib/keymap/registry"
import { useAction } from "@/lib/keymap/useAction"
import { log } from "@/lib/log"
import { ImageViewer } from "@/components/preview/image-viewer"
import { MediaViewer } from "@/components/preview/media-viewer"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { ConfirmDialog } from "@/components/dialogs/confirm-dialog"

// Lazy chunks: pdf.js (~1MB+), docx-preview, CodeMirror (+ its per-language grammar chunks) and
// react-markdown only ever download once a file needing them is actually opened, never on the app's
// own initial bundle (image/video/audio all stream or buffer directly, no heavy renderer library
// involved). markdown-viewer.tsx's own "view source" toggle lazy-imports TextViewer a second time —
// the same underlying chunk as this one, deduped by the bundler.
const PdfViewer = lazy(() => import("@/components/preview/pdf-viewer"))
const DocxViewer = lazy(() => import("@/components/preview/docx-viewer"))
const TextViewer = lazy(() => import("@/components/preview/text-viewer"))
const MarkdownViewer = lazy(() => import("@/components/preview/markdown-viewer"))

// Cmd/Ctrl+S — SHARES its literal combo with the already-registered "drive.download" (mod+s,
// directory-listing.tsx), deliberately: that action's own handler already no-ops (after an
// unconditional preventDefault, which is what actually suppresses the browser's native Save-Page-As)
// whenever a dialog — this one included — is open, so the two never race for real effect, only for
// the harmless preventDefault. `enableOnContentEditable` is load-bearing: react-hotkeys-hook's default
// ignore-list stops a hotkey whose event target is contentEditable (verified against the installed
// package's own compiled source), and CodeMirror's own content DOM sets `contenteditable="true"` while
// editable — without this override, Cmd/Ctrl+S would silently never fire while the cursor is actually
// inside the editor, exactly the moment a user would press it.
registerAction({
	id: "preview.save",
	defaultCombo: "mod+s",
	scope: "editor",
	descriptionKey: "previewSaveAction"
})

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

// What close/prev/next resolve to once an unsaved-changes prompt is answered — the SAME confirm
// dialog serves all three trigger points (Escape/backdrop/X, the two pager buttons, and the in-dialog
// arrow keys), so this is the only state needed to remember which of them was actually requested.
type PendingIntent = "close" | "prev" | "next"

interface PreviewErrorBoundaryState {
	hasError: boolean
}

// The only React API for a render-phase catch (no hook equivalent). Scoped to the preview body ONLY —
// the header (Save/prev/next/download/close) lives outside it, so the overlay stays fully closeable
// even while this is showing its fallback. A synchronous viewer throw (e.g. the markdown parser, which
// runs during render, not inside an effect) would otherwise propagate past this dialog uncaught and
// white-screen the whole app — no boundary exists anywhere else in this tree. Keyed by item uuid at
// its call site below (the same key PreviewBody itself used to carry) so a crash on one item can never
// stick once the user steps to a different one — getDerivedStateFromError has no other way back to a
// clean state.
class PreviewErrorBoundary extends Component<{ children: ReactNode }, PreviewErrorBoundaryState> {
	override state: PreviewErrorBoundaryState = { hasError: false }

	static getDerivedStateFromError(): PreviewErrorBoundaryState {
		return { hasError: true }
	}

	override componentDidCatch(error: unknown): void {
		log.error("preview", "viewer render failed", error)
	}

	override render(): ReactNode {
		return this.state.hasError ? <PreviewRenderError /> : this.props.children
	}
}

function PreviewRenderError() {
	const { t } = useTranslation("preview")

	return (
		<div className="flex size-full items-center justify-center px-6 text-center text-sm text-destructive">
			{t("previewRenderError")}
		</div>
	)
}

// Full-bleed preview surface, mounted by the drive dialog host (directory-listing.tsx) exactly like its
// sibling dialog kinds — composed directly from Base UI's dialog primitives (not the shared centered
// ui/dialog.tsx) since no full-screen surface exists yet to reuse. Closing is blocked on a pending
// state in exactly one case now: an editable text/code buffer with unsaved edits (see requestOrRun) —
// every other viewer's own data load stays a read-only, ephemeral fetch never worth protecting an
// interrupted close against.
export function PreviewOverlay({ variant, items, index, onStep, onClose }: PreviewOverlayProps) {
	const { t } = useTranslation(["preview", "common"])
	const rawItem = items[index]
	const popupRef = useRef<HTMLDivElement>(null)
	// Write-only side channel for performSave to read the live buffer without this component
	// re-rendering on every keystroke — see TextViewer's own contentRef prop doc.
	const contentRef = useRef<string | null>(null)

	// Local override for the currently-displayed item: `items` is a FROZEN pager snapshot (see the
	// props' own comment) a save's uuid rotation can never update in place. Keyed to the RAW (pre-save)
	// uuid so it stops applying — PreviewBody naturally re-keys back onto `rawItem` — the moment the
	// user steps to a different sibling (a genuinely different `rawItem`).
	const [saved, setSaved] = useState<{ forUuid: string; item: DriveItem } | null>(null)
	// Same keying trick for the mobile-parity "a failed save locks the file read-only" rule (see
	// runPreviewSave's own comment) — a fresh item (navigation) or a fresh overlay mount (close+reopen)
	// both clear it for free, derived rather than reset by an effect.
	const [lockedReadOnly, setLockedReadOnly] = useState<{ forUuid: string } | null>(null)
	const [dirty, setDirty] = useState(false)
	const [saving, setSaving] = useState(false)
	const [pendingIntent, setPendingIntent] = useState<PendingIntent | null>(null)

	const item = rawItem !== undefined && saved?.forUuid === rawItem.data.uuid ? saved.item : rawItem
	const editable = item !== undefined && isEditable(item, variant) && lockedReadOnly?.forUuid !== rawItem?.data.uuid

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

	// The one write path: encode -> upload -> patch listing -> re-key onto the rotated uuid (success),
	// or lock the buffer read-only with a LABEL-FIRST toast (failure) — see preview-save.logic.ts's own
	// comment for why a retry against the same broken parent is never offered. `dirty` resets for free:
	// success re-keys PreviewBody (a new `item.data.uuid`), which remounts TextViewer fresh and reports
	// its own clean `dirty=false` right back up (see text-viewer.tsx's own mount-time effect).
	async function performSave(): Promise<void> {
		// Locals, not the outer `item`/`rawItem` directly — this closure runs asynchronously, well after
		// this render's narrowing; re-binding here gives the guard below its own, freshly-narrowable copy.
		const targetItem = item
		const targetRawItem = rawItem

		if (!editable || !dirty || saving || targetItem === undefined || targetRawItem === undefined) {
			return
		}

		const content = contentRef.current

		if (content === null) {
			return
		}

		setSaving(true)

		const outcome = await runPreviewSave(
			{
				uploadFileBytes: (parentUuid, data, name, mime) => sdkApi.uploadFileBytes(parentUuid, data, name, mime),
				patchListing: driveListingQueryUpdate,
				rootUuid: currentRootUuid()
			},
			{ item: targetItem, content }
		)

		setSaving(false)

		if (outcome.status === "error") {
			toast.error(errorLabel(outcome.dto))
			setLockedReadOnly({ forUuid: targetRawItem.data.uuid })
			toast.warning(t("previewReadOnlyAfterSaveFailure"))
			return
		}

		setSaved({ forUuid: targetRawItem.data.uuid, item: outcome.item })
	}

	useAction(
		"preview.save",
		keyboardEvent => {
			// Unconditional, mirroring drive.download's own mod+s handler — the browser's native
			// Save-Page-As must never fire here regardless of whether a save is actually possible right now.
			keyboardEvent.preventDefault()
			void performSave()
		},
		{ enableOnContentEditable: true },
		[editable, dirty, saving, item, rawItem]
	)

	// Routes a close/prev/next intent through the unsaved-changes prompt when the open item is a dirty
	// editable buffer; runs it immediately otherwise. Every dismissal route (Escape, backdrop, the X
	// button — all three fold into Base UI's own onOpenChange(false)), both pager buttons, and the
	// in-dialog arrow keys funnel through this, so none of them can silently drop an in-progress edit.
	// An in-flight save blocks the intent outright (mirrors the pager buttons' own disabled state):
	// prompting "discard?" mid-save would let the user discard while the un-cancellable upload still
	// lands and patches the listing — a silent contradiction of the choice they just made.
	function requestOrRun(intent: PendingIntent, run: () => void): void {
		if (saving) {
			return
		}

		if (editable && dirty) {
			setPendingIntent(intent)
			return
		}

		run()
	}

	function handleOpenChange(next: boolean): void {
		if (!next) {
			requestOrRun("close", onClose)
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
			requestOrRun("prev", () => {
				onStep(-1)
			})
		} else if (event.key === "ArrowRight") {
			event.preventDefault()
			requestOrRun("next", () => {
				onStep(1)
			})
		}
	}

	function handleUnsavedConfirm(): void {
		const intent = pendingIntent
		setPendingIntent(null)

		if (intent === "close") {
			onClose()
		} else if (intent === "prev") {
			onStep(-1)
		} else if (intent === "next") {
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
						{editable && dirty ? (
							<Button
								variant="ghost"
								size="icon-sm"
								disabled={saving}
								aria-label={t("previewSaveAction")}
								onClick={() => {
									void performSave()
								}}
							>
								{saving ? <Spinner className="size-4" /> : <SaveIcon />}
							</Button>
						) : null}
						<Button
							variant="ghost"
							size="icon-sm"
							disabled={index <= 0 || saving}
							aria-label={t("previewPreviousAction")}
							onClick={() => {
								requestOrRun("prev", () => {
									onStep(-1)
								})
							}}
						>
							<ChevronLeftIcon />
						</Button>
						<Button
							variant="ghost"
							size="icon-sm"
							disabled={index >= items.length - 1 || saving}
							aria-label={t("previewNextAction")}
							onClick={() => {
								requestOrRun("next", () => {
									onStep(1)
								})
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
						<PreviewErrorBoundary key={item.data.uuid}>
							<PreviewBody
								item={item}
								editable={editable}
								onDirtyChange={setDirty}
								contentRef={contentRef}
							/>
						</PreviewErrorBoundary>
					</div>
					{/* Nested confirmation dialog — Base UI supports nesting a dialog inside another normally
					(see versions-dialog.tsx's own identical precedent); this must stay a child of the outer
					Dialog, not a sibling rendered outside it, for the stacked focus-trap/backdrop behavior to
					apply. Shared by close/prev/next — see PendingIntent — rather than one instance per trigger. */}
					<ConfirmDialog
						open={pendingIntent !== null}
						pending={false}
						title={t("previewUnsavedChangesTitle")}
						body={t("previewUnsavedChangesBody")}
						confirmLabel={t("previewDiscardAction")}
						cancelLabel={t("common:cancel")}
						destructive
						onOpenChange={open => {
							if (!open) {
								setPendingIntent(null)
							}
						}}
						onConfirm={handleUnsavedConfirm}
					/>
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

interface PreviewBodyProps {
	item: DriveItem
	editable: boolean
	onDirtyChange: (dirty: boolean) => void
	contentRef: RefObject<string | null>
}

// Dispatches to the right viewer by category — remounted (keyed by uuid, see the error boundary one
// level up) on every item change so a viewer's own pending/success/error state never flashes the
// previous item's content. Bytes are no longer loaded centrally here: image/video/audio each own their
// own data source (a streamed SW URL or a buffered blob, see image-viewer.tsx/media-viewer.tsx),
// pdf/docx each own a lazy chunk plus their own whole-buffer load (see pdf-viewer.tsx/docx-viewer.tsx)
// — a category still rendered by the fallback below (text/code/markdown) has nothing to load yet.
// `editable`/`onDirtyChange`/`contentRef` only ever reach TextViewer (the "text"/"code" case) — every
// other category ignores them.
function PreviewBody({ item, editable, onDirtyChange, contentRef }: PreviewBodyProps) {
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
		case "text":
		case "code":
			return (
				<Suspense
					fallback={
						<div className="flex size-full items-center justify-center">
							<Spinner className="size-6" />
						</div>
					}
				>
					<TextViewer
						item={item}
						alt={alt}
						editable={editable}
						onDirtyChange={onDirtyChange}
						contentRef={contentRef}
					/>
				</Suspense>
			)
		case "markdown":
			return (
				<Suspense
					fallback={
						<div className="flex size-full items-center justify-center">
							<Spinner className="size-6" />
						</div>
					}
				>
					<MarkdownViewer
						item={item}
						alt={alt}
					/>
				</Suspense>
			)
		// No viewer exists for "other" — canPreview already excludes it from ever reaching the overlay
		// at all (it's unreachable here in practice), kept as the exhaustive switch's required fallback.
		case "other":
			return (
				<div className="flex size-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
					{t("previewUnsupportedType")}
				</div>
			)
	}
}
