import { useEffect, useEffectEvent, useState } from "react"
import { useTranslation } from "react-i18next"
import { XIcon } from "lucide-react"
import { driveItemName } from "@filen/shared"
import type { PdfDomDocument } from "@filen/office/react/pdf"
import { InputDialog } from "@/components/dialogs/inputDialog"
import { Button } from "@/components/ui/button"
import { DriveFilePickerDialog } from "@/features/drive/components/driveFilePickerDialog"
import { currentRootUuid } from "@/features/drive/lib/actions"
import { narrowToAnyFile } from "@/features/drive/lib/download"
import type { DriveItem } from "@/features/drive/lib/item"
import { normalizeParentUuid } from "@/features/drive/queries/drive"
import { takenNames } from "@/features/preview/imageEdit/editSession"
import { PdfExtractDialog, type PdfCopyContext } from "@/features/pdf/pages/extractDialog"
import { extractSuffix, partSuffix, unsignedSuffix } from "@/features/pdf/pages/names"
import { PdfOrganiseGrid } from "@/features/pdf/pages/organiseGrid"
import { PdfPagesRail, type PdfPagesRailProps } from "@/features/pdf/pages/pagesRail"
import { isPdfItem, usePagesView, usePdfPagesSurface, type PdfPagesSurfaceValue } from "@/features/pdf/pages/pagesSurfaceContext"
import { bookmarkStarts } from "@/features/pdf/pages/pagesSurface.logic"
import { PdfSplitDialog } from "@/features/pdf/pages/splitDialog"
import { thumbnailRenderer } from "@/features/pdf/pages/thumbnailRender"
import { toolEnabled, type PdfToolPanelProps } from "@/features/pdf/tools/registry"

// The editor's page surfaces: the pages rail beside the pages, the Organise grid (the Pages tab's Organise tool), the
// Extract and Split dialogs, the drive picker for inserting a PDF, the second PDF's password prompt and the one-time
// tags notice, and the Pages tools' panels. They share the viewer's document, the editor's engine and the page
// operations through PdfPagesSurfaceContext.

// The size every thumbnail cell is laid out for: the first page's (thumbnails of other sizes are letterboxed).
function useFirstPageSize(document: PdfDomDocument): { readonly width: number; readonly height: number } {
	const [size, setSize] = useState({ width: 612, height: 792 })

	useEffect(() => {
		let live = true

		void document
			.getPage(1)
			.then(page => {
				const viewport = page.getViewport({ scale: 1 })

				if (live) setSize({ width: viewport.width, height: viewport.height })
			})
			.catch(() => undefined)

		return () => {
			live = false
		}
	}, [document])

	return size
}

// What the rail and the grid share: the pages, the selection, the thumbnails, the page operations.
function useRailProps(surface: PdfPagesSurfaceValue): Omit<PdfPagesRailProps, "layout" | "className"> {
	const { controller, document, snapshot } = surface
	const view = usePagesView(controller)
	const size = useFirstPageSize(document)
	const count = document.numPages

	// Ids follow the document's page count; pages a change redrew (the editor's revision shown) get new thumbnails.
	const touched = snapshot !== null && snapshot.document === document ? snapshot.touched : null

	useEffect(() => {
		controller.sync(count)
	}, [controller, count])
	useEffect(() => {
		if (touched !== null) controller.invalidate(touched.flatMap(page => controller.getSnapshot().ids[page] ?? []))
	}, [controller, touched])

	return {
		pages: view.ids.map(id => ({ id, width: size.width, height: size.height })),
		current: Math.min(view.current, Math.max(0, count - 1)),
		selected: view.selected,
		onSelect: index => {
			controller.choose(index)
		},
		onSelectionChange: selected => {
			controller.select(selected)
		},
		renderThumbnail: thumbnailRenderer(document, surface.engine),
		editable: toolEnabled("pages", surface.policy).enabled,
		onReorder: order => {
			controller.move(order)
		},
		onRotate: (pages, degrees) => {
			controller.rotate(pages, degrees)
		},
		onDelete: pages => {
			controller.remove(pages)
		},
		changed: view.changed,
		announcement: view.announcement
	}
}

// The pages rail, left of the pages (wide views only).
export function PdfPagesSide() {
	const surface = usePdfPagesSurface()
	const rail = useRailProps(surface)

	return (
		<aside className="hidden w-32 shrink-0 border-r border-border bg-muted/30 md:block">
			<PdfPagesRail
				{...rail}
				layout="rail"
			/>
		</aside>
	)
}

// The tags notice (once), and the second PDF's password prompt.
export function PdfPagesNotices() {
	const { t } = useTranslation("preview")
	const { controller } = usePdfPagesSurface()
	const view = usePagesView(controller)

	return (
		<>
			{view.taggedNotice ? (
				<div
					role="status"
					className="flex shrink-0 items-center gap-2 border-b bg-muted px-3 py-1.5 text-xs text-muted-foreground"
				>
					<p className="min-w-0 flex-1">{t("previewPdfTagged")}</p>
					<Button
						variant="ghost"
						size="icon-xs"
						aria-label={t("previewPdfPagesNoticeDismiss")}
						onClick={() => {
							controller.dismissTagged()
						}}
					>
						<XIcon />
					</Button>
				</div>
			) : null}
			{view.password === null ? null : (
				<InputDialog
					open
					pending={false}
					title={t("previewPdfPasswordTitle")}
					body={view.password.attempt === "retry" ? t("previewPdfPasswordRetryBody") : t("previewPdfPagesInsertPasswordBody")}
					label={t("previewPdfPasswordLabel")}
					secret
					submitLabel={t("previewPdfPasswordSubmit")}
					initialValue=""
					validate={password => password.length > 0}
					onOpenChange={open => {
						if (!open) controller.answerPassword(null)
					}}
					onSubmit={password => {
						controller.answerPassword(password)
					}}
				/>
			)}
		</>
	)
}

// The drive picker for a PDF whose pages go in after the current page.
export function PdfInsertFromFilenDialog({ onClose }: { onClose: () => void }) {
	const { t } = useTranslation("preview")
	const { controller, item } = usePdfPagesSurface()

	return (
		<DriveFilePickerDialog
			title={t("previewPdfPagesInsertPickerTitle")}
			description={t("previewPdfPagesInsertPickerDescription")}
			accept={candidate => isPdfItem(candidate) && candidate.data.uuid !== item.data.uuid}
			onPick={picked => {
				controller.insertPdf({ kind: "drive", file: narrowToAnyFile(picked) })
				onClose()

				return Promise.resolve()
			}}
			onClose={onClose}
		/>
	)
}

// Names already in the PDF's directory, read once per dialog (the names the dialog shows are the ones files get).
function useTakenNames(item: DriveItem): ReadonlySet<string> {
	const [taken, setTaken] = useState<ReadonlySet<string>>(() => new Set())

	useEffect(() => {
		let live = true

		void takenNames(normalizeParentUuid(item.type === "file" ? item.data.parent : null, currentRootUuid()))
			.then(names => {
				if (live) setTaken(names)
			})
			.catch(() => undefined)

		return () => {
			live = false
		}
	}, [item])

	return taken
}

function useCopyContext(surface: PdfPagesSurfaceValue): PdfCopyContext {
	const view = usePagesView(surface.controller)
	const taken = useTakenNames(surface.item)
	const { toolContext } = surface

	// What the dialog says (encryption, signatures) is the editor's to know: it starts while the dialog is open.
	const startEditor = useEffectEvent(() => {
		toolContext.edit(() => Promise.resolve())
	})

	useEffect(() => {
		startEditor()
	}, [])

	return {
		name: driveItemName(surface.item),
		pageCount: surface.document.numPages,
		selected: [...view.selected].sort((a, b) => a - b),
		taken,
		encrypted: (surface.snapshot?.state.encryption.method ?? "None") !== "None",
		passwordUnsupported: surface.controller.passwordUnsupported(),
		signed: (surface.snapshot?.state.signatures.fields.length ?? 0) > 0,
		progress: view.progress,
		online: surface.online
	}
}

export function PdfExtractPanel({ onClose }: { onClose: () => void }) {
	const { t } = useTranslation("preview")
	const surface = usePdfPagesSurface()
	const context = useCopyContext(surface)

	return (
		<PdfExtractDialog
			{...context}
			onClose={() => {
				if (context.progress === undefined) onClose()
			}}
			onExtract={request => {
				void surface.controller
					.makeCopies(
						request.files.map(file => ({ ranges: file.ranges, suffix: extractSuffix(t, file.ranges) })),
						{ protect: request.protect, deletes: request.deletes, failedKey: "previewPdfExtractFailed" }
					)
					.then(saved => {
						if (saved) onClose()
					})
			}}
		/>
	)
}

export function PdfSplitPanel({ onClose }: { onClose: () => void }) {
	const { t } = useTranslation("preview")
	const surface = usePdfPagesSurface()
	const context = useCopyContext(surface)
	const [bookmarks, setBookmarks] = useState<readonly number[]>([])

	useEffect(() => {
		let live = true

		void bookmarkStarts(surface.document).then(pages => {
			if (live) setBookmarks(pages)
		})

		return () => {
			live = false
		}
	}, [surface.document])

	return (
		<PdfSplitDialog
			{...context}
			bookmarks={bookmarks}
			onClose={() => {
				if (context.progress === undefined) onClose()
			}}
			onSplit={request => {
				void surface.controller
					.makeCopies(
						request.parts.map((part, index) => ({ ranges: [part.range], suffix: partSuffix(t, index + 1) })),
						{ protect: request.protect, deletes: [], failedKey: "previewPdfSplitFailed" }
					)
					.then(saved => {
						if (saved) onClose()
					})
			}}
		/>
	)
}

type OrganiseDialog = "extract" | "split" | "filen" | null

// The Organise grid over the pages (the Pages tab's Organise tool), with its own Insert ▾, Extract and Split.
export function PdfOrganisePanel({ onClose }: { onClose: () => void }) {
	const { t } = useTranslation("preview")
	const surface = usePdfPagesSurface()
	const rail = useRailProps(surface)
	const [dialog, setDialog] = useState<OrganiseDialog>(null)
	const verdict = toolEnabled("pages", surface.policy)
	const { controller } = surface
	const view = usePagesView(controller)
	const signed = !verdict.enabled && verdict.reasonKey === "previewPdfToolSigned"

	return (
		<div className="absolute inset-0 z-20 flex flex-col bg-background">
			{signed ? (
				// Page changes would break the signatures: a copy without them can be organised.
				<div
					role="status"
					className="flex shrink-0 items-center gap-2 border-b bg-muted px-3 py-1.5 text-xs text-muted-foreground"
				>
					<p className="min-w-0 flex-1">{t("previewPdfToolSigned")}</p>
					<Button
						variant="outline"
						size="xs"
						disabled={view.progress !== undefined || !surface.online}
						onClick={() => {
							void controller.makeCopies(
								[{ ranges: [{ first: 1, last: surface.document.numPages }], suffix: unsignedSuffix(t) }],
								{ protect: true, deletes: [], failedKey: "previewPdfExtractFailed" }
							)
						}}
					>
						{t("previewPdfPagesCopyWithoutSignatures")}
					</Button>
				</div>
			) : null}
			<PdfOrganiseGrid
				{...rail}
				{...(verdict.enabled ? {} : { disabledReason: t(verdict.reasonKey) })}
				insert={{
					onBlank: () => {
						controller.insertBlank()
					},
					onFromFilen: () => {
						setDialog("filen")
					},
					onFromDevice: file => {
						controller.insertPdf({ kind: "device", file })
					},
					onImage: file => {
						controller.insertImage(file)
					}
				}}
				onDuplicate={pages => {
					controller.duplicate(pages)
				}}
				onExtract={() => {
					setDialog("extract")
				}}
				onSplit={() => {
					setDialog("split")
				}}
				onClose={onClose}
			/>
			{dialog === "extract" ? (
				<PdfExtractPanel
					onClose={() => {
						setDialog(null)
					}}
				/>
			) : null}
			{dialog === "split" ? (
				<PdfSplitPanel
					onClose={() => {
						setDialog(null)
					}}
				/>
			) : null}
			{dialog === "filen" ? (
				<PdfInsertFromFilenDialog
					onClose={() => {
						setDialog(null)
					}}
				/>
			) : null}
		</div>
	)
}

// The Pages tools' panels: each closes by ending its tool.
export function PdfOrganiseToolPanel({ context }: PdfToolPanelProps) {
	return (
		<PdfOrganisePanel
			onClose={() => {
				context.finish()
			}}
		/>
	)
}

export function PdfInsertFromFilenToolPanel({ context }: PdfToolPanelProps) {
	return (
		<PdfInsertFromFilenDialog
			onClose={() => {
				context.finish()
			}}
		/>
	)
}

export function PdfExtractToolPanel({ context }: PdfToolPanelProps) {
	return (
		<PdfExtractPanel
			onClose={() => {
				context.finish()
			}}
		/>
	)
}

export function PdfSplitToolPanel({ context }: PdfToolPanelProps) {
	return (
		<PdfSplitPanel
			onClose={() => {
				context.finish()
			}}
		/>
	)
}
