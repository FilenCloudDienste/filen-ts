// A drop no handler takes makes the browser open what was dropped — a file or a link replaces the app.
// Cancelled page-wide, after every drop zone has had its turn, except over a text field or editor, where
// dropping text is the native behaviour.
const DROP_EDITABLE = "input, textarea, [contenteditable]:not([contenteditable='false']), .cm-editor"

function isDropEditable(target: EventTarget | null): boolean {
	return target instanceof Element && target.closest(DROP_EDITABLE) !== null
}

function cancelStrayDrop(event: DragEvent): void {
	if (event.defaultPrevented || isDropEditable(event.target)) {
		return
	}

	event.preventDefault()

	// Shows the no-drop cursor where nothing takes the drop.
	if (event.type === "dragover" && event.dataTransfer !== null) {
		event.dataTransfer.dropEffect = "none"
	}
}

export function guardStrayDrops(): () => void {
	window.addEventListener("dragover", cancelStrayDrop)
	window.addEventListener("drop", cancelStrayDrop)

	return () => {
		window.removeEventListener("dragover", cancelStrayDrop)
		window.removeEventListener("drop", cancelStrayDrop)
	}
}
