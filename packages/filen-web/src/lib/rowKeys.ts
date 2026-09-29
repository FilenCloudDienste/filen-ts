import type { KeyboardEvent } from "react"

// The keys that activate a focused row, the keyboard twin of clicking it.
export function isActivationKey(key: string): boolean {
	return key === "Enter" || key === " "
}

// Enter/Space on the row itself runs `activate`. A key bubbled from a control inside the row belongs to
// that control, and preventDefault would cancel its click.
export function onActivateKey(activate: () => void): (event: KeyboardEvent<HTMLElement>) => void {
	return event => {
		if (event.target !== event.currentTarget || !isActivationKey(event.key)) {
			return
		}

		event.preventDefault()
		activate()
	}
}
