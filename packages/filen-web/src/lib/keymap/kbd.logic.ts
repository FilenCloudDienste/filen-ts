// react-hotkeys-hook treats a comma-separated combo as ALTERNATIVES ("delete,backspace" = either
// key). A hint shows one binding, so the first alternative is what renders; the rest still work.
export function comboKeys(combo: string): string[] {
	const [first = ""] = combo.split(",")

	return first
		.split("+")
		.map(key => key.trim())
		.filter(key => key.length > 0)
}
