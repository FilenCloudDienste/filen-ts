import type { KeyboardEvent } from "react"

export interface KeyModifiers {
	readonly key: string
	readonly shiftKey: boolean
	readonly ctrlKey: boolean
	readonly metaKey: boolean
	readonly altKey: boolean
}

// Ctrl, Cmd or Alt held: the key is a shortcut's, never a row's or a list's own Enter, Space or arrow.
export function hasCommandModifier(event: Pick<KeyModifiers, "ctrlKey" | "metaKey" | "altKey">): boolean {
	return event.ctrlKey || event.metaKey || event.altKey
}

// The keys that activate a focused row, the keyboard twin of clicking it: Enter or Space with no modifier, a chord
// with either being some shortcut's.
export function isActivationKey(event: KeyModifiers): boolean {
	return (event.key === "Enter" || event.key === " ") && !event.shiftKey && !hasCommandModifier(event)
}

// Enter/Space on the row itself runs `activate`. A key bubbled from a control inside the row belongs to
// that control, and preventDefault would cancel its click.
export function onActivateKey(activate: () => void): (event: KeyboardEvent<HTMLElement>) => void {
	return event => {
		if (event.target !== event.currentTarget || !isActivationKey(event)) {
			return
		}

		event.preventDefault()
		activate()
	}
}
