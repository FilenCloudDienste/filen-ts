import { useEffect, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { usePdfEditSession, type PdfEditSnapshot } from "@filen/office/react/pdfedit"
import { narrowToAnyFile } from "@/features/drive/lib/download"
import type { DriveItem } from "@/features/drive/lib/item"
import { SaveRefusedError, type PresentationSaveSource } from "@/features/drive/lib/previewSave.logic"
import { pdfMemoryConstrained } from "@/features/preview/lib/pdfLimits"
import type { PreviewAccessMode } from "@/features/preview/lib/accessMode"
import { PdfEditSwap, type PdfEditPhase } from "@/features/pdf/session/swap"
import { engineNeedsRespawn, openPdfEngine, openPdfEngineOnChannel, pdfEngineMemory } from "@/features/pdf/session/engineWorker"
import { pdfEditActions, type PdfSaveActionDeps } from "@/features/pdf/session/pdfEditActions"
import type { PdfPolicyState, PdfToolContext } from "@/features/pdf/tools/registry"
import type { PdfRibbonHistory } from "@/features/pdf/ribbon/pdfRibbon"
import { PdfRemoteChangeDialog } from "@/features/pdf/save/pdfRemoteChangeDialog"
import { accountQueryGet } from "@/queries/account"
import { useIsOnline } from "@/lib/useIsOnline"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { Button } from "@/components/ui/button"

// The PDF viewer's editing: the swap to the editor, the session's state for the view (history, policy, banners), and
// the saves the preview overlay drives (its port save, through `saveRef`) or the ribbon asks for (Save as copy).

export interface PdfEditHost {
	// The slot may save a new version (canEditPdf, and not made read-only).
	readonly writable: boolean
	readonly onDirtyChange: (dirty: boolean) => void
	readonly saveRef: RefObject<PresentationSaveSource | null>
	// The overlay's Save, with its guards; true when one started.
	readonly onSave: () => boolean
}

export interface PdfEditView {
	readonly swap: PdfEditSwap
	readonly phase: PdfEditPhase
	readonly snapshot: PdfEditSnapshot | null
	readonly policy: PdfPolicyState
	readonly toolContext: PdfToolContext
	readonly history: PdfRibbonHistory | null
	readonly saveSource: PresentationSaveSource | null
	readonly activeTool: string | null
	readonly setActiveTool: (tool: string | null) => void
	// Banners under the ribbon (editor unavailable, poisoned).
	readonly banner: ReactNode
	readonly dialogs: ReactNode
}

const LINE = "flex shrink-0 items-center gap-2 border-b bg-muted px-3 py-1.5 text-xs text-muted-foreground"

export function usePdfEdit(item: DriveItem, access: PreviewAccessMode, host: PdfEditHost | undefined): PdfEditView {
	const { t } = useTranslation("preview")
	const online = useIsOnline()
	const [swap] = useState(
		() =>
			new PdfEditSwap({
				open: (file, password, onPoisoned) =>
					openPdfEngine({ file, access, role: "edit", ...(password === undefined ? {} : { password }), onPoisoned }),
				mobile: pdfMemoryConstrained(),
				onChangeFailed: () => {
					toast.error(t("previewPdfChangeFailed"))
				}
			})
	)

	// The file the editor opens: the slot's current version.
	useEffect(() => {
		swap.setFile(narrowToAnyFile(item))
	}, [swap, item])
	const phase = useSyncExternalStore(swap.subscribe, swap.getSnapshot)
	const snapshot = usePdfEditSession(phase.kind === "editing" ? phase.session : null)
	const dirty = snapshot?.state.dirty ?? false
	const [activeTool, setActiveTool] = useState<string | null>(null)
	const [remote, setRemote] = useState<{ readonly answer: (answer: "copy" | "version" | "cancel") => void } | null>(null)
	const onDirtyChange = host?.onDirtyChange

	useEffect(() => {
		onDirtyChange?.(dirty)
	}, [dirty, onDirtyChange])

	// The viewer going away closes the editor with it (its unsaved changes were asked about by the overlay).
	useEffect(
		() => () => {
			swap.close()
		},
		[swap]
	)

	const saveDeps = (): PdfSaveActionDeps | null =>
		phase.kind !== "editing"
			? null
			: {
					engine: phase.engine,
					session: phase.session,
					memory: pdfEngineMemory(),
					password: swap.password(),
					openVerifier: (channel, password) => openPdfEngineOnChannel(channel, password),
					versioning: () => accountQueryGet()?.versioningEnabled,
					needsRespawn: engineNeedsRespawn,
					respawn: saved =>
						swap.respawn((password, onPoisoned) =>
							openPdfEngine({
								file: narrowToAnyFile(saved),
								access,
								role: "edit",
								...(password === undefined ? {} : { password }),
								onPoisoned
							})
						),
					onHistoryReset: () => {
						toast.info(t("previewPdfHistoryReset"))
					},
					askRemote: () =>
						new Promise(resolve => {
							setRemote({
								answer: answer => {
									setRemote(null)
									resolve(answer)
								}
							})
						}),
					copySuffix: number => (number <= 1 ? t("previewPdfSaveCopySuffix") : t("previewPdfSaveCopySuffixNumbered", { number })),
					onCopied: name => {
						toast.success(t("previewPdfSavedAsCopy", { name }))
					},
					onCopyFailed: error => {
						toast.error(
							error instanceof SaveRefusedError
								? t(error.messageKey)
								: error === null
									? t("previewPdfSaveFailed")
									: errorLabel(error)
						)
					}
				}

	const actions = pdfEditActions(saveDeps, item)

	const session = phase.kind === "editing" ? phase.session : null
	const history: PdfRibbonHistory | null =
		snapshot === null || session === null
			? null
			: {
					dirty,
					canUndo: snapshot.state.canUndo && snapshot.pending === 0,
					canRedo: snapshot.state.canRedo && snapshot.pending === 0,
					saving: false,
					canSave: dirty && online && host?.writable === true,
					undo: () => {
						void session.undo().catch(() => undefined)
					},
					redo: () => {
						void session.redo().catch(() => undefined)
					},
					save: () => {
						host?.onSave()
					},
					saveAsCopy: () => {
						void actions.saveCopy()
					},
					discard: () => {
						swap.close()
					}
				}

	const banner =
		phase.kind === "failed" ? (
			<div
				role="status"
				className={LINE}
			>
				<p className="min-w-0 flex-1">{t("previewPdfEditorUnavailable")}</p>
				<Button
					variant="outline"
					size="xs"
					onClick={() => {
						swap.retry()
					}}
				>
					{t("previewPdfEditorRetry")}
				</Button>
			</div>
		) : phase.kind === "poisoned" ? (
			<div
				role="alert"
				className={LINE}
			>
				<p className="min-w-0 flex-1">{t("previewPdfPoisoned")}</p>
			</div>
		) : null

	return {
		swap,
		phase,
		snapshot,
		policy: { editable: host?.writable === true, online, tools: snapshot?.state.tools ?? null },
		toolContext: {
			edit: change => {
				swap.edit(change)
			},
			finish: () => {
				setActiveTool(null)
			}
		},
		history,
		// The overlay's Save streams through this while the editor has the document (never an autosave: PDFs save only
		// when asked).
		saveSource: phase.kind === "editing" ? options => (options.auto ? Promise.resolve(null) : actions.saveVersion()) : null,
		activeTool,
		setActiveTool,
		banner,
		dialogs: (
			<PdfRemoteChangeDialog
				open={remote !== null}
				onAnswer={answer => {
					remote?.answer(answer)
				}}
			/>
		)
	}
}
