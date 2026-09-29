import { useRef } from "react"
import { useTranslation } from "react-i18next"
import { SearchIcon, XIcon } from "lucide-react"
import { useAction } from "@/lib/keymap/useAction"
import { isAnyDialogOpen } from "@/lib/keymap/dialogGuard"
import { Kbd } from "@/lib/keymap/kbd"
import { KEEP_SELECTION_PROPS } from "@/features/drive/lib/clickAway.logic"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"

export interface SearchInputProps {
	// The registered action that focuses this box (mod+f by default), shown as its hint.
	action: string
	// Placeholder and accessible name.
	label: string
	value: string
	onChange: (value: string) => void
	onClear: () => void
}

export function SearchInput({ action, label, value, onChange, onClear }: SearchInputProps) {
	const { t } = useTranslation("drive")
	const inputRef = useRef<HTMLInputElement>(null)

	// Registered above at module scope. preventDefault unconditionally — every browser intercepts
	// mod+f for its own find-in-page, which must never fire while a listing has this mounted;
	// the focus steal itself stands down while a dialog is open.
	useAction(action, keyboardEvent => {
		keyboardEvent.preventDefault()

		// Any open dialog, the preview overlay, the startup reminders and the narrow-viewport sidebar
		// drawer included: focus would land on this input behind that surface's focus trap.
		if (isAnyDialogOpen()) {
			return
		}

		inputRef.current?.focus()
	})

	return (
		// min-w-0: the input's own intrinsic width is this wrapper's flex floor otherwise, and the controls
		// row beside it cannot shrink at all — on a narrow card the box would be pushed past the content
		// card's edge instead of narrowing.
		<div
			className="relative w-full max-w-xs min-w-0"
			{...KEEP_SELECTION_PROPS}
		>
			<SearchIcon
				aria-hidden="true"
				className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
			/>
			<Input
				ref={inputRef}
				type="search"
				aria-label={label}
				placeholder={label}
				value={value}
				onChange={event => {
					onChange(event.target.value)
				}}
				onKeyDown={event => {
					// Input-local, not a registered action — the listbox's own Escape (drive.clearSelection)
					// must stay untouched; this only ever fires while the search box itself has focus.
					if (event.key === "Escape") {
						event.preventDefault()
						onClear()
					}
				}}
				// The engine's own cancel glyph would sit beside the clear button below.
				className="pr-8 pl-8 [&::-webkit-search-cancel-button]:appearance-none"
			/>
			<div className="absolute top-1/2 right-1.5 -translate-y-1/2">
				{value.length > 0 ? (
					<Button
						variant="ghost"
						size="icon-xs"
						aria-label={t("driveSearchClear")}
						onClick={onClear}
					>
						<XIcon />
					</Button>
				) : (
					<Kbd action={action} />
				)}
			</div>
		</div>
	)
}
