// Pure keydown-guard logic for previewOverlay.tsx's own in-dialog onKeyDown — extracted (like every
// other viewer's own *.logic.ts sibling, e.g. docxViewer.logic.ts) so it is unit-testable under this
// project's DOM-free vitest environment (vitest.config.ts: environment "node", no jsdom/happy-dom).

import { driveItemActions, type ItemActionDescriptor, type ItemActionId } from "@/features/drive/components/itemMenu.logic"
import { type DriveItem } from "@/features/drive/lib/item"
import { type DriveVariant } from "@/features/drive/lib/preferences"
import { type PreviewSource } from "@/features/preview/lib/previewSource"

// The header item-menu never offers Download — the header already has its own dedicated download
// button right next to the menu's own trigger (previewOverlay.tsx).
export const PREVIEW_MENU_HIDDEN_ACTION_IDS = new Set<ItemActionId>(["download"])

// Same descriptor list + variant/type/undecryptable gating the row/tile ⋯ dropdown uses
// (driveItemActions), Download stripped — pulled out here so the gating itself (trash reduces to
// restore/delete/info, links drops move, sharedIn/sharedOut drop the owner-mutating group, etc.) is
// unit-testable without mounting the overlay itself.
export function previewMenuActions(item: DriveItem, variant: DriveVariant): ItemActionDescriptor[] {
	return driveItemActions(item, variant).filter(descriptor => !PREVIEW_MENU_HIDDEN_ACTION_IDS.has(descriptor.id))
}

// The header's ⋯ trigger only ever mounts for a drive-sourced slot — the external arm (the seam for
// future chat/note attachments) carries no DriveItem for driveItemActions to gate against, so it shows
// no menu at all, matching the previous step's identical rule for the download button beside it.
export function previewMenuVisible(source: PreviewSource): boolean {
	return source.type === "drive"
}

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
// claims Left/Right for seeking (see previewOverlay.tsx's own isMediaTarget).
export function isTextEditingTarget(target: EventTarget | null): boolean {
	return hasClosest(target) && target.closest(".cm-editor") !== null
}
