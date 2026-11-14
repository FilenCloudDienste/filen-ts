import { useTranslation } from "react-i18next"
import { SearchIcon, SquareDashedIcon, TextCursorInputIcon, type LucideIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { RedactMode } from "@/features/pdf/redact/redaction.logic"

// Protect › Redact: the three ways to mark content, one active at a time. Choosing the active one again leaves the
// mode (back to selecting).

export interface RedactModeBarProps {
	mode: RedactMode | null
	onModeChange: (mode: RedactMode | null) => void
	disabled?: boolean | undefined
	// Why the controls are disabled (a signed document, the editor unavailable).
	disabledReason?: string | undefined
}

const MODES: readonly {
	readonly mode: RedactMode
	readonly icon: LucideIcon
	readonly label: "previewPdfRedactArea" | "previewPdfRedactText" | "previewPdfRedactFind"
	readonly hint: "previewPdfRedactAreaHint" | "previewPdfRedactTextHint" | "previewPdfRedactFindHint"
}[] = [
	{ mode: "area", icon: SquareDashedIcon, label: "previewPdfRedactArea", hint: "previewPdfRedactAreaHint" },
	{ mode: "text", icon: TextCursorInputIcon, label: "previewPdfRedactText", hint: "previewPdfRedactTextHint" },
	{ mode: "find", icon: SearchIcon, label: "previewPdfRedactFind", hint: "previewPdfRedactFindHint" }
]

export function RedactModeBar({ mode, onModeChange, disabled, disabledReason }: RedactModeBarProps) {
	const { t } = useTranslation("preview")

	return (
		<div
			role="group"
			aria-label={t("previewPdfRedactMode")}
			className="flex items-center gap-1"
		>
			{MODES.map(entry => {
				const Icon = entry.icon
				const active = mode === entry.mode

				return (
					<Tooltip key={entry.mode}>
						<TooltipTrigger
							render={
								<Button
									variant={active ? "secondary" : "ghost"}
									size="sm"
									aria-pressed={active}
									disabled={disabled === true}
									title={disabled === true ? disabledReason : undefined}
									onClick={() => {
										onModeChange(active ? null : entry.mode)
									}}
								/>
							}
						>
							<Icon aria-hidden />
							{t(entry.label)}
						</TooltipTrigger>
						<TooltipContent>{t(entry.hint)}</TooltipContent>
					</Tooltip>
				)
			})}
		</div>
	)
}
