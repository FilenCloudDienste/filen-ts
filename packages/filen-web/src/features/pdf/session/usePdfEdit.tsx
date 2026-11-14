import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { driveItemName } from "@filen/shared"
import { usePdfEditSession, type PdfEditSnapshot } from "@filen/office/react/pdfedit"
import { currentRootUuid } from "@/features/drive/lib/actions"
import { narrowToAnyFile } from "@/features/drive/lib/download"
import { asDirectoryOrFile, type DriveItem } from "@/features/drive/lib/item"
import { SaveRefusedError, type PresentationSaveSource } from "@/features/drive/lib/previewSave.logic"
import { normalizeParentUuid } from "@/features/drive/queries/drive"
import { takenNames } from "@/features/preview/imageEdit/editSession"
import { failureReason } from "@/features/pdf/redact/redaction.logic"
import { EarlierVersionsWarning } from "@/features/pdf/save/earlierVersionsWarning"
import { PdfRedactionRefusedError } from "@/features/pdf/save/pdfSave"
import { useProtectNotices } from "@/features/pdf/security/protectNotices"
import { SignatureInvalidationDialog } from "@/features/pdf/signing/signatureInvalidationDialog"
import { PROTECT_DOCUMENT_TOOL_ID } from "@/features/pdf/tools/protect.tool"
import { pdfMemoryConstrained } from "@/features/preview/lib/pdfLimits"
import type { PreviewAccessMode } from "@/features/preview/lib/accessMode"
import { PdfEditSwap, type PdfEditPhase } from "@/features/pdf/session/swap"
import {
	engineNeedsRespawn,
	openPdfEditEngineOnChannel,
	openPdfEngine,
	openPdfEngineOnChannel,
	pdfEngineMemory
} from "@/features/pdf/session/engineWorker"
import { pdfEditActions, type PdfSaveActionDeps, type PdfSaveRequest } from "@/features/pdf/session/pdfEditActions"
import { withPdfSession, type PdfPolicyState, type PdfToolContext, type PdfToolSaveOutcome } from "@/features/pdf/tools/registry"
import { PDF_TOOLS } from "@/features/pdf/tools"
import { flattenedFirst, historyStep, pdfToolSurfaceKey } from "@/features/pdf/session/toolSession"
import { useBindings } from "@/lib/keymap/registry"
import { pdfSignatureFields, type PdfSignatureFieldHint, type PdfSignatureSource } from "@filen/office/dom/pdf"
import { signWithCertificate, type PdfSignedSaveJob } from "@/features/pdf/signing/signDocument"
import { PdfNoticeLine } from "@/features/pdf/tools/noticeLine"
import type { PdfRibbonHistory } from "@/features/pdf/ribbon/pdfRibbon"
import { PdfRemoteChangeDialog } from "@/features/pdf/save/pdfRemoteChangeDialog"
import { pdfFormSaveGate, type PdfFormSaveChoice } from "@/features/pdf/forms/formSave"
import { PdfXfaSaveDialog } from "@/features/pdf/forms/formNotices"
import { formOverlaySession } from "@/features/pdf/session/fieldOverlay.logic"
import { accountKeepsVersions } from "@/features/pdf/save/accountVersions"
import { PdfEngineError } from "@filen/office/dom/pdfedit"
import { useIsOnline } from "@/lib/useIsOnline"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { useAnnouncement } from "@/features/pdf/tools/liveRegion"
import { PdfPagesController, type PdfDraft } from "@/features/pdf/pages/pagesController"
import { writeEditedCopy } from "@/features/preview/lib/editedCopy"
import { recordOwnSave } from "@/features/preview/lib/ownSaves"
import { log } from "@/lib/log"

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
	// The chosen variant of each tool with variants.
	readonly toolVariants: Readonly<Record<string, string>>
	readonly setActiveTool: (tool: string | null, variant?: string) => void
	// A key on the page surface `surface` (0-based `page` in view): a tool's letter, or a key for the tool in effect.
	// True when a tool took it.
	readonly onSurfaceKey: (event: KeyboardEvent, surface: Element, page: number) => boolean
	// The pages rail's state and the page operations.
	readonly pages: PdfPagesController
	// Banners under the ribbon (editor unavailable, poisoned, protection, a tool's notice).
	readonly banner: ReactNode
	readonly dialogs: ReactNode
	// What the signature status reads the signatures from once the editor reads a file a save here wrote (the engine's
	// own reading of it); null: the viewer's document.
	readonly signatureSource: PdfSignatureSource | null
	// Extracted pages open as a new document over this one (shown in its own view), null when none is.
	readonly draft: PdfDraft | null
}

// The editor of a new document of extracted pages (pagesController PdfDraft), not saved anywhere yet: it opens at once,
// counts as unsaved until saved, and saves only as a copy beside the PDF it came from (named with the draft's suffix).
export interface PdfEditDraft {
	readonly draft: PdfDraft
	// The draft ends: saved, or dropped.
	readonly onEnd: (saved: boolean) => void
}

// The signatures of the file `file` as a pdf.js document reports them, from `read`.
function editorSignatureSource(
	file: string,
	read: () => Promise<readonly PdfSignatureFieldHint[] | null>
): { readonly file: string; readonly source: PdfSignatureSource } {
	return {
		file,
		source: {
			getSignatures: () =>
				read().then(hints =>
					hints === null ? null : hints.map(hint => ({ fieldName: hint.name, byteRange: [...hint.byteRange] }))
				)
		}
	}
}

const LINE = "flex shrink-0 items-center gap-2 border-b bg-muted px-3 py-1.5 text-xs text-muted-foreground"

// A change the engine refused, as the user is told it.
function changeFailedKey(error: unknown): "previewPdfOverBudget" | "previewPdfChangeFailed" {
	return error instanceof PdfEngineError && error.failure === "overBudget" ? "previewPdfOverBudget" : "previewPdfChangeFailed"
}

export interface PdfEditOptions {
	// The editor of a new document of extracted pages instead of the file `item` (which names and places its copy).
	readonly draft?: PdfEditDraft
	// Opens a file this editor wrote (a saved copy), where the viewer can.
	readonly onOpenFile?: (item: DriveItem) => void
}

export function usePdfEdit(
	item: DriveItem,
	access: PreviewAccessMode,
	host: PdfEditHost | undefined,
	options?: PdfEditOptions
): PdfEditView {
	const draft = options?.draft
	const onOpenFile = options?.onOpenFile
	const { t } = useTranslation("preview")
	const online = useIsOnline()
	const [swap] = useState(
		() =>
			new PdfEditSwap({
				open: (file, password, onPoisoned) =>
					draft === undefined
						? openPdfEngine({ file, access, role: "edit", ...(password === undefined ? {} : { password }), onPoisoned })
						: draft.draft.open(onPoisoned),
				mobile: pdfMemoryConstrained(),
				onChangeFailed: error => {
					toast.error(t(changeFailedKey(error)))
				}
			})
	)

	// The file the editor opens: the slot's current version.
	useEffect(() => {
		swap.setFile(narrowToAnyFile(item))
	}, [swap, item])

	// A draft has no viewer before the editor: the editor opens it at once, with the password it was written with.
	const draftPassword = draft?.draft.password
	const isDraft = draft !== undefined

	useEffect(() => {
		if (!isDraft) return

		swap.setPassword(draftPassword)
		swap.warm()
	}, [swap, isDraft, draftPassword])
	const phase = useSyncExternalStore(swap.subscribe, swap.getSnapshot)
	const snapshot = usePdfEditSession(phase.kind === "editing" ? phase.session : null)
	const form = formOverlaySession(swap)
	// Text typed into a field and not committed yet is unsaved too (a save commits it first).
	const drafted = useSyncExternalStore(form.subscribe, form.drafted)
	const dirty = (snapshot?.state.dirty ?? false) || drafted
	// A save holds the document (its changes wait for it).
	const saving = phase.kind === "editing" && phase.saving
	const [activeTool, setActiveToolState] = useState<string | null>(null)
	const [toolVariants, setToolVariants] = useState<Readonly<Record<string, string>>>({})
	// The Save menu's "Flatten annotations" (off until chosen; for this editing session).
	const [flatten, setFlatten] = useState(false)
	const combos = useBindings()
	const [remote, setRemote] = useState<{ readonly answer: (answer: "copy" | "version" | "cancel") => void } | null>(null)
	const [xfa, setXfa] = useState<{ readonly answer: (answer: PdfFormSaveChoice) => void } | null>(null)
	// A save about to invalidate signatures, asking first.
	const [invalidation, setInvalidation] = useState<{ readonly count: number; readonly answer: (confirmed: boolean) => void } | null>(null)
	// The version an in-place save that removed content just wrote (its earlier versions still hold that content).
	const [earlier, setEarlier] = useState<DriveItem | null>(null)
	const [pages] = useState(() => new PdfPagesController())
	// Extracted pages open as a new document over this one: unsaved until the draft is saved.
	const openDraft = useSyncExternalStore(pages.subscribe, () => pages.getSnapshot().draft)
	// The draft's Save as copy under way.
	const [draftSaving, setDraftSaving] = useState(false)
	const [notice, setNotice] = useState<ReactNode>(null)
	// The save a tool asked for, taken by the next Save the overlay runs.
	const saveRequest = useRef<PdfSaveRequest | null>(null)
	const onDirtyChange = host?.onDirtyChange

	useEffect(() => {
		onDirtyChange?.(dirty || openDraft !== null)
	}, [dirty, openDraft, onDirtyChange])

	// The viewer going away closes the editor with it, and drops a draft of its pages left open (its unsaved changes were
	// asked about by the overlay).
	useEffect(
		() => () => {
			pages.closeDraft(false)
			swap.close()
		},
		[swap, pages]
	)

	const session = phase.kind === "editing" ? phase.session : null

	// The second PDFs the engine held for inserting go with its session.
	useEffect(() => {
		pages.sessionChanged(session)
	}, [pages, session])

	useEffect(() => {
		pages.bind({
			t,
			edit: (change, dropped) => {
				swap.edit(change, dropped)
			},
			access,
			password: () => swap.password(),
			memory: pdfEngineMemory,
			openVerifier: (channel, password) => openPdfEngineOnChannel(channel, password),
			openEditor: openPdfEditEngineOnChannel,
			write: (content, suffix) => writeEditedCopy(item, content, "pdf", suffix),
			fileSize: draft?.draft.size ?? Number(item.data.size),
			onCopied: (names, items) => {
				for (const made of items) recordOwnSave(made.data.uuid)

				toast.success(t("previewPdfExtractSaved", { count: names.length, name: names[0] ?? "" }))
			},
			onFailed: key => {
				toast.error(t(key))
			}
		})
	})

	// A redaction check that failed on a save no Apply redactions dialog shows (Save, Save as copy): said with its reason.
	const reportRedactionRefusal = (error: PdfRedactionRefusedError): void => {
		const reason = failureReason(error.failure)

		toast.error(t("previewPdfRedactVerifyFailed", { reason: t(reason.key, reason.params) }))
	}

	const saveDeps = (): PdfSaveActionDeps | null =>
		phase.kind !== "editing"
			? null
			: {
					engine: phase.engine,
					session: phase.session,
					memory: pdfEngineMemory(),
					fileBytes: draft?.draft.size ?? Number(item.data.size),
					password: swap.password(),
					openVerifier: (channel, password) => openPdfEngineOnChannel(channel, password),
					versioning: accountKeepsVersions,
					hold: () => swap.hold(),
					commitDrafts: () =>
						form.commitDrafts((change, dropped) => {
							swap.edit(change, dropped)
						}),
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
					confirmInvalidation: count =>
						new Promise(resolve => {
							setInvalidation({
								count,
								answer: confirmed => {
									setInvalidation(null)
									resolve(confirmed)
								}
							})
						}),
					onProtected: password => {
						swap.setPassword(password)
					},
					onEarlierVersions: saved => {
						setEarlier(saved)
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
					beforeSave: requested =>
						pdfFormSaveGate(phase.session, requested, {
							askXfa: () =>
								new Promise(resolve => {
									setXfa({
										answer: answer => {
											setXfa(null)
											resolve(answer)
										}
									})
								}),
							warnRequired: count => {
								toast.warning(t("previewPdfFormRequiredEmpty", { count }), { id: "pdf-form-required" })
								form.warnRequired()
							}
						}),
					requestVersionSave: () => {
						host?.onSave()
					},
					copySuffix: number => (number <= 1 ? t("previewPdfSaveCopySuffix") : t("previewPdfSaveCopySuffixNumbered", { number })),
					onCopied: (name, copy) => {
						toast.success(
							t("previewPdfSavedAsCopy", { name }),
							copy === undefined || onOpenFile === undefined
								? undefined
								: {
										action: {
											label: t("previewPdfOpenCopy"),
											onClick: () => {
												onOpenFile(copy)
											}
										}
									}
						)
					},
					onCopyFailed: error => {
						if (error instanceof PdfRedactionRefusedError) reportRedactionRefusal(error)
						else if (!(error instanceof SaveRefusedError && error.silent))
							toast.error(
								error instanceof SaveRefusedError
									? t(error.messageKey)
									: error === null
										? t("previewPdfSaveFailed")
										: errorLabel(error)
							)
					},
					onVersionFailed: error => {
						if (error instanceof PdfRedactionRefusedError) reportRedactionRefusal(error)
					},
					takeRequest: () => {
						const request = saveRequest.current

						saveRequest.current = null

						return request
					}
				}

	const actions = pdfEditActions(saveDeps, item)

	// A Save the overlay runs now, for a tool (a save in place, or a signing save with `job`): how it ended. The overlay's
	// Save is retried while it has not seen the change yet (its dirty bit follows the editor's after a render), and is
	// cancelled when it cannot start (one under way, a dialog open).
	const requestSave = async (job: PdfSignedSaveJob | null, adopt = false): Promise<PdfToolSaveOutcome> => {
		// A draft is no file to save in place.
		if (host?.writable !== true || draft !== undefined) return { status: "cancelled" }

		let settle: (outcome: PdfToolSaveOutcome) => void = () => undefined
		const ended = new Promise<PdfToolSaveOutcome>(resolve => {
			settle = resolve
		})
		const request: PdfSaveRequest = {
			job,
			adopt,
			settle: outcome => {
				if (saveRequest.current === request) saveRequest.current = null

				settle(outcome)
			}
		}

		saveRequest.current = request

		for (let attempt = 0; attempt < 20; attempt++) {
			if (host.onSave()) return ended

			await new Promise(resolve => setTimeout(resolve, 50))
		}

		request.settle({ status: "cancelled" })

		return ended
	}

	// The signatures a verifier cross-checks its reading of the editor's file against: pdf.js's (read before the swap)
	// while the engine reads the file pdf.js read; once it reads one a save here wrote, the engine's own reading of it.
	const expectedSignatures = (): Promise<readonly PdfSignatureFieldHint[] | null> => {
		const current = swap.getSnapshot()

		if (current.kind !== "editing") return Promise.resolve(null)

		const { document, state } = current.session.getSnapshot()

		return current.respawned || state.ownFile
			? current.engine.client.call("signatureHints", {})
			: Promise.resolve(pdfSignatureFields(document.facts.signatures))
	}
	// The status line's source of those signatures once the editor reads a file it wrote (one per file); before, the
	// viewer's document answers for itself.
	const ownFile = phase.kind === "editing" && (phase.respawned || snapshot?.state.ownFile === true)
	// One source per file written (the status line reads each once).
	const [editorSignatures, setEditorSignatures] = useState<ReturnType<typeof editorSignatureSource> | null>(null)

	if (ownFile && editorSignatures?.file !== item.data.uuid) setEditorSignatures(editorSignatureSource(item.data.uuid, expectedSignatures))
	else if (!ownFile && editorSignatures !== null) setEditorSignatures(null)

	const signatureSource = ownFile && editorSignatures?.file === item.data.uuid ? editorSignatures.source : null

	// A draft's Save: a copy beside the PDF under the draft's name; once made, the draft ends saved.
	const saveDraft = (current: PdfEditDraft, live: NonNullable<typeof session>): void => {
		if (draftSaving || saving) return

		setDraftSaving(true)
		// What was typed into its fields is saved with it.
		void (saveDeps()?.commitDrafts() ?? Promise.resolve())
			.then(() => flattenedFirst(live, flatten, () => actions.saveCopyAs(current.draft.suffix)))
			.catch((error: unknown) => ({ status: "failed" as const, error }))
			.then(outcome => {
				setDraftSaving(false)

				if (outcome.status === "saved") {
					toast.success(t("previewPdfExtractSaved", { count: 1, name: outcome.name ?? "" }))
					current.onEnd(true)
				} else if (outcome.status === "failed") saveDeps()?.onCopyFailed(outcome.error)
			})
	}

	const history: PdfRibbonHistory | null =
		snapshot === null || session === null
			? null
			: {
					// A draft is unsaved until it is saved.
					dirty: dirty || draft !== undefined,
					canUndo: snapshot.state.canUndo && snapshot.pending === 0 && !saving,
					canRedo: snapshot.state.canRedo && snapshot.pending === 0 && !saving,
					saving: saving || draftSaving,
					canSave:
						draft === undefined ? dirty && online && host?.writable === true && !saving : online && !saving && !draftSaving,
					undo: () => {
						historyStep(() => session.undo(), "undo", t("previewPdfUndoFailed"))
					},
					redo: () => {
						historyStep(() => session.redo(), "redo", t("previewPdfRedoFailed"))
					},
					save: () => {
						if (draft !== undefined) saveDraft(draft, session)
						else if (!saving) host?.onSave()
					},
					saveAsCopy: () => {
						if (draft !== undefined) {
							saveDraft(draft, session)

							return
						}

						if (saving) return

						void flattenedFirst(session, flatten, () => actions.saveCopy()).catch((error: unknown) => {
							log.warn("pdf", "saving a copy failed", { error })
						})
					},
					security: () => {
						setActiveToolState(PROTECT_DOCUMENT_TOOL_ID)
					},
					discard: () => {
						if (draft === undefined) swap.close()
						else draft.onEnd(false)
					},
					...(draft === undefined ? {} : { draft: true }),
					flatten: {
						on: flatten,
						enabled: snapshot.state.tools.content === null,
						toggle: () => {
							setFlatten(!flatten)
						}
					}
				}

	const setActiveTool = (tool: string | null, variant?: string): void => {
		setActiveToolState(tool)

		if (tool !== null && variant !== undefined) setToolVariants({ ...toolVariants, [tool]: variant })
	}

	const poisoned = phase.kind === "poisoned"
	const editable = host?.writable === true && online && !poisoned
	const policy: PdfPolicyState = { editable: host?.writable === true, online, tools: snapshot?.state.tools ?? null, poisoned }
	const toolContext: PdfToolContext = {
		edit: (change, dropped) => {
			swap.edit(change, dropped)
		},
		finish: () => {
			setActiveToolState(null)
		},
		activate: setActiveTool,
		activeTool,
		swap,
		snapshot,
		editable,
		pages,
		host: {
			fileName: driveItemName(item),
			takenNames: () => {
				const base = asDirectoryOrFile(item)

				return base.type === "file"
					? takenNames(normalizeParentUuid(base.data.parent, currentRootUuid()))
					: Promise.resolve(new Set<string>())
			},
			canSaveInPlace: host?.writable === true && draft === undefined,
			save: target => (target.kind === "version" ? requestSave(null) : actions.saveCopyAs(target.suffix)),
			unlocked: password => {
				swap.setPassword(password)
			},
			close: () => {
				setActiveToolState(null)

				// A draft has no saved state to go back to: it closes (its pages stay in the PDF they came from).
				if (draft === undefined) swap.close()
				else draft.onEnd(false)
			}
		},
		notify: setNotice,
		sign: request =>
			signWithCertificate(
				{
					session: read => withPdfSession(toolContext, read),
					fileSize: () => Number(item.data.size),
					memory: pdfEngineMemory(),
					// The changes saved first are signed on next: the session goes on on that file.
					save: job => requestSave(job, job === null).then(outcome => outcome.status === "saved"),
					job: (signer, digest) => ({
						signer,
						digest,
						hints: expectedSignatures
					}),
					onSaveChangesFirst: () => {
						setNotice(
							<PdfNoticeLine
								onDismiss={() => {
									setNotice(null)
								}}
							>
								{t("previewPdfSignAfterChanges")}
							</PdfNoticeLine>
						)
					},
					onFailed: error => {
						toast.error(error instanceof SaveRefusedError ? t(error.messageKey) : t("previewPdfSigningFailed"))
					}
				},
				request
			)
	}

	const onSurfaceKey = (event: KeyboardEvent, surface: Element, page: number): boolean =>
		pdfToolSurfaceKey(event, surface, page, {
			tools: PDF_TOOLS,
			combos,
			activeTool,
			policy,
			context: toolContext,
			activate: setActiveTool
		})

	const protect = useProtectNotices({
		state: snapshot?.state ?? null,
		edit: (change, dropped) => {
			swap.edit(change, dropped)
		},
		onUnlocked: password => {
			swap.setPassword(password)
		}
	})

	// Said once the first change asks for the editor (its banner shows meanwhile).
	useAnnouncement(swap, phase.kind === "starting" ? t("previewPdfEditorStarting") : null)

	const failedBanner =
		phase.kind === "starting" ? (
			<div className={LINE}>
				<Spinner
					aria-hidden="true"
					className="size-3.5 shrink-0"
				/>
				<p className="min-w-0 flex-1">{t("previewPdfEditorStarting")}</p>
			</div>
		) : phase.kind === "failed" ? (
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
		) : phase.kind === "reopenFailed" ? (
			<div
				role="status"
				className={LINE}
			>
				<p className="min-w-0 flex-1">{t("previewPdfReopenFailed")}</p>
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
		) : (
			notice
		)

	return {
		swap,
		phase,
		snapshot,
		policy,
		toolContext,
		history,
		// The overlay's Save streams through this while the editor has the document (never an autosave: PDFs save only
		// when asked); with "Flatten annotations" chosen, they are drawn into the pages first (one undo step).
		// One save at a time: another asked for while one holds the document is refused quietly.
		saveSource:
			phase.kind === "editing" && draft === undefined
				? options =>
						options.auto
							? Promise.resolve(null)
							: saving
								? Promise.reject(new SaveRefusedError("previewPdfSaveFailed", { silent: true }))
								: flattenedFirst(session, flatten, () => actions.saveVersion())
				: null,
		activeTool,
		toolVariants,
		setActiveTool,
		onSurfaceKey,
		pages,
		banner: (
			<>
				{failedBanner}
				{protect.banner}
			</>
		),
		dialogs: (
			<>
				<PdfRemoteChangeDialog
					open={remote !== null}
					onAnswer={answer => {
						remote?.answer(answer)
					}}
				/>
				<PdfXfaSaveDialog
					open={xfa !== null}
					onAnswer={answer => {
						xfa?.answer(answer)
					}}
				/>
				<SignatureInvalidationDialog
					open={invalidation !== null}
					count={invalidation?.count ?? 0}
					pending={false}
					onOpenChange={open => {
						if (!open) invalidation?.answer(false)
					}}
					onConfirm={() => {
						invalidation?.answer(true)
					}}
				/>
				{earlier === null ? null : (
					<EarlierVersionsWarning
						item={earlier}
						open
						onOpenChange={open => {
							if (!open) setEarlier(null)
						}}
					/>
				)}
				{protect.dialog}
			</>
		),
		signatureSource,
		draft: openDraft
	}
}
