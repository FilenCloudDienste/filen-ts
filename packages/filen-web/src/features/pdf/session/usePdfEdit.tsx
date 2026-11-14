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
import { engineNeedsRespawn, openPdfEngine, openPdfEngineOnChannel, pdfEngineMemory } from "@/features/pdf/session/engineWorker"
import { pdfEditActions, type PdfSaveActionDeps, type PdfSaveRequest } from "@/features/pdf/session/pdfEditActions"
import { withPdfSession, type PdfPolicyState, type PdfToolContext, type PdfToolSaveOutcome } from "@/features/pdf/tools/registry"
import { PDF_TOOLS } from "@/features/pdf/tools"
import { flattenedFirst, pdfToolSurfaceKey } from "@/features/pdf/session/toolSession"
import { useBindings } from "@/lib/keymap/registry"
import { pdfSignatureFields, type PdfSignatureSource } from "@filen/office/dom/pdf"
import { signWithCertificate, type PdfSignedSaveJob } from "@/features/pdf/signing/signDocument"
import { PdfNoticeLine } from "@/features/pdf/tools/noticeLine"
import type { PdfRibbonHistory } from "@/features/pdf/ribbon/pdfRibbon"
import { PdfRemoteChangeDialog } from "@/features/pdf/save/pdfRemoteChangeDialog"
import { pdfFormSaveGate, type PdfFormSaveChoice } from "@/features/pdf/forms/formSave"
import { PdfXfaSaveDialog } from "@/features/pdf/forms/formNotices"
import { formOverlaySession } from "@/features/pdf/session/fieldOverlay.logic"
import { accountQueryGet } from "@/queries/account"
import { useIsOnline } from "@/lib/useIsOnline"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { Button } from "@/components/ui/button"
import { PdfPagesController } from "@/features/pdf/pages/pagesController"
import { writeEditedCopy } from "@/features/preview/lib/editedCopy"
import { recordOwnSave } from "@/features/preview/lib/ownSaves"

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
	// What the signature status reads the signatures from once a signing here changed them (pdf.js's view with the
	// signatures made since); null: the viewer's document.
	readonly signatureSource: PdfSignatureSource | null
}

// A signature signed here, as pdf.js reports one.
interface SignedHere {
	readonly fieldName: string
	readonly byteRange: readonly [number, number, number, number]
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
	const [notice, setNotice] = useState<ReactNode>(null)
	// The save a tool asked for, taken by the next Save the overlay runs.
	const saveRequest = useRef<PdfSaveRequest | null>(null)
	// Signatures signed while the editor has the document (gone with it: the viewer's next document sees them itself).
	const [signedHere, setSignedHere] = useState<readonly SignedHere[]>([])

	if (signedHere.length > 0 && phase.kind !== "editing" && phase.kind !== "starting") setSignedHere([])
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

	const session = phase.kind === "editing" ? phase.session : null

	// The second PDFs the engine held for inserting go with its session.
	useEffect(() => {
		pages.sessionChanged(session)
	}, [pages, session])

	useEffect(() => {
		pages.bind({
			t,
			edit: change => {
				swap.edit(change)
			},
			access,
			password: () => swap.password(),
			memory: pdfEngineMemory,
			openVerifier: (channel, password) => openPdfEngineOnChannel(channel, password),
			write: (content, suffix) => writeEditedCopy(item, content, "pdf", suffix),
			fileSize: Number(item.data.size),
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
								formOverlaySession(swap).warnRequired()
							}
						}),
					requestVersionSave: () => {
						host?.onSave()
					},
					copySuffix: number => (number <= 1 ? t("previewPdfSaveCopySuffix") : t("previewPdfSaveCopySuffixNumbered", { number })),
					onCopied: name => {
						toast.success(t("previewPdfSavedAsCopy", { name }))
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
	const requestSave = async (job: PdfSignedSaveJob | null): Promise<PdfToolSaveOutcome> => {
		if (host?.writable !== true) return { status: "cancelled" }

		let settle: (outcome: PdfToolSaveOutcome) => void = () => undefined
		const ended = new Promise<PdfToolSaveOutcome>(resolve => {
			settle = resolve
		})
		const request: PdfSaveRequest = {
			job,
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

	// pdf.js's view of the document's signatures (read before the swap; the editor keeps it), with those signed here.
	const knownSignatures = (): unknown[] => {
		const current = swap.getSnapshot()
		const viewer = current.kind === "editing" ? current.session.getSnapshot().document.facts.signatures : null

		return [...(viewer ?? []), ...signedHere]
	}
	const signatureSource: PdfSignatureSource | null =
		signedHere.length === 0 ? null : { getSignatures: () => Promise.resolve(knownSignatures()) }

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
						void flattenedFirst(session, flatten, () => actions.saveCopy()).catch(() => undefined)
					},
					security: () => {
						setActiveToolState(PROTECT_DOCUMENT_TOOL_ID)
					},
					discard: () => {
						swap.close()
					},
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

	const editable = host?.writable === true && online
	const policy: PdfPolicyState = { editable: host?.writable === true, online, tools: snapshot?.state.tools ?? null }
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
			canSaveInPlace: host?.writable === true,
			save: target => (target.kind === "version" ? requestSave(null) : actions.saveCopyAs(target.suffix)),
			unlocked: password => {
				swap.setPassword(password)
			},
			close: () => {
				setActiveToolState(null)
				swap.close()
			}
		},
		notify: setNotice,
		sign: request =>
			signWithCertificate(
				{
					session: read => withPdfSession(toolContext, read),
					fileSize: () => Number(item.data.size),
					memory: pdfEngineMemory(),
					save: job => requestSave(job).then(outcome => outcome.status === "saved"),
					job: (signer, digest) => ({
						signer,
						digest,
						hints: () => Promise.resolve(pdfSignatureFields(knownSignatures())),
						onSigned: (field, byteRange) => {
							setSignedHere(current => [...current, { fieldName: field.slice(field.lastIndexOf(".") + 1), byteRange }])
						}
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

	const failedBanner =
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
		saveSource:
			phase.kind === "editing"
				? options => (options.auto ? Promise.resolve(null) : flattenedFirst(session, flatten, () => actions.saveVersion()))
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
		signatureSource
	}
}
