import { downloadBlob } from "@/lib/downloadBlob"

// Thin text-specific wrapper around the shared client-generated-download primitive — kept for its
// two existing callers (master-keys export, 2FA recovery key) rather than inlining a `new Blob(...,
// { type: "text/plain" })` at each. Not unit-tested (see downloadBlob's own doc comment: no DOM under
// this project's node-environment vitest config).
export function downloadTextFile(filename: string, content: string): void {
	downloadBlob(filename, new Blob([content], { type: "text/plain" }))
}
