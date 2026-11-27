import { useEffect, useRef, useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { XIcon } from "lucide-react"
import { scheduleIdle } from "@filen/shared/dom/scheduleIdle"
import { type PdfErrorKind, type PdfSource } from "@filen/office/dom/pdf"
import { usePdfDocument, type PdfDomDocument } from "@filen/office/react/pdf"
import { type DriveItem } from "@/features/drive/lib/item"
import { usePreviewBytes } from "@/features/preview/hooks/usePreviewBytes"
import { usePreviewRangeSource } from "@/features/preview/hooks/usePreviewRangeSource"
import { pdfViewerSetup } from "@/features/preview/lib/pdfViewerSetup"
import { useLeaveViewerFullScreen } from "@/features/preview/components/commandBar.logic"
import { PreviewDownloadableProvider, useProvidedPreviewOrigin, type PreviewAccessMode } from "@/features/preview/lib/accessMode"
import { IN_EDITORS_AND_FIELDS, useAction } from "@/lib/keymap/useAction"
import { Button } from "@/components/ui/button"
import { TooltipIconButton } from "@/components/ui/tooltipIconButton"
import { InputDialog } from "@/components/dialogs/inputDialog"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { PreviewErrorState, PreviewGate, PreviewLoading } from "@/features/preview/components/previewErrorState"
import "@filen/office/css/pdf.css"
import "@/features/preview/components/pdfTheme.css"
import { recoverIfNewerBuild } from "@/lib/appUpdate"
import { usePasswordDraft } from "@/features/preview/lib/passwordDraft"
import { BLOCK_BYTES } from "@filen/shared/videos"
import { useSignatureVerifier } from "@/features/pdf/signatures/useSignatureVerifier"
import { usePdfEdit, type PdfEditHost, type PdfEditView } from "@/features/pdf/session/usePdfEdit"
import type { PdfDraft, PdfPagesController } from "@/features/pdf/pages/pagesController"
import { batchCopyNames } from "@/features/pdf/pages/names"
import { usePreviewAccessMode } from "@/features/preview/lib/accessMode"
import type { DriveVariant } from "@/features/drive/lib/preferences"
import { pdfTooLargeToEdit, type PresentationSaveSource } from "@/features/drive/lib/previewSave.logic"
import { pdfEngineMemory } from "@/features/pdf/session/engineWorker"
import { driveItemName, formatBytes } from "@filen/shared"
import { PdfReaderShell, type PdfSignatures } from "@/features/preview/components/pdfReaderShell"
import { PDFJS } from "@/features/preview/lib/pdfjsModule"

export interface PdfViewerProps {
	item: DriveItem
	alt: string
	variant?: DriveVariant
	onOpenFile?: (item: DriveItem) => void
	// Present where the slot's file may be edited and saved (the preview overlay's save path).
	editing?: PdfEditHost
}

type PasswordAttempt = "initial" | "retry"

// The password prompt: the shared single-field dialog, nested in the preview overlay's own. Dismissing it leaves
// pdf.js waiting (it does not fail the task), so a button stands in to open it again. In a preview overlay, a
// newer version of the file shown meanwhile asks again as this one was left: dismissed, or with what was typed
// (PasswordDraft).
export function PdfPasswordPrompt({ attempt, onSubmit }: { attempt: PasswordAttempt; onSubmit: (password: string) => void }) {
	const { t } = useTranslation("preview")
	const draft = usePasswordDraft()
	const [dismissed, setDismissed] = useState(() => draft?.dismissed ?? false)
	// What the field starts from when it opens: the carried draft at first, blank once dismissed.
	const [seed, setSeed] = useState(() => draft?.password ?? "")

	return (
		<div className="flex size-full items-center justify-center px-6">
			{dismissed ? (
				<Button
					variant="outline"
					onClick={() => {
						setDismissed(false)
						draft?.dismiss(false)
					}}
				>
					{t("previewPdfPasswordReopen")}
				</Button>
			) : null}
			<InputDialog
				open={!dismissed}
				pending={false}
				title={t("previewPdfPasswordTitle")}
				body={attempt === "retry" ? t("previewPdfPasswordRetryBody") : t("previewPdfPasswordBody")}
				label={t("previewPdfPasswordLabel")}
				secret
				submitLabel={t("previewPdfPasswordSubmit")}
				initialValue={seed}
				validate={value => value.length > 0}
				onOpenChange={open => {
					setDismissed(!open)
					draft?.dismiss(!open)

					if (!open) {
						setSeed("")
					}
				}}
				onValueChange={value => {
					draft?.keep(value, false)
				}}
				onSubmit={value => {
					draft?.keep("", false)
					onSubmit(value)
				}}
			/>
		</div>
	)
}

interface PdfDocumentProps {
	item: DriveItem
	notice: ReactNode
	edit: PdfEditView | null
	source: PdfSource
	alt: string
	// The file's size (a ranged source reads less up front).
	size: number
	// Opens the source again: a ranged source's own retry gets a new port.
	onRetry?: () => void
	signatures: PdfSignatures
}

function loadFailedKey(kind: PdfErrorKind): "previewPdfReadFailed" | "previewPdfLoadFailed" {
	return kind === "transportFailed" ? "previewPdfReadFailed" : "previewPdfLoadFailed"
}

function PdfDocument({ item, notice, edit, source, alt, size, onRetry, signatures }: PdfDocumentProps) {
	const { t } = useTranslation("preview")
	const { state, password, retry, fullyRead, resident, reopen, acceptedPassword, release } = usePdfDocument(
		PDFJS,
		source,
		pdfViewerSetup().options
	)
	const failed = state.status === "error"
	const ready = state.status === "ready" ? state.document : null
	const swap = edit?.swap ?? null
	const editing = edit?.phase.kind === "editing"
	// The editor starting from this document (it reads its facts) or holding it: nothing reopens it meanwhile.
	const editorHolds = editing || edit?.phase.kind === "starting"

	// The editor takes the view from this document (and the password pdf.js accepted for it, memory only).
	useEffect(() => {
		if (swap === null || ready === null) {
			return
		}

		swap.setViewer(ready, acceptedPassword())

		return () => {
			swap.setViewer(null, null)
		}
	}, [swap, ready, acceptedPassword])

	// Once the editor has the document, pdf.js closes: its file buffer goes, its painted pages stay on screen.
	useEffect(() => {
		if (editing) {
			release()
		}
	}, [editing, release])

	// A form or signatures: the editor is likely wanted, so it is fetched while the reader is idle.
	useEffect(() => {
		if (swap === null || ready === null) {
			return
		}

		return prefetchWhenIdle(ready, swap)
	}, [swap, ready])

	useEffect(() => {
		if (failed) {
			// pdf.worker is its own file: a deploy that changed it fails documents in older tabs.
			recoverIfNewerBuild()
		}
	}, [failed])

	if (state.status === "loading") {
		return <PreviewLoading />
	}

	if (state.status === "password") {
		return (
			<PdfPasswordPrompt
				attempt={state.reason === "incorrect" ? "retry" : "initial"}
				onSubmit={password}
			/>
		)
	}

	if (state.status === "error") {
		return (
			<PreviewErrorState
				message={t(loadFailedKey(state.kind))}
				onRetry={onRetry ?? retry}
			/>
		)
	}

	return (
		<PdfReaderShell
			item={item}
			notice={notice}
			document={edit?.snapshot?.document ?? state.document}
			viewerDocument={state.document}
			edit={edit}
			alt={alt}
			size={size}
			fullyRead={fullyRead && !editorHolds}
			resident={resident && !editorHolds}
			ranged={source.kind === "ranges" && !fullyRead}
			onReopen={reopen}
			signatures={signatures}
			publishes={signatures.kind === "current"}
		/>
	)
}

interface PdfSourceProps {
	item: DriveItem
	alt: string
	// Bytes [0, limit) only: the version a signature signed.
	limit: number | undefined
	signatures: PdfSignatures
	edit: PdfEditView | null
	notice: ReactNode
}

export function BufferedPdf({ item, alt, limit, signatures, edit, notice }: PdfSourceProps) {
	return (
		<PreviewGate result={usePreviewBytes(item)}>
			{ready => (
				<BufferedPdfDocument
					bytes={ready.bytes}
					item={item}
					notice={notice}
					edit={edit}
					alt={alt}
					limit={limit}
					signatures={signatures}
				/>
			)}
		</PreviewGate>
	)
}

function bytesSource(bytes: Uint8Array, limit: number | undefined): PdfSource {
	return { kind: "bytes", bytes: limit === undefined ? bytes : bytes.subarray(0, limit) }
}

// The source is held for its bytes and limit: a view [0, limit) built again would be a new source to pdf.js, which
// reopens the document (a rename or a favorite would reset the reader).
function BufferedPdfDocument({ bytes, limit, ...rest }: Omit<PdfSourceProps, "limit"> & { bytes: Uint8Array; limit: number | undefined }) {
	const [held, setHeld] = useState(() => ({ bytes, limit, source: bytesSource(bytes, limit) }))
	let current = held

	if (held.bytes !== bytes || held.limit !== limit) {
		current = { bytes, limit, source: bytesSource(bytes, limit) }
		setHeld(current)
	}

	return (
		<PdfDocument
			{...rest}
			source={current.source}
			size={limit ?? bytes.byteLength}
		/>
	)
}

function RangedPdf({ item, alt, limit, signatures, edit, notice }: PdfSourceProps) {
	return (
		<PreviewGate result={usePreviewRangeSource(item, limit === undefined ? undefined : { limit })}>
			{ready => (
				<PdfDocument
					item={item}
					notice={notice}
					edit={edit}
					source={ready.source}
					alt={alt}
					size={limit ?? Number(item.data.size)}
					onRetry={ready.refetch}
					signatures={signatures}
				/>
			)}
		</PreviewGate>
	)
}

// pdf.js reads the file on demand through a range port to the SDK worker, aligned to its blocks, so a large file opens
// after reading its first pages. A file of one block or less is read whole and kept in the session's preview cache,
// as is an archive's entry (bytes from the archive, not the drive).
export function PdfViewer({ item, alt, variant, editing, onOpenFile }: PdfViewerProps) {
	useLeaveViewerFullScreen()

	const { t } = useTranslation("preview")

	const entry = useProvidedPreviewOrigin()
	const access = usePreviewAccessMode()
	// An archive's entry is not a drive file the editor could read or save.
	const edit = usePdfEdit(item, access, entry === null ? editing : undefined, onOpenFile === undefined ? undefined : { onOpenFile })
	const editView = entry === null && editing !== undefined ? edit : null
	const holding = edit.phase.kind === "starting" || edit.phase.kind === "editing"
	// The file pdf.js opened: kept while the editor holds the document (its saves make new versions under it).
	const [shownItem, setShownItem] = useState(item)

	if (!holding && shownItem.data.uuid !== item.data.uuid) {
		setShownItem(item)
	}

	// pdf.js closed its document when the editor took over: one the editor let go of (Discard, a poisoned engine) opens
	// pdf.js anew on the file.
	const [view, setView] = useState({ held: false, generation: 0 })

	if (edit.phase.kind === "editing" && !view.held) {
		setView({ held: true, generation: view.generation })
	} else if (!holding && view.held) {
		setView({ held: false, generation: view.generation + 1 })
	}

	const verify = useSignatureVerifier(item, edit.swap)
	// The byte length of the signed version shown instead of the file, or null for the file itself.
	const [signedVersion, setSignedVersion] = useState<number | null>(null)
	const signatures: PdfSignatures =
		signedVersion === null
			? { kind: "current", verify, onViewSignedVersion: setSignedVersion }
			: {
					kind: "signedVersion",
					onBack: () => {
						setSignedVersion(null)
					}
				}
	const limit = signedVersion ?? undefined
	// A new key per version shown: the document, its viewer state and its reads start over.
	const key = signedVersion === null ? `file-${String(view.generation)}` : `signed-${String(signedVersion)}`
	const editMaxBytes = pdfEngineMemory().editMaxBytes
	// A file the tools would edit but for its size: said once, under the ribbon.
	const notice =
		variant !== undefined && entry === null && signedVersion === null && pdfTooLargeToEdit(item, variant, editMaxBytes) ? (
			<div
				role="status"
				className="flex shrink-0 items-center gap-2 border-b bg-muted px-3 py-1.5 text-xs text-muted-foreground"
			>
				<p className="min-w-0 flex-1">{t("previewPdfTooLarge", { size: formatBytes(editMaxBytes) })}</p>
			</div>
		) : null
	// The signed version is a read-only view of bytes, never the editor's.
	const sourceEdit = signedVersion === null ? editView : null
	// Extracted pages open as a new document over this one.
	const draft = editView?.draft ?? null

	// The signed version of the file as it now is (the editor's saves may have signed it since pdf.js opened it).
	const sourceItem = signedVersion === null ? shownItem : item
	const ranged = entry === null && Number(sourceItem.data.size) > BLOCK_BYTES
	const source = ranged ? (
		<RangedPdf
			key={key}
			item={sourceItem}
			alt={alt}
			limit={limit}
			signatures={signatures}
			edit={sourceEdit}
			notice={notice}
		/>
	) : (
		<BufferedPdf
			key={key}
			item={sourceItem}
			alt={alt}
			limit={limit}
			signatures={signatures}
			edit={sourceEdit}
			notice={notice}
		/>
	)

	return (
		<>
			{editing !== undefined && editView !== null ? (
				<PdfSaveBinding
					saveRef={editing.saveRef}
					saveSource={editView.saveSource}
				/>
			) : null}
			{source}
			{draft === null ? null : (
				<PdfDraftDocument
					key={draft.id}
					draft={draft}
					item={item}
					access={access}
					controller={edit.pages}
				/>
			)}
		</>
	)
}

// A draft saves only through its own Save: never the overlay's.
const DRAFT_HOST: PdfEditHost = {
	writable: true,
	onDirtyChange: () => undefined,
	saveRef: { current: null },
	onSave: () => false
}

const NO_SIGNED_VERSION = (): void => undefined

// Extracted pages as a new, unsaved PDF over the one they came from (its own full-screen layer, the editor's ribbon and
// tools on a second engine): Save makes it a file beside `item`, named as Extract said; closing it unsaved asks first,
// and neither closes nor discards while its save runs. The PDF behind stays as it was (its view, its changes) and keeps
// the draft's bytes until the draft ends.
export function PdfDraftDocument({
	draft,
	item,
	access,
	controller
}: {
	draft: PdfDraft
	item: DriveItem
	access: PreviewAccessMode
	controller: PdfPagesController
}) {
	const { t } = useTranslation(["preview", "common"])
	const popupRef = useRef<HTMLDivElement | null>(null)
	const [asking, setAsking] = useState(false)
	const edit = usePdfEdit(item, access, DRAFT_HOST, {
		draft: {
			draft,
			onEnd: saved => {
				controller.closeDraft(saved)
			}
		}
	})
	const name = batchCopyNames(driveItemName(item), [draft.suffix], new Set())[0] ?? driveItemName(item)
	const history = edit.history
	const saving = history?.saving === true

	// Mod+S in the draft's layer saves the draft (the overlay's Save stands down for a layer over it).
	useAction(
		"preview.save",
		keyboardEvent => {
			const popup = popupRef.current

			if (popup === null || !(keyboardEvent.target instanceof Node) || !popup.contains(keyboardEvent.target)) return

			keyboardEvent.preventDefault()

			if (history?.canSave === true) history.save()
		},
		IN_EDITORS_AND_FIELDS,
		[history]
	)

	const snapshot = edit.snapshot
	const body =
		edit.phase.kind === "failed" ? (
			<PreviewErrorState
				message={t("previewPdfEditorUnavailable")}
				onRetry={() => {
					edit.swap.retry()
				}}
			/>
		) : edit.phase.kind === "poisoned" ? (
			<PreviewErrorState message={t("previewPdfPoisoned")} />
		) : snapshot === null ? (
			<PreviewLoading />
		) : (
			// Download would save the PDF behind, not this one: Save is the way to keep it.
			<PreviewDownloadableProvider
				downloadable
				onDownload={null}
			>
				<PdfReaderShell
					item={item}
					notice={null}
					document={snapshot.document}
					viewerDocument={snapshot.document}
					edit={edit}
					alt={name}
					size={draft.size}
					fullyRead={false}
					resident={false}
					ranged
					onReopen={NO_SIGNED_VERSION}
					signatures={{ kind: "current", verify: null, onViewSignedVersion: NO_SIGNED_VERSION }}
				/>
			</PreviewDownloadableProvider>
		)

	return (
		<DialogPrimitive.Root
			open
			onOpenChange={(next, details) => {
				if (next) return

				details.cancel()

				// An Escape something inside took already (the find field, a tool) is not a close.
				if (saving || (details.reason === "escape-key" && details.event.defaultPrevented)) return

				setAsking(true)
			}}
		>
			<DialogPrimitive.Portal>
				<DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-background" />
				<DialogPrimitive.Popup
					ref={popupRef}
					initialFocus={popupRef}
					className="fixed inset-0 z-50 flex flex-col bg-background outline-none"
				>
					<header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
						<DialogPrimitive.Title className="min-w-0 truncate font-heading text-sm font-medium">{name}</DialogPrimitive.Title>
						<span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
							{t("previewPdfDraftUnsaved")}
						</span>
						<div className="flex-1" />
						<TooltipIconButton
							label={t("common:close")}
							disabled={saving}
							onClick={() => {
								setAsking(true)
							}}
						>
							<XIcon />
						</TooltipIconButton>
					</header>
					<div className="min-h-0 flex-1">{body}</div>
					<ConfirmDialog
						open={asking}
						pending={saving}
						title={t("previewPdfDraftDiscardTitle")}
						body={t("previewPdfDraftDiscardBody")}
						confirmLabel={t("previewPdfDiscardConfirm")}
						cancelLabel={t("common:cancel")}
						destructive
						onOpenChange={setAsking}
						onConfirm={() => {
							// A question asked before the save started does not discard during it.
							if (saving) return

							setAsking(false)
							controller.closeDraft(false)
						}}
					/>
				</DialogPrimitive.Popup>
			</DialogPrimitive.Portal>
		</DialogPrimitive.Root>
	)
}

// The overlay's Save streams through the editor while it has the document.
function PdfSaveBinding({ saveRef, saveSource }: { saveRef: PdfEditHost["saveRef"]; saveSource: PresentationSaveSource | null }) {
	useEffect(() => {
		if (saveSource === null) {
			return
		}

		saveRef.current = saveSource

		return () => {
			if (saveRef.current === saveSource) {
				saveRef.current = null
			}
		}
	}, [saveRef, saveSource])

	return null
}

// Fetches the editor while the reader is idle when the document has a form or signatures (pdf.js's information says,
// with no page read). Returns the cancel.
function prefetchWhenIdle(document: PdfDomDocument, swap: { prefetchIdle(): void }): () => void {
	let live = true
	let cancelIdle: (() => void) | null = null

	void document.getMetadata().then(
		({ info }) => {
			const record = typeof info === "object" && info !== null ? info : {}
			const wanted = Reflect.get(record, "IsAcroFormPresent") === true || Reflect.get(record, "IsSignaturesPresent") === true

			if (!live || !wanted) {
				return
			}

			cancelIdle = scheduleIdle(
				() => {
					swap.prefetchIdle()
				},
				{ fallbackMs: 2000 }
			)
		},
		() => undefined
	)

	return () => {
		live = false
		cancelIdle?.()
	}
}
