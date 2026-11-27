import { useRef, useState, type ChangeEvent } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { CircleCheckIcon, XIcon } from "lucide-react"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Button } from "@/components/ui/button"
import { TooltipIconButton } from "@/components/ui/tooltipIconButton"

interface MasterKeysFileFieldProps {
	disabled: boolean
	// `undefined` = no file (initial state, or the user removed the chosen one) — the caller's
	// submit falls back to the skip-keys ceremony path.
	onChange: (masterKeysFileText: string | undefined) => void
}

// Optional master-keys-file import for the reset form. Reads the chosen file as plain text, trims the
// surrounding whitespace an editor or a paste leaves behind (the SDK's base64 decode rejects even a final
// newline), and hands it to the caller — NO client-side parsing/validation of the master-key format (the SDK's
// completePasswordReset accepts its recoverKey param as raw or base64 and validates internally; never
// reimplement crypto/API logic client-side). Uncontrolled by design: a native file input's `value`
// cannot be set programmatically (only cleared), so this only tracks the chosen file's NAME locally
// for display — the caller holds the derived text itself (masterKeysFileText, never recoverKey
// outside the single worker call site). The remove button returns the field to the no-file state
// without re-opening the picker or reloading.
function MasterKeysFileField({ disabled, onChange }: MasterKeysFileFieldProps) {
	const { t } = useTranslation(["auth", "errors"])
	const inputRef = useRef<HTMLInputElement>(null)
	const [fileName, setFileName] = useState<string>()

	async function handleFileChange(e: ChangeEvent<HTMLInputElement>): Promise<void> {
		const file = e.target.files?.[0]
		if (!file) {
			return
		}
		let text: string

		try {
			text = (await file.text()).trim()
		} catch (err) {
			// A failed re-pick must not leave the previous file's text in use.
			clear()
			toast.error(errorLabel(err))

			return
		}

		if (text.length === 0) {
			clear()
			toast.error(t("errors:BadRecoveryKey"))

			return
		}

		setFileName(file.name)
		onChange(text)
	}

	function clear(): void {
		// Clearing the native input's value lets re-choosing the SAME file fire change again.
		if (inputRef.current) {
			inputRef.current.value = ""
		}
		setFileName(undefined)
		onChange(undefined)
	}

	return (
		<Field>
			<FieldLabel htmlFor="master-keys-file">{t("masterKeysFileLabel")}</FieldLabel>
			<input
				id="master-keys-file"
				ref={inputRef}
				type="file"
				accept=".txt,text/plain"
				disabled={disabled}
				className="hidden"
				onChange={e => {
					void handleFileChange(e)
				}}
			/>
			<div className="flex items-center gap-2">
				<Button
					type="button"
					variant="outline"
					disabled={disabled}
					onClick={() => {
						inputRef.current?.click()
					}}
				>
					{t("masterKeysFileChoose")}
				</Button>
				{fileName !== undefined && (
					<>
						<span className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
							<CircleCheckIcon className="size-4 shrink-0" />
							<span className="truncate">{t("masterKeysFileImported", { fileName })}</span>
						</span>
						<TooltipIconButton
							size="icon-xs"
							className="shrink-0"
							label={t("masterKeysFileRemove")}
							disabled={disabled}
							onClick={clear}
						>
							<XIcon />
						</TooltipIconButton>
					</>
				)}
			</div>
			<FieldDescription>{t("masterKeysFileHelp")}</FieldDescription>
		</Field>
	)
}

export { MasterKeysFileField }
export type { MasterKeysFileFieldProps }
