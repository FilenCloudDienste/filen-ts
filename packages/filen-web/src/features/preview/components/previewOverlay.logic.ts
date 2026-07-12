// Pure keydown-guard logic for previewOverlay.tsx's own in-dialog onKeyDown — extracted (like every
// other viewer's own *.logic.ts sibling, e.g. docxViewer.logic.ts) so it is unit-testable under this
// project's DOM-free vitest environment (vitest.config.ts: environment "node", no jsdom/happy-dom).

import { driveItemActions, type ItemActionDescriptor, type ItemActionId } from "@/features/drive/components/itemMenu.logic"
import { isLinkedEmbedItem, type DriveItem } from "@/features/drive/lib/item"
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
// no menu at all, matching the previous step's identical rule for the download button beside it. A
// chat/note embed's fabricated linked-file item (isLinkedEmbedItem, item.ts) is drive-sourced but
// neither owned nor a real tree member — rename/move/trash/share/versions must never be offered for
// it, so it's excluded here too, alongside the external arm.
export function previewMenuVisible(source: PreviewSource): boolean {
	return source.type === "drive" && !isLinkedEmbedItem(source.item)
}

// Duck-typed rather than `target instanceof Element` — this module's own unit test has no real DOM
// global to check against, mirroring sdk/errors.ts's own isSdkError precedent for the identical reason
// (a live object is probed by shape, not by a runtime class binding that may not exist here). Exported
// for previewOverlay.tsx's own click-to-hide-chrome handler (see shouldToggleChrome below), which needs
// the SAME "is this target inside an interactive surface" check the keyboard guard above already does.
export function hasClosest(target: EventTarget | null): target is EventTarget & { closest: (selector: string) => Element | null } {
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

// Native <video>/<audio> controls (scrubber, play/pause, volume, ...) render inside the element's own
// UA shadow root, which retargets any bubbled event's `target` back to the host <video>/<audio> element
// itself (see previewOverlay.tsx's own isMediaTarget comment) — so a click on the scrubber is otherwise
// INDISTINGUISHABLE, by target alone, from a click on the video's own picture area. This heuristic tells
// them apart by Y position: every browser's native video controls bar sits pinned to the element's own
// bottom edge, so a click landing in that bottom band is treated as a controls interaction, never a
// chrome-toggle — a click anywhere above it is the actual picture area. Not pixel-perfect across every
// browser's own control-bar height, but conservative in the SAFE direction: worst case, a toggle near
// the very bottom of the video is swallowed as a false "controls" guess rather than a scrubber drag
// accidentally toggling chrome out from under the user.
export const VIDEO_CONTROLS_BAND_PX = 48

export function isVideoControlsBandClick(elementHeight: number, clickOffsetY: number, bandPx: number = VIDEO_CONTROLS_BAND_PX): boolean {
	return clickOffsetY >= elementHeight - bandPx
}

// The click-to-hide-chrome decision (P20c): clicking the media surface itself toggles the preview
// overlay's header (which also carries the pager's prev/next buttons — there is no separate floating
// pager control to hide) — but a click on any interactive control (a viewer's own toolbar button, a
// CodeMirror surface, ...) or on a video/audio element's own native controls band must never toggle it,
// or every ordinary interaction with those surfaces would also flicker the chrome. Pure decision table,
// no DOM: previewOverlay.tsx computes `isInteractive`/`isMedia`/`mediaControlsBandHit` from the real
// click event (hasClosest + isVideoControlsBandClick above) and hands them here.
export interface ChromeToggleClick {
	// True when the click target sits inside a button/link/input/CodeMirror surface, or any other
	// widget that owns its own click semantics.
	isInteractive: boolean
	// True when the click target IS the <video>/<audio> element itself (isMediaTarget).
	isMedia: boolean
	// Only meaningful when `isMedia` is true — see isVideoControlsBandClick above.
	mediaControlsBandHit: boolean
}

export function shouldToggleChrome(click: ChromeToggleClick): boolean {
	if (click.isInteractive) {
		return false
	}

	if (click.isMedia && click.mediaControlsBandHit) {
		return false
	}

	return true
}
