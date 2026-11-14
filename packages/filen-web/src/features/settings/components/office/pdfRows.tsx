import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { Trash2Icon } from "lucide-react"
import type { SavedPdfSignature } from "@filen/shared/pdfSignatures"
import { SettingsRow } from "@/features/settings/components/settingsLayout"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useIsOnline } from "@/lib/useIsOnline"
import { log } from "@/lib/log"
import { loadSavedSignatures, savedSignatures, useSavedSignatures } from "@/features/pdf/fillSign/savedSignatures"
import { SignaturePreview } from "@/features/pdf/fillSign/signatureDialog"
import { OcrLanguagesRow } from "@/features/pdf/ocr/ocrLanguagesRow"

// Office → PDF: PDFs are only ever saved with Save (no autosave), the visual signatures and initials saved in Fill &
// Sign (synced, features/pdf/fillSign/savedSignatures.ts), each deletable, and the text recognition languages.
export function OfficePdfRows() {
	const { t } = useTranslation(["settings", "common"])
	const saved = useSavedSignatures()
	const online = useIsOnline()
	const [managing, setManaging] = useState(false)
	const count = saved.signatures.length + saved.initials.length

	useEffect(() => {
		loadSavedSignatures().catch((error: unknown) => {
			log.warn("pdf", "saved signatures not loaded", { error })
		})
	}, [])

	return (
		<>
			<SettingsRow
				label={t("settingsOfficePdfSaving")}
				description={t("settingsOfficePdfSavingNote")}
			/>
			<SettingsRow
				label={t("settingsOfficeSavedSignatures")}
				description={t("settingsOfficeSavedSignaturesDescription")}
			>
				<div className="flex min-w-0 items-center gap-3">
					<span className="truncate text-sm text-muted-foreground">
						{count === 0 ? t("settingsOfficeSavedSignaturesNone") : t("settingsOfficeSavedSignaturesCount", { count })}
					</span>
					<Button
						type="button"
						variant="outline"
						disabled={!saved.loaded || count === 0}
						aria-label={t("settingsOfficeSavedSignaturesManageLabel")}
						onClick={() => {
							setManaging(true)
						}}
					>
						{t("settingsOfficeSavedSignaturesManage")}
					</Button>
				</div>
			</SettingsRow>
			<OcrLanguagesRow />
			<SavedSignaturesDialog
				open={managing}
				onOpenChange={setManaging}
				signatures={saved.signatures}
				initials={saved.initials}
				canDelete={online && !saved.readOnly}
				offlineReason={online ? undefined : t("common:offlineActionDisabled")}
			/>
		</>
	)
}

function SavedSignaturesDialog({
	open,
	onOpenChange,
	signatures,
	initials,
	canDelete,
	offlineReason
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	signatures: readonly SavedPdfSignature[]
	initials: readonly SavedPdfSignature[]
	canDelete: boolean
	offlineReason: string | undefined
}) {
	const { t } = useTranslation(["settings", "common"])
	// The entry whose delete is being confirmed (deleting removes it from every device).
	const [deleting, setDeleting] = useState<{ readonly id: string; readonly initials: boolean } | null>(null)

	function remove(id: string): void {
		savedSignatures.delete(id).catch((error: unknown) => {
			log.warn("pdf", "saved signature not deleted", { error })
			toast.error(t("settingsOfficeSavedSignaturesDeleteFailed"))
		})
	}

	const sections = [
		{
			key: "signatures",
			title: t("settingsOfficeSavedSignaturesSignatures"),
			items: signatures,
			initials: false,
			deleteKey: "settingsOfficeSavedSignaturesDelete" as const
		},
		{
			key: "initials",
			title: t("settingsOfficeSavedSignaturesInitials"),
			items: initials,
			initials: true,
			deleteKey: "settingsOfficeSavedInitialsDelete" as const
		}
	]

	return (
		<Dialog
			open={open}
			onOpenChange={onOpenChange}
		>
			<DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
				<DialogHeader>
					<DialogTitle>{t("settingsOfficeSavedSignaturesDialogTitle")}</DialogTitle>
					<DialogDescription>{t("settingsOfficeSavedSignaturesDialogDescription")}</DialogDescription>
				</DialogHeader>
				{sections.map(section => (
					<section
						key={section.key}
						aria-label={section.title}
						className="flex flex-col gap-2"
					>
						<h3 className="text-xs font-medium text-muted-foreground">{section.title}</h3>
						{section.items.length === 0 ? (
							<p className="text-sm text-muted-foreground">{t("settingsOfficeSavedSignaturesEmpty")}</p>
						) : (
							<ul className="flex flex-col gap-2">
								{section.items.map((item, index) => (
									<li
										key={item.id}
										className="flex items-center gap-3"
									>
										<div className="flex h-14 flex-1 items-center justify-center rounded-xl border border-input bg-white p-1.5">
											<SignaturePreview item={item} />
										</div>
										<Button
											type="button"
											variant="ghost"
											size="icon"
											disabled={!canDelete}
											title={offlineReason}
											aria-label={t(section.deleteKey, { index: index + 1 })}
											onClick={() => {
												setDeleting({ id: item.id, initials: section.initials })
											}}
										>
											<Trash2Icon />
										</Button>
									</li>
								))}
							</ul>
						)}
					</section>
				))}
			</DialogContent>
			<ConfirmDialog
				open={deleting !== null}
				pending={false}
				title={t(
					deleting?.initials === true ? "settingsOfficeSavedInitialsDeleteTitle" : "settingsOfficeSavedSignaturesDeleteTitle"
				)}
				body={t("settingsOfficeSavedSignaturesDialogDescription")}
				confirmLabel={t("settingsOfficeSavedSignaturesDeleteConfirm")}
				cancelLabel={t("common:cancel")}
				destructive
				onOpenChange={open => {
					if (!open) setDeleting(null)
				}}
				onConfirm={() => {
					if (deleting !== null) remove(deleting.id)

					setDeleting(null)
				}}
			/>
		</Dialog>
	)
}
