// File System Access API — absent from TypeScript's DOM lib (verified: no lib.dom*.d.ts under
// this project's installed typescript declares showSaveFilePicker) and no @types package is
// installed. Ambient global shim for exactly the subset saveDownload.ts's FSA branch calls:
// window.showSaveFilePicker -> a file handle -> createWritable() -> a WritableStream-compatible
// sink. No top-level import/export, so this augments the global scope directly (mirrors
// vite-env.d.ts), unlike sdk-rs-shims.d.ts's module augmentation.

interface FileSystemWritableFileStream extends WritableStream<Uint8Array> {
	write(data: BufferSource | Blob | string): Promise<void>
	seek(position: number): Promise<void>
	truncate(size: number): Promise<void>
}

interface FileSystemFileHandle {
	readonly kind: "file"
	readonly name: string
	createWritable(options?: { keepExistingData?: boolean }): Promise<FileSystemWritableFileStream>
}

interface SaveFilePickerOptions {
	suggestedName?: string
	types?: { description?: string; accept: Record<string, string[]> }[]
	excludeAcceptAllOption?: boolean
	id?: string
	startIn?: string
}

interface Window {
	// Optional: Chromium-only — isFsaAvailable() feature-detects this before ever calling it.
	// Property-typed (not method-shorthand) so extracting it into a local const (saveDownload.ts's
	// pickFsaTarget) doesn't trip @typescript-eslint/unbound-method — it never reads `this` anyway.
	showSaveFilePicker?: (options?: SaveFilePickerOptions) => Promise<FileSystemFileHandle>
}
