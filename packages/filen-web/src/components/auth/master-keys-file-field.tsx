import { useRef, useState, type ChangeEvent } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { CircleCheckIcon } from "lucide-react"
import { asErrorDTO } from "@/lib/sdk/errors"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { readMasterKeysFile } from "@/components/auth/master-keys-file-field.logic"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Button } from "@/components/ui/button"

interface MasterKeysFileFieldProps {
	disabled: boolean
	onChange: (masterKeysFileText: string) => void
}

// Optional master-keys-file import for the reset form. Reads the chosen file as plain text and hands
// it straight to the caller — NO client-side parsing/validation of the master-key format (the SDK's
// completePasswordReset accepts its recoverKey param as raw or base64 and validates internally; never
// reimplement crypto/API logic client-side). Uncontrolled by design: a native file input's `value`
// cannot be set programmatically, so this only tracks the chosen file's NAME locally for display — the
// caller holds the derived text itself (masterKeysFileText, never recoverKey outside the single worker
// call site).
function MasterKeysFileField({ disabled, onChange }: MasterKeysFileFieldProps) {
	const { t } = useTranslation("auth")
	const inputRef = useRef<HTMLInputElement>(null)
	const [fileName, setFileName] = useState<string>()

	async function handleFileChange(e: ChangeEvent<HTMLInputElement>): Promise<void> {
		const file = e.target.files?.[0]
		if (!file) {
			return
		}
		try {
			const result = await readMasterKeysFile(file)
			setFileName(result.fileName)
			onChange(result.text)
		} catch (err) {
			toast.error(errorLabel(asErrorDTO(err)))
		}
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
					<span className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
						<CircleCheckIcon className="size-4 shrink-0" />
						<span className="truncate">{t("masterKeysFileImported", { fileName })}</span>
					</span>
				)}
			</div>
			<FieldDescription>{t("masterKeysFileHelp")}</FieldDescription>
		</Field>
	)
}

export { MasterKeysFileField }
export type { MasterKeysFileFieldProps }
