import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { FileClockIcon } from "lucide-react"
import type { PptLossKind } from "@filen/office/core/ppt"
import type { Format } from "@filen/office/core/presentation"
import type { ConversionReport, PresentationSessionApi } from "@filen/office/dom/presentation"
import { savePortReader } from "@filen/office/dom/presentation/savePort"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { uploadConvertedCopy } from "@/features/drive/lib/convertedCopy"
import type { DriveItem } from "@/features/drive/lib/item"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { log } from "@/lib/log"

// The read-only face of a PowerPoint 97–2003 deck (.ppt, .pps, .pot): the presentation viewer shows it as it shows any
// deck (the worker converted it to a pptx it reads), with this bar under the command bar saying it is the legacy
// binary format and is viewed only. No edit control is offered for it (the viewer opens it view-only, and the format
// is never editable: isEditablePresentationExtension). Where a copy may be saved beside the file, the bar offers Save as
// .pptx: the worker writes the package it converted (sealed with the deck's password when it has one) to a port, the
// copy is uploaded next to the file (the docx Save as path) and opened. A copy that holds something differently is
// listed in a dialog that stays until it is closed, with the copy opened from there.

// A copy may be saved beside the deck: its drive file and session, and where the copy opens.
export interface LegacySaveCopy {
	readonly item: DriveItem
	readonly session: PresentationSessionApi
	readonly encrypted: boolean
	readonly onOpenFile?: ((item: DriveItem) => void) | undefined
}

// What the copy holds differently, by loss kind (plural keys, given their count).
type LossKey =
	| "previewPptxLossOleObject"
	| "previewPptxLossMedia"
	| "previewPptxLossAnimation"
	| "previewPptxLossTransition"
	| "previewPptxLossComment"
	| "previewPptxLossMacros"
	| "previewPptxLossAction"
	| "previewPptxLossWordArt"
	| "previewPptxLossCustomGeometry"
	| "previewPptxLossPicture"
	| "previewPptxLossSlideColorScheme"
	| "previewPptxLossPatternFill"
	| "previewPptxLossDamaged"

const LOSS_KEYS: Readonly<Record<PptLossKind, LossKey>> = {
	oleObject: "previewPptxLossOleObject",
	media: "previewPptxLossMedia",
	animation: "previewPptxLossAnimation",
	transition: "previewPptxLossTransition",
	comment: "previewPptxLossComment",
	macros: "previewPptxLossMacros",
	action: "previewPptxLossAction",
	wordArt: "previewPptxLossWordArt",
	customGeometry: "previewPptxLossCustomGeometry",
	picture: "previewPptxLossPicture",
	slideColorScheme: "previewPptxLossSlideColorScheme",
	patternFill: "previewPptxLossPatternFill",
	damagedContent: "previewPptxLossDamaged"
}

function isLossKind(kind: string): kind is PptLossKind {
	return Object.hasOwn(LOSS_KEYS, kind)
}

// The .pptx the session writes to a port, read whole (it is uploaded as bytes), and its report.
async function readSaveAs(session: PresentationSessionApi): Promise<{ readonly bytes: Uint8Array; readonly report: ConversionReport }> {
	const channel = new MessageChannel()
	const reader = savePortReader(channel.port2)
	const answer = session.freshParts("pptx", channel.port1)

	// A refusal ends the read (a worker that refuses may never write to the port); the refusal is what is thrown.
	answer.catch(() => {
		reader.abort("failed")
	})
	const chunks: Uint8Array[] = []
	let size = 0

	try {
		for (let chunk = await reader.read(); chunk !== undefined; chunk = await reader.read()) {
			chunks.push(chunk)
			size += chunk.length
		}
	} catch (error) {
		// The worker's own failure says more than the port's abort.
		await answer
		throw error
	}

	const report = await answer
	const bytes = new Uint8Array(size)
	let at = 0

	for (const chunk of chunks) {
		bytes.set(chunk, at)
		at += chunk.length
	}

	reader.settled(true)

	return { bytes, report }
}

// A saved copy whose differences are being shown.
interface SavedCopy {
	readonly item: DriveItem
	readonly name: string
	readonly differently: readonly string[]
	readonly open: ((item: DriveItem) => void) | undefined
}

// What a saved copy holds differently, until it is closed (or the copy opened from it).
function SavedDifferentlyDialog({ saved, onClose }: { saved: SavedCopy | null; onClose: () => void }) {
	const { t } = useTranslation(["preview", "common"])

	return (
		<AlertDialog
			open={saved !== null}
			onOpenChange={open => {
				if (!open) onClose()
			}}
		>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>{saved === null ? "" : t("previewPptxSavedAsPptx", { name: saved.name })}</AlertDialogTitle>
					<AlertDialogDescription>{t("previewPptxSavedDifferently")}</AlertDialogDescription>
				</AlertDialogHeader>
				<ul className="flex max-h-[50dvh] list-disc flex-col gap-1 overflow-y-auto ps-5 text-sm">
					{saved?.differently.map(line => (
						<li
							key={line}
							className="break-words"
						>
							{line}
						</li>
					))}
				</ul>
				<AlertDialogFooter>
					<AlertDialogCancel autoFocus={saved?.open === undefined}>{t("common:close")}</AlertDialogCancel>
					{saved?.open === undefined ? null : (
						<AlertDialogAction
							autoFocus
							onClick={() => {
								saved.open?.(saved.item)
								onClose()
							}}
						>
							{t("previewPptxOpenCopy")}
						</AlertDialogAction>
					)}
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	)
}

export function LegacyPresentationBar({ format, saveCopy }: { format: Format | undefined; saveCopy?: LegacySaveCopy | undefined }) {
	const { t } = useTranslation(["preview", "common"])
	const [asked, setAsked] = useState(false)
	const [saving, setSaving] = useState(false)
	const [saved, setSaved] = useState<SavedCopy | null>(null)

	if (format !== "ppt") return null

	const save = async (copy: LegacySaveCopy): Promise<void> => {
		const written = await readSaveAs(copy.session).catch((e: unknown) => {
			log.error("presentation", "Save as .pptx failed", e)

			return null
		})

		if (written === null) {
			toast.error(t("previewPptxSaveAsPptxFailed"))

			return
		}

		const outcome = await uploadConvertedCopy(copy.item, written.bytes, "pptx").catch((e: unknown) => {
			log.error("presentation", "uploading the .pptx copy failed", e)

			return { status: "error", dto: null } as const
		})

		if (outcome.status === "error") {
			toast.error(outcome.dto === null ? t("previewPptxSaveAsPptxFailed") : errorLabel(outcome.dto))

			return
		}

		const differently = written.report.losses.flatMap(loss =>
			isLossKind(loss.kind) ? [t(LOSS_KEYS[loss.kind], { count: loss.count })] : []
		)

		if (differently.length === 0) {
			toast.success(t("previewPptxSavedAsPptx", { name: outcome.name }))
			copy.onOpenFile?.(outcome.item)

			return
		}

		setSaved({ item: outcome.item, name: outcome.name, differently, open: copy.onOpenFile })
	}

	return (
		<div
			data-legacy-presentation
			className="flex shrink-0 items-center gap-2 border-b border-border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground"
		>
			<FileClockIcon
				aria-hidden
				className="size-3.5 shrink-0"
			/>
			<p
				role="status"
				aria-label={t("previewPptxLegacyLabel")}
				className="min-w-0 flex-1 break-words"
			>
				{t(saveCopy === undefined ? "previewPptxLegacyViewOnly" : "previewPptxLegacyViewOnlySaveAs")}
			</p>
			{saveCopy === undefined ? null : (
				<>
					<Button
						variant="outline"
						size="xs"
						className="shrink-0"
						disabled={saving}
						onClick={() => {
							setAsked(true)
						}}
					>
						{t("previewPptxSaveAsPptx")}
					</Button>
					<ConfirmDialog
						open={asked}
						pending={saving}
						title={t("previewPptxSaveAsPptxTitle")}
						body={[t("previewPptxSaveAsPptxBody"), ...(saveCopy.encrypted ? [t("previewPptxSaveAsPptxPassword")] : [])].join(
							" "
						)}
						confirmLabel={t("previewPptxSaveAsPptx")}
						cancelLabel={t("common:cancel")}
						onOpenChange={setAsked}
						onConfirm={() => {
							setSaving(true)
							void save(saveCopy).finally(() => {
								setSaving(false)
								setAsked(false)
							})
						}}
					/>
					<SavedDifferentlyDialog
						saved={saved}
						onClose={() => {
							setSaved(null)
						}}
					/>
				</>
			)}
		</div>
	)
}
