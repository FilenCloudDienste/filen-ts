import { useState } from "react"
import { useTranslation } from "react-i18next"
import { FileClockIcon } from "lucide-react"
import type { Format } from "@filen/office/core/presentation"
import type { PresentationSessionApi } from "@filen/office/dom/presentation"
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
import type { DriveItem } from "@/features/drive/lib/item"
import { saveConvertedCopy, showSavedCopy, useSavedCopy, type PresentationTarget } from "@/features/presentation/lib/presentationConvert"

// The read-only face of a PowerPoint 97–2003 deck (.ppt, .pps, .pot): the presentation viewer shows it as it shows any
// deck (the worker converted it to a pptx it reads), with this bar under the command bar saying it is the legacy
// binary format and is viewed only. No edit control is offered for it (the viewer opens it view-only, and the format
// is never editable: isEditablePresentationExtension). Where a copy may be saved beside the file, the bar offers Save as
// .pptx and Save as .odp (not for a deck opened with its password: an OpenDocument copy could not keep it): the worker
// writes a fresh package (a .pptx sealed with the deck's password when it has one) to a port, the copy is uploaded next
// to the file (the docx Save as path) and opened. A copy that holds something differently is listed in a dialog that
// stays until it is closed, with the copy opened from there only. The dialog is also where the File menu's Save a copy
// of a deck viewed only (Strict, signed, protected from changes) tells what it saved: every deck surface mounts it.

// A copy may be saved beside the deck: its drive file and session, and where the copy opens.
export interface LegacySaveCopy {
	readonly item: DriveItem
	readonly session: PresentationSessionApi
	readonly encrypted: boolean
	readonly onOpenFile?: ((item: DriveItem) => void) | undefined
}

// What a copy saved from `session`'s deck holds differently, until it is closed (or the copy opened from it).
function SavedCopyDialog({ session }: { session: PresentationSessionApi | undefined }) {
	const { t } = useTranslation(["preview", "common"])
	const saved = useSavedCopy(session)
	const close = (): void => {
		showSavedCopy(null)
	}

	return (
		<AlertDialog
			open={saved !== null}
			onOpenChange={open => {
				if (!open) close()
			}}
		>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle className="break-words">
						{saved === null ? "" : t("previewPptxSavedAsPptx", { name: saved.name })}
					</AlertDialogTitle>
					<AlertDialogDescription>
						{[
							t(
								saved !== null && saved.differently.length > 0
									? "previewPptxSavedDifferently"
									: "previewPptxConvertSavedWhole"
							),
							...(saved?.protected === true ? [t("previewPptxSaveAsPptxPassword")] : [])
						].join(" ")}
					</AlertDialogDescription>
				</AlertDialogHeader>
				{saved === null || saved.differently.length === 0 ? null : (
					<ul className="flex max-h-[50dvh] list-disc flex-col gap-1 overflow-y-auto ps-5 text-sm">
						{saved.differently.map(line => (
							<li
								key={line}
								className="break-words"
							>
								{line}
							</li>
						))}
					</ul>
				)}
				<AlertDialogFooter>
					<AlertDialogCancel autoFocus={saved?.open === undefined}>{t("common:close")}</AlertDialogCancel>
					{saved?.open === undefined ? null : (
						<AlertDialogAction
							autoFocus
							onClick={() => {
								saved.open?.(saved.item)
								close()
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
	const [asked, setAsked] = useState<PresentationTarget | null>(null)
	const [saving, setSaving] = useState(false)
	// The confirm dialog keeps its words while it closes.
	const [shown, setShown] = useState<PresentationTarget>("pptx")
	const dialog = <SavedCopyDialog session={saveCopy?.session} />

	if (format !== "ppt") return saveCopy === undefined ? null : dialog

	const ask = (target: PresentationTarget): void => {
		setShown(target)
		setAsked(target)
	}
	const pptx = shown === "pptx"

	return (
		<div
			data-legacy-presentation
			className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground"
		>
			<FileClockIcon
				aria-hidden
				className="size-3.5 shrink-0"
			/>
			<p
				role="status"
				aria-label={t("previewPptxLegacyLabel")}
				className="min-w-0 flex-1 basis-40 break-words"
			>
				{t(saveCopy === undefined ? "previewPptxLegacyViewOnly" : "previewPptxLegacyViewOnlySaveAs")}
			</p>
			{saveCopy === undefined ? null : (
				<>
					<div className="flex shrink-0 gap-2">
						<Button
							variant="outline"
							size="xs"
							disabled={saving}
							onClick={() => {
								ask("pptx")
							}}
						>
							{t("previewPptxSaveAsPptx")}
						</Button>
						{/* An OpenDocument copy could not keep the deck's password. */}
						{saveCopy.encrypted ? null : (
							<Button
								variant="outline"
								size="xs"
								disabled={saving}
								onClick={() => {
									ask("odp")
								}}
							>
								{t("previewPptxConvertSaveAsOdp")}
							</Button>
						)}
					</div>
					<ConfirmDialog
						open={asked !== null}
						pending={saving}
						title={t(pptx ? "previewPptxSaveAsPptxTitle" : "previewPptxConvertSaveAsOdpTitle")}
						body={
							pptx
								? [
										t("previewPptxSaveAsPptxBody"),
										...(saveCopy.encrypted ? [t("previewPptxSaveAsPptxPassword")] : [])
									].join(" ")
								: t("previewPptxConvertSaveAsOdpBody")
						}
						confirmLabel={t(pptx ? "previewPptxSaveAsPptx" : "previewPptxConvertSaveAsOdp")}
						cancelLabel={t("common:cancel")}
						onOpenChange={open => {
							if (!open) setAsked(null)
						}}
						onConfirm={() => {
							if (asked === null) return

							setSaving(true)
							void saveConvertedCopy(saveCopy, asked).finally(() => {
								setSaving(false)
								setAsked(null)
							})
						}}
					/>
					{dialog}
				</>
			)}
		</div>
	)
}
