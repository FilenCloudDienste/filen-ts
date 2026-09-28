// A keydown that belongs to an input method rather than to the page: during a composition, or (Safari)
// the one confirming it, which only its legacy keyCode 229 tells apart from a plain Enter.
export function isImeKeydown(event: { key: string; isComposing: boolean; keyCode: number }): boolean {
	return event.isComposing || event.key === "Process" || event.keyCode === 229
}
