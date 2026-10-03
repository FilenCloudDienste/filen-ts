import type { ComponentProps } from "react"
import { useTranslation } from "react-i18next"
import { EyeIcon, EyeOffIcon } from "lucide-react"
import { SecretInput } from "@/components/ui/secretInput"
import { Button } from "@/components/ui/button"

export type ArchivePasswordInputProps = Omit<ComponentProps<typeof SecretInput>, "revealed"> & {
	revealed: boolean
	onRevealedChange: (revealed: boolean) => void
	// Every field the show/hide toggle reveals (ids, space-separated); this one alone when absent.
	revealControls?: string | undefined
}

// An archive's password field with its show/hide toggle: the compress and extract dialogs and the
// extract password prompt.
export function ArchivePasswordInput({ revealed, onRevealedChange, revealControls, ...props }: ArchivePasswordInputProps) {
	const { t } = useTranslation("archive")
	const label = t(revealed ? "archivePasswordHide" : "archivePasswordShow")

	return (
		<div className="flex items-center gap-2">
			<SecretInput
				{...props}
				revealed={revealed}
				className="flex-1"
			/>
			<Button
				type="button"
				variant="ghost"
				size="icon"
				aria-label={label}
				title={label}
				aria-pressed={revealed}
				aria-controls={revealControls ?? props.id}
				onClick={() => {
					onRevealedChange(!revealed)
				}}
			>
				{revealed ? <EyeOffIcon /> : <EyeIcon />}
			</Button>
		</div>
	)
}
