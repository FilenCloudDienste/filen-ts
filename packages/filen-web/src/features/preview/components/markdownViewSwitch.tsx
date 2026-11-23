import type { RefObject } from "react"
import { useTranslation } from "react-i18next"
import { BookOpenIcon, ChevronDownIcon, CodeIcon, PencilIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { keepFocus } from "@/features/office/lib/officeControls"
import type { MarkdownEditMode } from "@/features/preview/lib/markdownView"
import { Kbd } from "@/lib/keymap/kbd"
import { cn } from "@filen/shared"

// A markdown document's view switch, the file preview's command bar's and the notes editor's: a Read toggle (the
// rendered page) and the editing view's menu (Live preview or Source). Leaving the editing view is locked while it
// holds unsaved edits that Read would drop (the file preview's; a note saves as it is typed); switching between Live
// preview and Source never is (one editor, reconfigured). Compact, in the notes editor's header: the editing view's menu
// first under a short name, then Read as an icon.

export interface MarkdownViewSwitchProps {
	readonly reading: boolean
	// The editing view: the current one, or the one Read returns to.
	readonly editMode: MarkdownEditMode
	// Live preview can be chosen (false past its size, markdownView.ts).
	readonly liveAvailable: boolean
	readonly readLocked: boolean
	readonly onRead: (reading: boolean) => void
	readonly onEditMode: (mode: MarkdownEditMode) => void
	// The Read toggle, focused after a keyboard switch from the editor into Read.
	readonly readRef?: RefObject<HTMLButtonElement | null> | undefined
	// The group's name, for the Read toggle's tooltip.
	readonly viewLabel: string
	readonly compact?: boolean | undefined
}

export function MarkdownViewSwitch({
	reading,
	editMode,
	liveAvailable,
	readLocked,
	onRead,
	onEditMode,
	readRef,
	viewLabel,
	compact
}: MarkdownViewSwitchProps) {
	const { t } = useTranslation("preview")
	const disabled = !reading && readLocked
	const modeLabel = t(editMode === "live" ? "previewMarkdownLivePreview" : "previewMarkdownSource")
	const triggerLabel = compact === true && editMode === "live" ? t("previewMarkdownLiveShort") : modeLabel

	const read = (
		<Tooltip>
			<TooltipTrigger
				render={
					<Button
						ref={readRef}
						variant="ghost"
						size={compact === true ? "icon-sm" : "sm"}
						aria-label={t("previewMarkdownRead")}
						aria-pressed={reading}
						disabled={disabled}
						// aria-disabled rather than disabled: the hint below must stay reachable by hover.
						focusableWhenDisabled
						className={cn(
							"shrink-0",
							compact === true ? null : "gap-1 px-2",
							reading ? "bg-accent text-foreground" : "aria-disabled:opacity-50"
						)}
						onMouseDown={keepFocus}
						onClick={() => {
							onRead(!reading)
						}}
					>
						<BookOpenIcon />
						{/* Icons only on a phone, and in the compact form. */}
						{compact === true ? null : <span className="text-xs max-sm:hidden">{t("previewMarkdownRead")}</span>}
					</Button>
				}
			/>
			<TooltipContent>
				{disabled ? t("previewMarkdownToggleDirtyHint") : compact === true ? t("previewMarkdownRead") : viewLabel}
				{disabled ? null : <Kbd action="editor.togglePreview" />}
			</TooltipContent>
		</Tooltip>
	)
	const edit = (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button
						variant="ghost"
						size="sm"
						aria-label={t("previewMarkdownEditingView", { mode: modeLabel })}
						className={reading ? "shrink-0 gap-1 px-2" : "shrink-0 gap-1 bg-accent px-2 text-foreground"}
						onMouseDown={keepFocus}
					>
						{editMode === "live" ? <PencilIcon /> : <CodeIcon />}
						<span className="text-xs max-sm:hidden">{triggerLabel}</span>
						<ChevronDownIcon className="opacity-60" />
					</Button>
				}
			/>
			<DropdownMenuContent
				align="start"
				data-preview-surface
			>
				<DropdownMenuRadioGroup
					value={reading ? "" : editMode}
					onValueChange={(next: string) => {
						onEditMode(next === "source" ? "source" : "live")
					}}
				>
					<DropdownMenuRadioItem
						value="live"
						disabled={!liveAvailable}
						closeOnClick
					>
						<PencilIcon />
						{t("previewMarkdownLivePreview")}
					</DropdownMenuRadioItem>
					<DropdownMenuRadioItem
						value="source"
						closeOnClick
					>
						<CodeIcon />
						{t("previewMarkdownSource")}
					</DropdownMenuRadioItem>
				</DropdownMenuRadioGroup>
				{liveAvailable ? null : (
					<DropdownMenuGroup>
						<DropdownMenuLabel className="max-w-64 font-normal">{t("previewMarkdownLiveTooLarge")}</DropdownMenuLabel>
					</DropdownMenuGroup>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	)

	return compact === true ? (
		<>
			{edit}
			{read}
		</>
	) : (
		<>
			{read}
			{edit}
		</>
	)
}
