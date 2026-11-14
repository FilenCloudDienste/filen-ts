import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { Trash2Icon } from "lucide-react"
import type { SavedPdfSignature } from "@filen/shared/pdfSignatures"
import { SettingsRow } from "@/features/settings/components/settingsLayout"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useIsOnline } from "@/lib/useIsOnline"
import { log } from "@/lib/log"
import { loadSavedSignatures, savedSignatures, useSavedSignatures } from "@/features/pdf/fillSign/savedSignatures"
import { SignaturePreview } from "@/features/pdf/fillSign/signatureDialog"

// Office → PDF: PDFs are only ever saved with Save (no autosave), and the visual signatures and initials saved in
// Fill & Sign (synced, features/pdf/fillSign/savedSignatures.ts), each deletable.
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
						aria-label={t("settingsOfficeSavedSignatures")}
						onClick={() => {
							setManaging(true)
						}}
					>
						{t("settingsOfficeSavedSignaturesManage")}
					</Button>
				</div>
			</SettingsRow>
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
	const { t } = useTranslation("settings")

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
			deleteKey: "settingsOfficeSavedSignaturesDelete" as const
		},
		{
			key: "initials",
			title: t("settingsOfficeSavedSignaturesInitials"),
			items: initials,
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
												remove(item.id)
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
		</Dialog>
	)
}
