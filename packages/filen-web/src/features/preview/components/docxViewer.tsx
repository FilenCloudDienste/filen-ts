import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { isCompoundFile } from "@filen/office/core/cfb"
import { bytesSource, type ByteSource } from "@filen/office/core/opc"
import {
	DEFAULT_MARKUP_MODE,
	markupInfo,
	type DocxEncryptionRefusal,
	type DocxHost,
	type DocxLegacyRefusal,
	type DocxLockedDocument,
	type DocxMarkupMode,
	type DocxProtectedOpen
} from "@filen/office/dom/docx"
import {
	DocxPages,
	indexAnnotations,
	linkActivator,
	useDocxAnnotations,
	useDocxDocument,
	useDocxViewer,
	type DocxDocument,
	type DocxSource
} from "@filen/office/react/docx"
import "@filen/office/css/docx.css"
import { recordContentVerdict } from "@/features/drive/lib/contentVerdicts"
import { uploadConvertedCopy } from "@/features/drive/lib/convertedCopy"
import { driveItemMime, isLinkedEmbedItem, type DriveItem } from "@/features/drive/lib/item"
import { TextViewer } from "@/features/preview/components/textViewer"
import type { DriveVariant } from "@/features/drive/lib/preferences"
import { usePreviewBytes } from "@/features/preview/hooks/usePreviewBytes"
import { usePreviewAccessMode, usePreviewByteSource } from "@/features/preview/lib/accessMode"
import { DOCX_FONT_URLS, docxHost, docxLegacy, docxProtection, prewarmDocxWorker } from "@/features/preview/lib/docxEngine"
import {
	BALLOON_COLUMN_WIDTH,
	balloonsFit,
	hasBalloons,
	docxConversionKey,
	docxErrorKey,
	docxFailure,
	docxFormatOf,
	docxRefusalKey,
	docxSessionKey,
	isTextTemplate,
	legacyNeedsPassword,
	legacyRefusalKey,
	viewOnlyReasons,
	type DocxConversionKey,
	type DocxGateReason,
	type DocxOpenContext,
	type DocxSessionKey
} from "@/features/preview/components/docxViewer.logic"
import { DocxAnnotationLayer, type DocxBalloonKey } from "@/features/preview/components/docxAnnotations"
import { DocxPreviewFallback } from "@/features/preview/components/docxPreviewFallback"
import { DocxPasswordGate, type PasswordVerdict } from "@/features/preview/components/docxPasswordPrompt"
import { DocxEditView, DocxProtectedEditView, type DocxSaveSource } from "@/features/preview/components/docxEditor"
import { DocxFileMenu } from "@/features/preview/components/docxFileMenu"
import { useLeaveViewerFullScreen } from "@/features/preview/components/commandBar.logic"
import { onCommandBarF6 } from "@/features/office/components/ribbon/ribbonFocus"
import { useDocxPdfExport, type DocxPdfExportTarget } from "@/features/preview/hooks/useDocxPdfExport"
import { DownloadAsItemProvider } from "@/features/drive/components/editorDownloadAs"
import { DocxToolbar, type DocxLegacyInfo, type PasswordIntegrity } from "@/features/preview/components/docxToolbar"
import { RtfDocument } from "@/features/preview/components/rtfDocument"
import { useTrustedLinkGate } from "@/lib/trustedLinks/useTrustedLinkGate"
import { LoadingState } from "@/components/loadingState"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { PreviewDownloadButton, PreviewErrorState, PreviewGate, PreviewLoading } from "@/features/preview/components/previewErrorState"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { isAnyDialogOpen } from "@/lib/keymap/dialogGuard"
import { IN_EDITORS, useAction } from "@/lib/keymap/useAction"
import { isSafeAbsoluteHref } from "@/lib/safeUrl"
import { log } from "@/lib/log"
import { useElementSize } from "@/lib/useElementSize"
import { useLatestRef } from "@/lib/useLatestRef"

export interface DocxViewerProps {
	item: DriveItem
	alt: string
	// The drive listing the file was opened from (a view-only reason outside the user's own drive).
	variant?: DriveVariant
	// The overlay's editing side for a file the user may edit (only with editing built in): the document
	// opens in the editor when the file can be saved as it mounts.
	editing?: DocxEditingProps
	// A converted copy may be written beside this file (a Word 97–2003 document offers Save as .docx).
	canSaveCopy?: boolean
	// Shows another file in this preview's place: the .docx a Word 97–2003 document was just saved as.
	onOpenFile?: (item: DriveItem) => void
}

export interface DocxEditingProps {
	// Saving is possible now (false after a rename to another format, or a save that failed for good).
	writable: boolean
	renamed: boolean
	onDirtyChange: (dirty: boolean) => void
	saveRef: RefObject<DocxSaveSource | null>
	onAutosave: () => boolean
}

// Space around and between pages (px); fit-to-width leaves it on both sides.
const PAGE_GAP = 16
const WHEEL_SENSITIVITY = 0.0015
const LAYER = "[role='dialog'], [role='alertdialog']"

// What the viewer opens: the file as downloaded (the engine reads ranges of the cached buffer and gets a copy of
// each range it asked for, never of the whole file: the buffer stays shared with the preview cache and the
// Download action), or a password-protected file's decrypted package, held in the docx worker by its unlocked
// document (never on the page). `file`: the buffer, for docx-preview's fallback; none for a decrypted package.
interface DocxContent {
	readonly host: DocxHost
	readonly bytes: ByteSource
	readonly file: Uint8Array | null
}

function fileContent(bytes: Uint8Array): DocxContent {
	return { host: docxHost, bytes: bytesSource(bytes), file: bytes }
}

// Tracked changes are laid out as the markup mode shows them (a new layout per view).
function sourceFor(content: DocxContent, mode: DocxMarkupMode, format: "docx" | "odt"): DocxSource {
	return { host: content.host, bytes: content.bytes, options: { fontUrls: DOCX_FONT_URLS, view: markupInfo(mode).view, format } }
}

// The document's File menus offer Download as for this file (editorDownloadAs.tsx).
export function DocxViewer(props: DocxViewerProps) {
	useLeaveViewerFullScreen()

	return (
		<DownloadAsItemProvider item={props.item}>
			<DocxViewerBody {...props} />
		</DownloadAsItemProvider>
	)
}

function DocxViewerBody({ item, alt, variant, editing, canSaveCopy, onOpenFile }: DocxViewerProps) {
	// Editing or viewing is decided as the file mounts. The editor keeps the document it opened across the
	// user's own saves (each makes the file a new version under a new uuid): its bytes stay the ones it read.
	const format = docxFormatOf(alt)
	// Every format edits: an RTF or OpenDocument text document as the package it reads as, saved in its own format
	// (rtfDocument.tsx).
	const [edit] = useState(() => editing?.writable === true)
	const [openedItem] = useState(item)
	const result = usePreviewBytes(edit ? openedItem : item)
	const downloading = result.status === "pending"
	const anon = usePreviewAccessMode() === "anon"
	const archive = usePreviewByteSource() !== null

	// The worker starts while the file downloads; a buffer already cached, or a failed download, starts none.
	// The editor lays out on this thread and needs no worker.
	useEffect(() => {
		if (downloading && !edit) {
			prewarmDocxWorker()
		}
	}, [downloading, edit])

	return (
		<PreviewGate result={result}>
			{ready => {
				// RTF never comes here: it always opens through its held document.
				const shown = format === "odt" ? "odt" : "docx"
				const standard = (): ReactNode =>
					isTextTemplate(item, ready.bytes) ? (
						<DocxTemplateAsText
							item={item}
							alt={alt}
							anon={anon}
						/>
					) : (
						<DocxPasswordBoundary
							bytes={ready.bytes}
							name={alt}
						>
							{(content, key, conversion) => {
								const context = { anon, archive, linked: isLinkedEmbedItem(item), variant }

								// A Word 97–2003 document is shown from its conversion, read-only.
								if (conversion !== null) {
									return (
										<DocxLegacyView
											item={item}
											conversion={conversion}
											canSaveCopy={canSaveCopy === true}
											onOpenFile={onOpenFile}
										>
											{legacy => (
												<DocxDocumentView
													content={content}
													alt={alt}
													format="docx"
													encrypted={undefined}
													legacy={legacy}
													context={context}
												/>
											)}
										</DocxLegacyView>
									)
								}

								// Download as ▸ PDF: the file laid out again in the PDF worker; a protected one's password is asked and
								// checked against the file as stored, then protects the PDF.
								const pdf: DocxPdfExportTarget = {
									fileName: alt,
									source: () =>
										content.file === null
											? { kind: "file", bytes: ready.bytes }
											: { kind: "file", bytes: content.file, format: shown },
									encryptedFile: key === null ? undefined : ready.bytes
								}
								const viewer = (
									<DocxDocumentView
										content={content}
										alt={alt}
										format={shown}
										encrypted={key?.document.integrity}
										context={context}
										pdf={pdf}
									/>
								)

								// An OpenDocument file edits through its held document (above); here it is only shown.
								if (!edit || editing === undefined || format === "odt") {
									return viewer
								}

								const editProps = {
									alt,
									encryptedFile: key === null ? undefined : ready.bytes,
									writable: editing.writable,
									renamed: editing.renamed,
									onDirtyChange: editing.onDirtyChange,
									saveRef: editing.saveRef,
									onAutosave: editing.onAutosave,
									viewer: () => viewer
								}

								// A password-protected document's editor takes its own copy and seals its saves with its key.
								return key === null || content.file !== null ? (
									<DocxEditView
										bytes={content.file ?? ready.bytes}
										{...editProps}
									/>
								) : (
									<DocxProtectedEditView
										document={key.document}
										{...editProps}
									/>
								)
							}}
						</DocxPasswordBoundary>
					)

				return format === "rtf" || (format === "odt" && edit && editing !== undefined) ? (
					<RtfDocument
						bytes={ready.bytes}
						edit={edit && editing !== undefined}
						format={format === "odt" ? "odt" : "rtf"}
						{...(format === "odt" ? { unopened: standard } : {})}
					>
						{rtf => {
							const viewer = (
								<DocxDocumentView
									content={{ host: rtf.host, bytes: rtf.bytes, file: null }}
									alt={alt}
									format="docx"
									encrypted={undefined}
									context={{ anon, archive, linked: isLinkedEmbedItem(item), variant }}
								/>
							)

							return rtf.editing === undefined || editing === undefined ? (
								viewer
							) : (
								<DocxEditView
									bytes={rtf.editing.docx}
									backend={rtf.editing.backend}
									alt={alt}
									writable={editing.writable}
									renamed={editing.renamed}
									onDirtyChange={editing.onDirtyChange}
									saveRef={editing.saveRef}
									onAutosave={editing.onAutosave}
									viewer={() => viewer}
								/>
							)
						}}
					</RtfDocument>
				) : (
					standard()
				)
			}}
		</PreviewGate>
	)
}

// What the read found about a `.dot`, recorded (the drive preview then shows it in the text viewer, editable as any
// text file there); meanwhile, and where nothing swaps the viewer (a public link, an archive), the text read-only.
function DocxTemplateAsText({ item, alt, anon }: { item: DriveItem; alt: string; anon: boolean }) {
	const uuid = item.data.uuid
	const name = alt
	const mime = driveItemMime(item)
	const size = item.data.size

	useEffect(() => {
		recordContentVerdict({ uuid, name, mime, size }, "notWordBinary", { memoryOnly: anon })
	}, [uuid, name, mime, size, anon])

	return (
		<TextViewer
			item={item}
			alt={alt}
		/>
	)
}

// What the file is before anything is shown: a zip opens at once; a compound file is probed for a password
// ([MS-OFFCRYPTO] §2.3.4) in the docx worker: refused (rights management, an unsupported scheme, damage), locked,
// or not an encrypted package at all: a Word 97–2003 document, converted in the docx worker (or refused with the
// reader's reason) and shown from the package it became. A Word 97–2003 document with a password to open asks for it
// (legacyLocked) and is converted again with it.
type Protection =
	| { readonly kind: "probing" }
	| { readonly kind: "converting" }
	| {
			readonly kind: "open"
			readonly content: DocxContent
			readonly key: DocxSessionKey | null
			readonly conversion: DocxConversionKey | null
	  }
	| { readonly kind: "refused"; readonly reason: DocxEncryptionRefusal }
	| { readonly kind: "legacyRefused"; readonly refusal: DocxLegacyRefusal }
	| { readonly kind: "legacyLocked" }
	| { readonly kind: "locked"; readonly locked: DocxLockedDocument }

function initial(bytes: Uint8Array): Protection {
	return isCompoundFile(bytes) ? { kind: "probing" } : { kind: "open", content: fileContent(bytes), key: null, conversion: null }
}

function protectionOf(opened: Exclude<DocxProtectedOpen, { kind: "aborted" }>): Protection {
	switch (opened.kind) {
		case "plain":
			return { kind: "converting" }
		case "refused":
			return { kind: "refused", reason: opened.reason }
		case "needsPassword":
			return { kind: "locked", locked: opened.locked }
	}
}

// The document behind its password, if it has one: the prompt in its place until it is given, then the viewer
// on the decrypted package where the worker holds it (or the editor on its own copy), released once the preview
// closes, whatever closes it (the overlay, a route change, a new version of the file, an error above). Reopening
// asks again.
function DocxPasswordBoundary({
	bytes,
	name,
	children
}: {
	bytes: Uint8Array
	name: string
	children: (content: DocxContent, key: DocxSessionKey | null, conversion: DocxConversionKey | null) => ReactNode
}) {
	const { t } = useTranslation("preview")
	const [state, setState] = useState(() => ({ bytes, protection: initial(bytes) }))
	// Every document this preview unlocked and still holds: released when it unmounts, also one whose state
	// never committed.
	const [keys] = useState(() => new Set<DocxSessionKey>())
	// Every converted Word 97–2003 document this preview holds, likewise.
	const [conversions] = useState(() => new Set<DocxConversionKey>())
	let current = state

	if (state.bytes !== bytes) {
		current = { bytes, protection: initial(bytes) }
		setState(current)
	}

	const { protection } = current
	const probing = protection.kind === "probing"
	const converting = protection.kind === "converting"
	const key = protection.kind === "open" ? protection.key : null
	const conversion = protection.kind === "open" ? protection.conversion : null
	const locked = protection.kind === "locked" ? protection.locked : null

	useEffect(() => {
		if (!probing) {
			return
		}

		const controller = new AbortController()

		docxProtection.open(bytesSource(bytes), { signal: controller.signal }).then(
			opened => {
				if (opened.kind === "aborted" || controller.signal.aborted) {
					if (opened.kind === "needsPassword") {
						opened.locked.dispose()
					}

					return
				}

				const next = protectionOf(opened)

				setState(previous => (previous.bytes === bytes ? { bytes, protection: next } : previous))
			},
			(error: unknown) => {
				// Not one of the file's own verdicts (those resolve): the engine reads the file and says what it is.
				log.error("docx", "encryption probe failed", error)

				if (!controller.signal.aborted) {
					setState(previous =>
						previous.bytes === bytes
							? { bytes, protection: { kind: "open", content: fileContent(bytes), key: null, conversion: null } }
							: previous
					)
				}
			}
		)

		return () => {
			controller.abort()
		}
	}, [bytes, probing])

	// A compound file that is not an encrypted package: converted where the engine runs; the file's bytes are read
	// once and the package it becomes is held there.
	useEffect(() => {
		if (!converting) {
			return
		}

		const controller = new AbortController()

		docxLegacy.open(bytesSource(bytes), { signal: controller.signal }).then(
			opened => {
				if (opened.kind === "aborted" || controller.signal.aborted) {
					if (opened.kind === "converted") {
						opened.document.release()
					}

					return
				}

				if (opened.kind === "refused") {
					const next: Protection = legacyNeedsPassword(opened.refusal)
						? { kind: "legacyLocked" }
						: { kind: "legacyRefused", refusal: opened.refusal }

					setState(previous => (previous.bytes === bytes ? { bytes, protection: next } : previous))

					return
				}

				const held = docxConversionKey(opened.document)
				const content: DocxContent = { host: opened.document.host, bytes: opened.document.bytes, file: null }

				conversions.add(held)
				setState(previous =>
					previous.bytes === bytes ? { bytes, protection: { kind: "open", content, key: null, conversion: held } } : previous
				)
			},
			(error: unknown) => {
				log.error("docx", "converting a Word 97–2003 document failed", error)

				if (!controller.signal.aborted) {
					setState(previous =>
						previous.bytes === bytes
							? { bytes, protection: { kind: "legacyRefused", refusal: { reason: "corrupt" } } }
							: previous
					)
				}
			}
		)

		return () => {
			controller.abort()
		}
	}, [bytes, converting, conversions])

	useEffect(() => {
		if (conversion === null) {
			return
		}

		conversions.add(conversion)
		conversion.hold()

		return () => {
			conversions.delete(conversion)
			conversion.drop()
		}
	}, [conversion, conversions])

	useEffect(
		() => () => {
			for (const held of conversions) {
				held.drop()
			}
		},
		[conversions]
	)

	// A locked file the prompt left without unlocking is dropped where the worker holds it, a turn later (a
	// remount in the same turn, React's Strict Mode check, keeps it).
	useEffect(() => {
		if (locked === null) {
			return
		}

		clearTimeout(disposals.get(locked))

		return () => {
			disposals.set(
				locked,
				setTimeout(() => {
					if (!unlockedLocks.has(locked)) {
						locked.dispose()
					}
				}, 0)
			)
		}
	}, [locked])

	useEffect(() => {
		if (key === null) {
			return
		}

		keys.add(key)
		key.hold()

		return () => {
			keys.delete(key)
			key.drop()
		}
	}, [key, keys])

	useEffect(
		() => () => {
			for (const held of keys) {
				held.drop()
			}
		},
		[keys]
	)

	switch (protection.kind) {
		case "probing":
		case "converting":
			return <PreviewLoading />
		case "legacyRefused":
			return (
				<PreviewErrorState
					message={t(legacyRefusalKey(protection.refusal))}
					action={<PreviewDownloadButton />}
				/>
			)
		case "refused":
			return (
				<PreviewErrorState
					message={t(docxRefusalKey(protection.reason))}
					action={<PreviewDownloadButton />}
				/>
			)
		case "legacyLocked": {
			// Each try converts the file again with the password in the worker; nothing is kept between tries.
			const verify = async (password: string, signal: AbortSignal): Promise<PasswordVerdict> => {
				const opened = await docxLegacy.open(bytesSource(bytes), { signal, password }).catch((error: unknown) => {
					log.error("docx", "opening an encrypted Word 97–2003 document failed", error)

					return { kind: "refused", refusal: { reason: "corrupt" } } as const
				})

				if (opened.kind === "aborted") {
					return "aborted"
				}

				if (opened.kind === "refused") {
					if (opened.refusal.reason === "wrongPassword") {
						return "wrong"
					}

					// The password verified, then the file could not be read: no prompt helps.
					setState(previous =>
						previous.bytes === bytes ? { bytes, protection: { kind: "legacyRefused", refusal: opened.refusal } } : previous
					)

					return "aborted"
				}

				if (signal.aborted) {
					opened.document.release()

					return "aborted"
				}

				const held = docxConversionKey(opened.document)
				const content: DocxContent = { host: opened.document.host, bytes: opened.document.bytes, file: null }

				conversions.add(held)
				setState(previous =>
					previous.bytes === bytes ? { bytes, protection: { kind: "open", content, key: null, conversion: held } } : previous
				)

				return "accepted"
			}

			return (
				<DocxPasswordGate
					title={t("previewDocxPasswordTitle")}
					body={t("previewDocxPasswordBody", { name })}
					wrongMessage={t("previewDocxPasswordWrong")}
					label={t("previewDocxPasswordLabel")}
					submitLabel={t("previewDocxPasswordSubmit")}
					progressLabel={t("previewDocxPasswordUnlocking")}
					message={t("previewDocxNeedsPassword")}
					enterLabel={t("previewDocxEnterPassword")}
					verify={verify}
				/>
			)
		}
		case "locked": {
			const lockedDocument = protection.locked
			const verify = async (password: string, signal: AbortSignal): Promise<PasswordVerdict> => {
				const result = await lockedDocument.unlock(password, { signal })

				if (!result.ok) {
					const { reason } = result

					if (reason === "wrongPassword") {
						return "wrong"
					}

					// The password verified, then the package failed its integrity check: no prompt helps.
					if (reason !== "aborted") {
						setState(previous => (previous.bytes === bytes ? { bytes, protection: { kind: "refused", reason } } : previous))
					}

					return "aborted"
				}

				unlockedLocks.add(lockedDocument)

				// The prompt went (closed, a new version, the preview unmounted): nothing holds the document.
				if (signal.aborted) {
					result.document.release()

					return "aborted"
				}

				const unlocked = docxSessionKey(result.document)
				const content: DocxContent = { host: result.document.host, bytes: result.document.bytes, file: null }

				keys.add(unlocked)
				setState(previous =>
					previous.bytes === bytes ? { bytes, protection: { kind: "open", content, key: unlocked, conversion: null } } : previous
				)

				return "accepted"
			}

			return (
				<DocxPasswordGate
					title={t("previewDocxPasswordTitle")}
					body={t("previewDocxPasswordBody", { name })}
					wrongMessage={t("previewDocxPasswordWrong")}
					label={t("previewDocxPasswordLabel")}
					submitLabel={t("previewDocxPasswordSubmit")}
					progressLabel={t("previewDocxPasswordUnlocking")}
					message={t("previewDocxNeedsPassword")}
					enterLabel={t("previewDocxEnterPassword")}
					verify={verify}
				/>
			)
		}
		case "open":
			return children(protection.content, key, conversion)
	}
}

// Locked files whose unlock succeeded: their dispose would release the unlocked document (the same hold).
const unlockedLocks = new WeakSet<DocxLockedDocument>()
// Locked files about to be dropped (their preview let go of them).
const disposals = new WeakMap<DocxLockedDocument, ReturnType<typeof setTimeout>>()

interface Opened {
	content: DocxContent
	mode: DocxMarkupMode
	source: DocxSource
}

// A Word 97–2003 document shown from its conversion, with Save as .docx: a copy of the converted package uploaded
// beside the file (the existing copy-name rule), then shown in this preview's place.
function DocxLegacyView({
	item,
	conversion,
	canSaveCopy,
	onOpenFile,
	children
}: {
	item: DriveItem
	conversion: DocxConversionKey
	canSaveCopy: boolean
	onOpenFile: ((item: DriveItem) => void) | undefined
	children: (legacy: DocxLegacyInfo) => ReactNode
}) {
	const { t } = useTranslation(["preview", "common"])
	const [asked, setAsked] = useState(false)
	const [saving, setSaving] = useState(false)
	const save = async (): Promise<void> => {
		const bytes = await conversion.document.take().catch((e: unknown) => {
			log.error("docx", "taking the converted package failed", e)

			return null
		})

		if (bytes === null) {
			toast.error(t("previewDocxSaveAsDocxFailed"))

			return
		}

		const outcome = await uploadConvertedCopy(item, bytes, "docx").catch((e: unknown) => {
			log.error("docx", "uploading the .docx copy failed", e)

			return { status: "error", dto: null } as const
		})

		if (outcome.status === "error") {
			toast.error(outcome.dto === null ? t("previewDocxSaveAsDocxFailed") : errorLabel(outcome.dto))

			return
		}

		toast.success(t("previewDocxSavedAsDocx", { name: outcome.name }))
		onOpenFile?.(outcome.item)
	}

	return (
		<>
			{children({
				notConverted: conversion.document.notConverted,
				onSaveAs: canSaveCopy
					? () => {
							setAsked(true)
						}
					: undefined
			})}
			{canSaveCopy ? (
				<ConfirmDialog
					open={asked}
					pending={saving}
					title={t("previewDocxSaveAsDocxTitle")}
					body={[
						t("previewDocxSaveAsDocxBody"),
						...(conversion.document.decrypted ? [t("previewDocxSaveAsDocxUnencrypted")] : []),
						...(conversion.document.notConverted.some(item => item.kind === "passwordProtection")
							? [t("previewDocxSaveAsDocxNoPassword")]
							: []),
						...(conversion.document.notConverted.some(item => item.kind === "macros")
							? [t("previewDocxSaveAsDocxNoMacros")]
							: []),
						...(conversion.document.notConverted.some(item => item.kind === "autoText")
							? [t("previewDocxSaveAsDocxNoAutoText")]
							: [])
					].join(" ")}
					confirmLabel={t("previewDocxSaveAsDocx")}
					cancelLabel={t("common:cancel")}
					onOpenChange={setAsked}
					onConfirm={() => {
						setSaving(true)
						void save().finally(() => {
							setSaving(false)
							setAsked(false)
						})
					}}
				/>
			) : null}
		</>
	)
}

function DocxDocumentView({
	content,
	alt,
	format,
	encrypted,
	legacy,
	context,
	pdf
}: {
	content: DocxContent
	alt: string
	format: "docx" | "odt"
	// Opened with its password, and whether its integrity was verified (the badge says so).
	encrypted: PasswordIntegrity | undefined
	// Shown from a Word 97–2003 document's conversion.
	legacy?: DocxLegacyInfo
	context: DocxOpenContext
	// Download as ▸ PDF (absent: not offered).
	pdf?: DocxPdfExportTarget
}) {
	const { t } = useTranslation("preview")
	const pdfExport = useDocxPdfExport(pdf ?? null)
	// A retry, or a markup mode laid out differently, opens the same content again under a fresh source (a new
	// document on the shared worker).
	const [opened, setOpened] = useState<Opened>(() => ({
		content,
		mode: DEFAULT_MARKUP_MODE,
		source: sourceFor(content, DEFAULT_MARKUP_MODE, format)
	}))
	let current = opened

	if (opened.content !== content) {
		current = { content, mode: DEFAULT_MARKUP_MODE, source: sourceFor(content, DEFAULT_MARKUP_MODE, format) }
		setOpened(current)
	}

	const document = useDocxDocument(current.source)
	const failure = docxFailure(document, content.bytes.size)
	// A decrypted package is not on the page: docx-preview has nothing to read.
	const file = failure?.fallback === true && format === "docx" ? content.file : null
	const detail = failure?.detail

	useEffect(() => {
		if (detail !== undefined) {
			log.warn(
				"docx",
				file !== null
					? "Engine failed, showing docx-preview instead:"
					: content.file === null
						? "Engine failed on a decrypted package:"
						: "Engine failed, too large for docx-preview:",
				detail
			)
		}
	}, [detail, file, content.file])

	if (file !== null) {
		return (
			<DocxPreviewFallback
				bytes={file}
				alt={alt}
			/>
		)
	}

	if (document.status === "error") {
		return (
			<PreviewErrorState
				message={t(docxErrorKey(document.error?.reason))}
				onRetry={() => {
					setOpened({ content, mode: current.mode, source: sourceFor(content, current.mode, format) })
				}}
			/>
		)
	}

	return (
		<DocxPageList
			document={document}
			alt={alt}
			mode={current.mode}
			onModeChange={mode => {
				if (mode === current.mode) {
					return
				}

				// Modes that lay out the same view keep the open document.
				setOpened(
					markupInfo(mode).view === markupInfo(current.mode).view
						? { ...current, mode }
						: { content, mode, source: sourceFor(content, mode, format) }
				)
			}}
			encrypted={encrypted}
			legacy={legacy}
			context={context}
			fileMenu={pdfExport.onDownloadPdf === undefined ? undefined : <DocxFileMenu onDownloadPdf={pdfExport.onDownloadPdf} />}
			prompt={pdfExport.prompt}
		/>
	)
}

// What the document says about itself once opened, kept while a markup mode opens it again (the facts do
// not change with the view).
interface Facts {
	gate: readonly DocxGateReason[]
	comments: number
	revisions: number
	formatting: number
}

function DocxPageList({
	document,
	alt,
	mode,
	onModeChange,
	encrypted,
	legacy,
	context,
	fileMenu,
	prompt
}: {
	document: DocxDocument
	alt: string
	mode: DocxMarkupMode
	onModeChange: (mode: DocxMarkupMode) => void
	encrypted: PasswordIntegrity | undefined
	legacy: DocxLegacyInfo | undefined
	context: DocxOpenContext
	// The File menu (Download as) and the password prompt a protected document's PDF asks first.
	fileMenu: ReactNode
	prompt: ReactNode
}) {
	const { t } = useTranslation("preview")
	const [wrapper, setWrapper] = useState<HTMLDivElement | null>(null)
	const rootRef = useRef<HTMLDivElement | null>(null)
	const { width } = useElementSize(wrapper)
	const [facts, setFacts] = useState<Facts | null>(null)
	const info = document.info

	if (info !== undefined && facts === null) {
		setFacts({ gate: info.gate, comments: info.comments ?? 0, revisions: info.revisions ?? 0, formatting: info.formatting ?? 0 })
	}

	const reviewed = facts !== null && facts.comments + facts.revisions > 0
	const markup = markupInfo(mode)
	const annotations = useDocxAnnotations(document, reviewed)
	const index = annotations === undefined ? undefined : indexAnnotations(annotations)
	// The column is kept from the start by what the document counts, so the pages do not shrink once the
	// annotations arrive; then only where something will stand in it.
	const column =
		annotations === undefined
			? (markup.comments && (facts?.comments ?? 0) > 0) || (markup.formatting && (facts?.formatting ?? 0) > 0)
			: hasBalloons(annotations, markup)
	const aside = column && balloonsFit(width) ? BALLOON_COLUMN_WIDTH : 0
	const viewer = useDocxViewer(document, { gap: PAGE_GAP, aside })
	const { state, dispatch } = viewer
	const dispatchRef = useLatestRef(dispatch)
	const [active, setActive] = useState<DocxBalloonKey | null>(null)
	const [findFocus, setFindFocus] = useState(0)
	// The page in view when a markup mode opens the document again (a new session): shown again once the
	// new layout has it.
	const restoreRef = useRef<{ from: unknown; page: number } | null>(null)
	const session = document.session
	const linkGate = useTrustedLinkGate()

	// Links are judged when clicked (never when painted): http(s) and mailto open in a new tab with no opener
	// or referrer, inside the click's user activation so no popup blocker interferes, once a web link's
	// domain is trusted (asked once per domain); anything else is ignored.
	const openLink = linkActivator({
		allow: isSafeAbsoluteHref,
		open: href => {
			if (!linkGate.intercept(href)) {
				window.open(href, "_blank", "noopener,noreferrer")
			}
		}
	})

	useEffect(() => {
		const restore = restoreRef.current

		if (restore === null || session === undefined || restore.from === session) {
			return
		}

		if (document.status === "ready" || document.pages.length > restore.page) {
			restoreRef.current = null
			dispatch({ type: "page.goto", page: Math.min(restore.page, Math.max(0, document.pageCount - 1)) })
		}
	}, [session, document.status, document.pages.length, document.pageCount, dispatch])

	// Ctrl/Cmd+wheel zooms (a native non-passive listener: React registers wheel passively, so it could
	// not stop the browser's own page zoom); a plain wheel scrolls.
	useEffect(() => {
		if (wrapper === null) {
			return
		}

		const onWheel = (event: WheelEvent): void => {
			if (!event.ctrlKey && !event.metaKey) {
				return
			}

			event.preventDefault()
			// Relative, so events faster than renders add up.
			dispatchRef.current({ type: "zoom.by", delta: -event.deltaY * WHEEL_SENSITIVITY })
		}

		wrapper.addEventListener("wheel", onWheel, { passive: false })

		return () => {
			wrapper.removeEventListener("wheel", onWheel)
		}
	}, [wrapper, dispatchRef])

	// Find opens for keys pressed in the layer the document is shown in (the preview overlay, or the page of
	// a public link), never for one over it.
	useAction(
		"editor.find",
		keyboardEvent => {
			const root = rootRef.current

			if (root === null) {
				return
			}

			const layer = root.closest(LAYER)
			const target = keyboardEvent.target instanceof Element ? keyboardEvent.target.closest(LAYER) : null

			if (target !== layer || (layer === null && isAnyDialogOpen())) {
				return
			}

			keyboardEvent.preventDefault()

			if (state.find.open) {
				setFindFocus(focus => focus + 1)
			} else {
				dispatch({ type: "find.open" })
			}
		},
		IN_EDITORS,
		[state.find.open, dispatch]
	)

	return (
		<div
			ref={rootRef}
			className="flex size-full flex-col"
			onKeyDown={event => {
				onCommandBarF6(event, () => {
					wrapper?.querySelector<HTMLElement>(".fo-docx-pages")?.focus()
				})
			}}
		>
			<DocxToolbar
				state={state}
				dispatch={dispatch}
				markup={reviewed ? mode : null}
				onMarkupChange={next => {
					setActive(null)

					if (markupInfo(next).view !== markup.view) {
						restoreRef.current = { from: session, page: state.page }
					}

					onModeChange(next)
				}}
				viewOnly={facts === null || legacy !== undefined ? [] : viewOnlyReasons(facts.gate, context)}
				encrypted={encrypted}
				fileMenu={fileMenu}
				legacy={legacy}
				findFocus={findFocus}
				onFindClosed={() => {
					wrapper?.querySelector<HTMLElement>(".fo-docx-pages")?.focus()
				}}
			/>
			<div
				ref={setWrapper}
				className="relative min-h-0 flex-1"
			>
				<DocxPages
					{...viewer.pages}
					className="size-full select-text"
					label={alt}
					pageLabel={(page, total) => t("previewDocxPageIndicator", { current: page + 1, total })}
					onLinkActivate={openLink}
					{...(annotations === undefined || index === undefined || !reviewed
						? {}
						: {
								overlay: frames => (
									<DocxAnnotationLayer
										annotations={annotations}
										index={index}
										markup={markup}
										frames={frames}
										pages={document.pages}
										zoom={state.zoom}
										asideWidth={aside}
										active={active}
										onActivate={setActive}
									/>
								)
							})}
				/>
				{document.status === "loading" ? (
					<LoadingState
						size="lg"
						className="absolute inset-0 text-inherit"
					/>
				) : null}
			</div>
			{linkGate.dialog}
			{prompt}
		</div>
	)
}
