import { useState } from "react"
import { useTranslation } from "react-i18next"
import { LockIcon } from "lucide-react"
import { ARCHIVE_PASSWORD_MAX_CHARS, archivePasswordProblem } from "@/features/drive/lib/archivePassword"
import { InputDialog } from "@/components/dialogs/inputDialog"
import { Button } from "@/components/ui/button"

export interface ArchivePasswordPromptProps {
	open: boolean
	// The archive's name.
	name: string
	// The last password tried was wrong.
	wrong: boolean
	onOpenChange: (open: boolean) => void
	// The password lives on only in the listing session (in memory, never logged).
	onSubmit: (password: string) => void
}

// The archive password as the shared secret prompt (nested in the preview overlay's dialog, as the PDF
// viewer's is): masked, and never offered to or saved by a password manager.
export function ArchivePasswordPrompt({ open, name, wrong, onOpenChange, onSubmit }: ArchivePasswordPromptProps) {
	const { t } = useTranslation(["preview", "archive"])

	return (
		<InputDialog
			open={open}
			pending={false}
			title={t("previewArchivePasswordTitle")}
			body={t(wrong ? "previewArchivePasswordWrongBody" : "previewArchivePasswordBody", { name })}
			label={t("previewArchivePasswordLabel")}
			secret
			submitLabel={t("previewArchivePasswordSubmit")}
			validate={value => archivePasswordProblem(value) === null}
			errorFor={value =>
				archivePasswordProblem(value) === "tooLong"
					? t("archive:archivePasswordTooLong", { max: ARCHIVE_PASSWORD_MAX_CHARS })
					: null
			}
			onOpenChange={onOpenChange}
			onSubmit={onSubmit}
		/>
	)
}

// Nothing can be listed without the password: a lock in the list's place, the prompt over it. Dismissing
// the prompt leaves a button to bring it back.
export function ArchivePasswordGate({ name, wrong, onSubmit }: Pick<ArchivePasswordPromptProps, "name" | "wrong" | "onSubmit">) {
	const { t } = useTranslation("preview")
	const [dismissed, setDismissed] = useState(false)

	return (
		<div className="flex size-full flex-col items-center justify-center gap-3 px-6 text-center">
			<LockIcon
				aria-hidden="true"
				className="size-8 text-muted-foreground"
			/>
			<p className="text-sm text-muted-foreground">{t("previewArchiveNeedsPassword")}</p>
			{dismissed ? (
				<Button
					variant="outline"
					onClick={() => {
						setDismissed(false)
					}}
				>
					{t("previewArchiveEnterPassword")}
				</Button>
			) : null}
			<ArchivePasswordPrompt
				open={!dismissed}
				name={name}
				wrong={wrong}
				onOpenChange={open => {
					setDismissed(!open)
				}}
				onSubmit={onSubmit}
			/>
		</div>
	)
}
