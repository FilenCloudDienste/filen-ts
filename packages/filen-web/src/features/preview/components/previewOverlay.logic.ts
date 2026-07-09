// Pure keydown-guard logic for preview-overlay.tsx's own in-dialog onKeyDown — extracted (like every
// other viewer's own *.logic.ts sibling, e.g. docx-viewer.logic.ts) so it is unit-testable under this
// project's DOM-free vitest environment (vitest.config.ts: environment "node", no jsdom/happy-dom).

// Duck-typed rather than `target instanceof Element` — this module's own unit test has no real DOM
// global to check against, mirroring sdk/errors.ts's own isSdkError precedent for the identical reason
// (a live object is probed by shape, not by a runtime class binding that may not exist here).
function hasClosest(target: EventTarget | null): target is EventTarget & { closest: (selector: string) => Element | null } {
	return typeof target === "object" && target !== null && typeof (target as { closest?: unknown }).closest === "function"
}

// True while `target` sits inside a CodeMirror surface (editable OR read-only alike) — CodeMirror's
// own Left/Right/Home/End bindings move the cursor/selection and never call stopPropagation (verified
// against the installed @codemirror/view build), so without this guard the SAME keypress that moves
// the caret also bubbles into the pager's own onKeyDown and pages away — or, while a dirty editable
// buffer is open, pops the unsaved-changes prompt on every single press.
//
// Checked on CodeMirror's own ".cm-editor" root class REGARDLESS of read-only: `readOnly` blocks EDITS
// only, not caret/selection movement, so a read-only text/code preview keeps its native arrow-key
// navigation once focus is inside it too — the pager buttons (or stepping back out to the listing)
// remain how you page one of those instead, exactly like a focused <video>/<audio> scrubber already
// claims Left/Right for seeking (see preview-overlay.tsx's own isMediaTarget).
export function isTextEditingTarget(target: EventTarget | null): boolean {
	return hasClosest(target) && target.closest(".cm-editor") !== null
}
