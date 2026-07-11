import { sanitizeRichTextHtml } from "@/features/notes/lib/sanitizeRichText"

// Pure, Quill-free logic for the rich-text editor — kept out of the .tsx so the propagation gate, the
// sanitize-before-seed pipeline, the read-only enforcement and the toolbar format-toggle decisions are
// unit-testable with lightweight stubs instead of a full Quill instance (jsdom-hostile). A faithful
// port of mobile's richText/dom.tsx behaviour MINUS the WebView bridge (the component calls the Quill
// instance directly).

export type RichHeaderLevel = 1 | 2 | 3 | 4 | 5 | 6
export type RichListValue = "ordered" | "bullet" | "checked" | "unchecked"
// Quill's EmitterSource literals — kept local so this module stays Quill-import-free while its
// signatures still line up with the Quill instance the component hands in.
export type QuillSource = "user" | "api" | "silent"
// The list actions a toolbar can request (Quill's checklist maps to checked/unchecked internally).
export type RichListRequest = "ordered" | "bullet" | "checklist"

// The subset of Quill's format map the toolbar reflects. Quill's getFormat returns loosely-typed
// values, so this is the NARROWED shape reflectRichFormats produces from it — the toolbar never reads
// Quill's raw map directly.
export interface RichActiveFormats {
	bold: boolean
	italic: boolean
	underline: boolean
	blockquote: boolean
	codeBlock: boolean
	header: RichHeaderLevel | null
	list: RichListValue | null
	link: string | null
}

export const EMPTY_RICH_FORMATS: RichActiveFormats = {
	bold: false,
	italic: false,
	underline: false,
	blockquote: false,
	codeBlock: false,
	header: null,
	list: null,
	link: null
}

// #39 gate (mobile richText/dom.tsx:248): propagate to the outbox ONLY for Quill's own user-vs-
// programmatic discriminator being "user". Genuine typing, paste, dictation and autocomplete all emit
// "user"; the initial dangerouslyPasteHTML(seed, "silent") and any api-source write do not — so the
// mount-frozen seed never re-enqueues itself as an edit.
export function shouldPropagateRichChange(source: string): boolean {
	return source === "user"
}

// The clipboard surface seedRichEditor drives — structural so a test passes a stub capturing the paste.
export interface RichSeedTarget {
	clipboard: {
		dangerouslyPasteHTML: (html: string, source: QuillSource) => void
	}
}

// Sanitize-before-seed (01-DECISIONS D1): the seed is DOMPurify-sanitized with the pinned allowlist
// (shared sanitizeRichText.ts — the SAME module the read-only renderer uses, so the two paths can never
// drift) BEFORE it reaches Quill, then pasted "silent" so it does not propagate as a user edit. A
// hostile seed is neutralized here, once, at mount — the editor never sees raw untrusted HTML.
export function seedRichEditor(target: RichSeedTarget, seed: string): void {
	target.clipboard.dangerouslyPasteHTML(sanitizeRichTextHtml(seed), "silent")
}

// The enable surface applyRichReadOnly drives.
export interface RichEnableTarget {
	enable: (enabled: boolean) => void
}

// #40 enforcement (mobile richText/dom.tsx:268): re-apply read-only whenever the prop flips. Quill
// honours the construction flag; this keeps a note that turns read-only mid-session (e.g. a permission
// change over the socket) from accepting edits that would then wedge sync forever.
export function applyRichReadOnly(target: RichEnableTarget, readOnly: boolean): void {
	target.enable(!readOnly)
}

// The value to hand Quill's format("header", …). Toggles the requested level off when it is already
// active, otherwise switches to it (mobile quillToggleHeader).
export function nextHeaderValue(current: RichHeaderLevel | null, requested: RichHeaderLevel): RichHeaderLevel | false {
	return current === requested ? false : requested
}

// The value to hand Quill's format("list", …) (mobile quillToggleList): toggle the active list off,
// otherwise switch to the requested type — a checklist request maps to Quill's "unchecked".
export function nextListValue(current: RichListValue | null, requested: RichListRequest): RichListValue | false {
	if (
		(requested === "ordered" && current === "ordered") ||
		(requested === "bullet" && current === "bullet") ||
		(requested === "checklist" && (current === "checked" || current === "unchecked"))
	) {
		return false
	}

	if (requested === "checklist") {
		return "unchecked"
	}

	return requested
}

// A plain on/off toggle value (bold/italic/underline/blockquote/code-block) — hand the negation to the
// matching format() call.
export function nextToggleValue(active: boolean): boolean {
	return !active
}

// A compact web toolbar groups mobile's 1-6 header levels into a single cycling button: none → H1 → H2
// → H3 → none. Returns the value to hand format("header", …). Keeps the toolbar to one control while
// still reaching the headings a note commonly uses.
export function cycleHeaderValue(current: RichHeaderLevel | null): RichHeaderLevel | false {
	if (current === 1) {
		return 2
	}

	if (current === 2) {
		return 3
	}

	if (current === 3) {
		return false
	}

	return 1
}

function narrowHeader(value: unknown): RichHeaderLevel | null {
	if (value === 1 || value === 2 || value === 3 || value === 4 || value === 5 || value === 6) {
		return value
	}

	return null
}

function narrowList(value: unknown): RichListValue | null {
	if (value === "ordered" || value === "bullet" || value === "checked" || value === "unchecked") {
		return value
	}

	return null
}

// Narrow Quill's getFormat map into the toolbar's typed active-format model (mobile's postFormatUpdates
// reflection, sans the bridge). Never trusts the raw shape: unknown/absent values fall back to inactive.
export function reflectRichFormats(raw: Record<string, unknown>): RichActiveFormats {
	return {
		bold: raw["bold"] === true,
		italic: raw["italic"] === true,
		underline: raw["underline"] === true,
		blockquote: raw["blockquote"] === true,
		codeBlock: Boolean(raw["code-block"]),
		header: narrowHeader(raw["header"]),
		list: narrowList(raw["list"]),
		link: typeof raw["link"] === "string" ? raw["link"] : null
	}
}
