import { useRef } from "react"
import { useTranslation } from "react-i18next"
import { SearchIcon, XIcon } from "lucide-react"
import { registerAction } from "@/lib/keymap/registry"
import { useAction } from "@/lib/keymap/useAction"
import { Kbd } from "@/lib/keymap/kbd"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"

// Module scope, not inside the component: runs exactly once per module evaluation (see
// directory-listing.tsx's own drive.* registrations for the full StrictMode/HMR rationale). Old-web
// parity: mod+f intercepts the browser's own find-in-page ONLY while a drive listing has this
// registered (see the useAction below's preventDefault) — user-rebindable like every other action.
registerAction({
	id: "drive.search",
	defaultCombo: "mod+f",
	scope: "drive",
	descriptionKey: "driveCommandSearch"
})

export interface SearchInputProps {
	value: string
	onChange: (value: string) => void
	onClear: () => void
}

export function SearchInput({ value, onChange, onClear }: SearchInputProps) {
	const { t } = useTranslation("drive")
	const inputRef = useRef<HTMLInputElement>(null)

	// Registered above at module scope. preventDefault unconditionally — every browser intercepts
	// mod+f for its own find-in-page, which must never fire while a drive listing has this mounted.
	useAction(
		"drive.search",
		keyboardEvent => {
			keyboardEvent.preventDefault()
			inputRef.current?.focus()
		},
		undefined,
		[]
	)

	return (
		<div className="relative w-full max-w-xs">
			<SearchIcon
				aria-hidden="true"
				className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
			/>
			<Input
				ref={inputRef}
				type="search"
				aria-label={t("driveSearch")}
				placeholder={t("driveSearch")}
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
				className="pr-8 pl-8"
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
					<Kbd action="drive.search" />
				)}
			</div>
		</div>
	)
}
