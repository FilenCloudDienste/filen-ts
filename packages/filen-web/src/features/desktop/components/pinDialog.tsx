import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { formatSecondsToMediaClock } from "@filen/shared"
import { DESKTOP_PIN_MAX_LENGTH, DESKTOP_PIN_MIN_LENGTH, desktopPinSchema } from "@filen/shared/desktopLock"
import { FormDialog } from "@/components/dialogs/formDialog"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { SecretInput } from "@/components/ui/secretInput"
import { desktopBridge } from "@/lib/desktop"
import { log } from "@/lib/log"

export type PinDialogMode = "set" | "change" | "remove"

interface PinFieldProps {
	id: string
	label: string
	value: string
	disabled: boolean
	onChange: (value: string) => void
}

function PinField({ id, label, value, disabled, onChange }: PinFieldProps) {
	return (
		<Field>
			<FieldLabel htmlFor={id}>{label}</FieldLabel>
			<SecretInput
				id={id}
				inputMode="numeric"
				maxLength={DESKTOP_PIN_MAX_LENGTH}
				className="leading-5"
				value={value}
				disabled={disabled}
				onChange={event => {
					onChange(event.target.value.replaceAll(/\D/g, ""))
				}}
			/>
		</Field>
	)
}

interface PinDialogProps {
	mode: PinDialogMode | null
	onClose: () => void
}

// Sets, changes or removes the app lock PIN. Main checks the current PIN (with its backoff) and stores the new one;
// this dialog only collects them.
export function PinDialog({ mode, onClose }: PinDialogProps) {
	const { t } = useTranslation(["desktop", "common"])
	const [current, setCurrent] = useState("")
	const [next, setNext] = useState("")
	const [confirm, setConfirm] = useState("")
	const [pending, setPending] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const needsCurrent = mode === "change" || mode === "remove"
	const needsNext = mode === "set" || mode === "change"
	const mismatched = needsNext && confirm.length > 0 && confirm !== next
	const canSubmit =
		(!needsCurrent || desktopPinSchema.allows(current)) && (!needsNext || (desktopPinSchema.allows(next) && next === confirm))

	function close(): void {
		setCurrent("")
		setNext("")
		setConfirm("")
		setError(null)
		onClose()
	}

	async function submit(): Promise<void> {
		const bridge = desktopBridge()

		if (bridge === undefined || mode === null || !canSubmit) {
			return
		}

		setPending(true)
		setError(null)

		try {
			const result = mode === "remove" ? await bridge.lock.clear(current) : await bridge.lock.set(next, needsCurrent ? current : null)

			if (result.ok) {
				toast.success(t(mode === "remove" ? "pinRemoved" : "pinSaved"))
				close()

				return
			}

			setCurrent("")
			setError(
				result.retryAt === null
					? t("pinWrong")
					: t("lockRetryIn", { time: formatSecondsToMediaClock(Math.ceil((result.retryAt - Date.now()) / 1000)) })
			)
		} catch (failure) {
			log.error("desktop", "PIN change failed", failure)
			toast.error(t("pinFailed"))
		} finally {
			setPending(false)
		}
	}

	return (
		<FormDialog
			open={mode !== null}
			pending={pending}
			title={t(mode === "set" ? "pinSetTitle" : mode === "change" ? "pinChangeTitle" : "pinRemoveTitle")}
			description={
				mode === "remove"
					? t("pinRemoveDescription")
					: t("pinRulesDescription", { min: DESKTOP_PIN_MIN_LENGTH, max: DESKTOP_PIN_MAX_LENGTH })
			}
			submitLabel={t(mode === "remove" ? "pinRemove" : "pinSave")}
			cancelLabel={t("common:cancel")}
			canSubmit={canSubmit}
			onOpenChange={open => {
				if (!open) {
					close()
				}
			}}
			onSubmit={event => {
				event.preventDefault()
				void submit()
			}}
		>
			<FieldGroup>
				{needsCurrent ? (
					<PinField
						id="desktop-pin-current"
						label={t("pinCurrent")}
						value={current}
						disabled={pending}
						onChange={setCurrent}
					/>
				) : null}
				{needsNext ? (
					<>
						<PinField
							id="desktop-pin-new"
							label={t("pinNew")}
							value={next}
							disabled={pending}
							onChange={setNext}
						/>
						<PinField
							id="desktop-pin-confirm"
							label={t("pinConfirm")}
							value={confirm}
							disabled={pending}
							onChange={setConfirm}
						/>
					</>
				) : null}
				{mismatched || error !== null ? (
					<p
						className="text-sm text-destructive"
						aria-live="polite"
					>
						{error ?? t("pinMismatch")}
					</p>
				) : null}
			</FieldGroup>
		</FormDialog>
	)
}
