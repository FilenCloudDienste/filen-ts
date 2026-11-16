// "preview" namespace, rich viewers — the canvas viewer shell shared by the 3D, CAD, DICOM and map viewers.
// Spread into preview.ts; same catalog rules.
export const previewRichShell = {
	/** Canvas viewers — shown over the picture while the graphics display is being reset after the browser dropped it */
	previewRichShellRestoring: "Display reset — restoring…",
	/** Canvas viewers — the graphics display could not be restored; offered with Download and "Reload viewer" */
	previewRichShellContextFailed: "The display couldn't be restored.",
	/** Canvas viewers — button reopening the viewer (reads the file again) after its display could not be restored */
	previewRichShellReload: "Reload viewer"
} as const
