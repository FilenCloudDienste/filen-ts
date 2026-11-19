import { useRef, type KeyboardEvent, type Ref } from "react"

// Roving focus for a radio group: only the checked option (or the first) is a Tab stop, arrows move between the
// options and wrap past disabled ones, Home and End jump to the ends. `horizontal` adds Left/Right to Up/Down.
// `onMove` runs with the index focus moved to: a row whose choices are cheap selects there; a list whose choices
// are expensive (a track switch) leaves it unset and selects on Enter, Space or a click only.
export function useRovingRadioGroup({
	count,
	checked,
	horizontal = false,
	isDisabled,
	onMove
}: {
	count: number
	// The checked option's index, -1 when none is.
	checked: number
	horizontal?: boolean
	isDisabled?: (index: number) => boolean
	onMove?: (index: number) => void
}): (index: number) => { ref: Ref<HTMLButtonElement>; tabIndex: number; onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void } {
	const items = useRef<(HTMLButtonElement | null)[]>([])
	const stop = Math.max(0, checked)

	function move(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
		const forward = event.key === "ArrowDown" || (horizontal && event.key === "ArrowRight")
		const backward = event.key === "ArrowUp" || (horizontal && event.key === "ArrowLeft")
		const step = forward ? 1 : backward ? -1 : 0
		const edge = event.key === "Home" ? 0 : event.key === "End" ? count - 1 : null

		if ((step === 0 && edge === null) || count === 0) {
			return
		}

		event.preventDefault()

		let next = edge ?? index

		if (edge === null) {
			let tries = count

			while (tries-- > 0) {
				next = (next + step + count) % count

				if (isDisabled?.(next) !== true) {
					break
				}
			}
		}

		items.current[next]?.focus()
		onMove?.(next)
	}

	return index => ({
		ref: element => {
			items.current[index] = element
		},
		tabIndex: index === stop ? 0 : -1,
		onKeyDown: event => {
			move(event, index)
		}
	})
}
