import { useCallback, useState } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { CheckIcon } from "lucide-react"
import type { Contact } from "@filen/sdk-rs"
import { ContactRow } from "@/features/contacts/components/contactRow"
import { observeElementOffsetFromAttach } from "@/lib/virtualScroll"

// A ContactRow (h-14) and the 2px gap below it.
const ROW_HEIGHT = 58
// The list's p-2, inside the scroll box.
const LIST_PADDING = 8
const OVERSCAN = 8

// The picker's multi-select listbox as a window over fixed-height rows: an account with hundreds of contacts mounts what
// is in view. Every row stays its own Tab stop; focusing one scrolls it into view, which mounts the next. Its own file,
// as useVirtualizer opts it out of the React Compiler (the picker stays compiled).
export function ContactPickerRows({
	contacts,
	selected,
	onToggle,
	ariaLabel
}: {
	contacts: readonly Contact[]
	selected: ReadonlySet<string>
	onToggle: (uuid: string) => void
	ariaLabel: string
}) {
	const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
	// Memoized by hand: the virtualizer re-lays every row when its key function changes, so it changes with the rows.
	const getItemKey = useCallback((index: number) => contacts[index]?.uuid ?? index, [contacts])
	const virtualizer = useVirtualizer({
		count: contacts.length,
		getScrollElement: () => scrollElement,
		observeElementOffset: observeElementOffsetFromAttach,
		estimateSize: () => ROW_HEIGHT,
		paddingStart: LIST_PADDING,
		paddingEnd: LIST_PADDING - 2,
		overscan: OVERSCAN,
		getItemKey
	})

	return (
		<div
			ref={setScrollElement}
			role="listbox"
			aria-multiselectable="true"
			aria-label={ariaLabel}
			className="flex-1 scrollbar-gutter-stable overflow-y-auto px-2"
		>
			<div
				role="none"
				className="relative w-full"
				style={{ height: virtualizer.getTotalSize() }}
			>
				{virtualizer.getVirtualItems().map(row => {
					const contact = contacts[row.index]

					if (contact === undefined) {
						return null
					}

					const isSelected = selected.has(contact.uuid)

					return (
						<div
							key={row.key}
							role="none"
							className="absolute top-0 left-0 w-full"
							style={{ transform: `translateY(${String(row.start)}px)` }}
						>
							<ContactRow
								contact={contact}
								selected={isSelected}
								posInSet={row.index + 1}
								setSize={contacts.length}
								onToggleSelect={() => {
									onToggle(contact.uuid)
								}}
							>
								{isSelected ? (
									<CheckIcon
										aria-hidden="true"
										className="size-4 shrink-0 text-primary"
									/>
								) : null}
							</ContactRow>
						</div>
					)
				})}
			</div>
		</div>
	)
}
