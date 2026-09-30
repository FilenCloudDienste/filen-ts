// Shared by the listbox rows and the textarea's aria-activedescendant.
export function suggestionOptionId(listboxId: string, index: number): string {
	return `${listboxId}-option-${String(index)}`
}
