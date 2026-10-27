import type { KeyboardEvent } from "react"
import type { TFunction } from "i18next"
import type { Action, GateReason, SlideRef } from "@filen/office/core/presentation"
import type { PresentationLayoutInfo, SlideLayer } from "@filen/office/dom/presentation"
import type { DriveVariant } from "@/features/drive/lib/preferences"
import { docxContextReason, viewOnlyReasonKey, type DocxContextReason } from "@/features/preview/components/docxViewer.logic"
import { isAnyMenuOpen } from "@/lib/keymap/dialogGuard"
import type { PreviewKey } from "@/lib/i18n"

// What the presentation viewer and editor share around the slide that is not a component: the deck's notes, the
// accessible names of clickable shapes, the keys that page slides, and why the editor shows a deck view-only.

export const DEFAULT_SLIDE_SIZE = { cx: 12_192_000, cy: 6_858_000 }

export const GATE_KEYS: Record<GateReason, PreviewKey> = {
	signed: "previewPptxReadOnlySigned",
	strict: "previewPptxReadOnlyStrict",
	writeProtected: "previewPptxReadOnlyWriteProtected",
	malformed: "previewPptxReadOnlyMalformed"
}

// The accessible name of a clickable shape: what a click does, after the shape's alt text when it has one.
export function actionLabel(t: TFunction<"preview">, action: Action, layer: SlideLayer): string {
	const does =
		action.kind === "url"
			? t("previewPptxActionLink", { target: action.href })
			: action.kind === "media"
				? t("previewPptxActionMedia")
				: action.kind === "refused"
					? t("previewPptxActionRefused")
					: t("previewPptxActionJump")
	const name = layer.alt?.trim() ?? ""

	return name === "" ? does : t("previewPptxActionNamed", { name, action: does.charAt(0).toLowerCase() + does.slice(1) })
}

// Keys that page slides (and never the preview's files): the rail and the show take their own first.
export const PAGE_KEYS: Readonly<Record<string, -1 | 1 | "first" | "last">> = {
	ArrowLeft: -1,
	ArrowUp: -1,
	PageUp: -1,
	ArrowRight: 1,
	ArrowDown: 1,
	PageDown: 1,
	Home: "first",
	End: "last"
}

export function isTextField(target: EventTarget | null): boolean {
	return target instanceof HTMLElement && (target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA")
}

// A key that pages slides, on the deck's root: slides page, files don't, whoever handled the key.
export function onPageKey(event: KeyboardEvent<HTMLElement>, showing: boolean, page: (step: -1 | 1 | "first" | "last") => void): void {
	const step = PAGE_KEYS[event.key]

	// A key in an open menu (it portals inside this subtree) is the menu's, and the slide under it stays.
	if (step === undefined || showing || isAnyMenuOpen()) return

	// Ctrl, Alt or Cmd with an arrow pages nothing here, and outside a text field (where it moves the caret) it does not
	// reach the browser either: WebKit's Cmd+ArrowLeft goes back a page.
	if (event.altKey || event.ctrlKey || event.metaKey) {
		if (event.key.startsWith("Arrow") && !event.defaultPrevented && !isTextField(event.target)) event.preventDefault()

		return
	}

	event.stopPropagation()

	if (event.defaultPrevented || isTextField(event.target)) return

	event.preventDefault()
	page(step)
}

// Why the editor shows the deck view-only: the file's gate, where it was opened from, its format, or a file the
// overlay can no longer save to.
export type PresentationViewOnlyReason = GateReason | DocxContextReason | "legacy" | "renamed" | "notWritable"

export function presentationViewOnlyReasons(
	gate: readonly GateReason[],
	format: string | undefined,
	variant: DriveVariant | undefined,
	editing: { readonly writable: boolean; readonly renamed: boolean }
): PresentationViewOnlyReason[] {
	const where = docxContextReason({ anon: false, archive: false, linked: false, variant })
	const out: PresentationViewOnlyReason[] = [
		...(where === null ? [] : [where]),
		...(format === "ppt" ? (["legacy"] as const) : []),
		...gate
	]

	if (editing.renamed) out.push("renamed")
	else if (!editing.writable && out.length === 0) out.push("notWritable")

	return out
}

export function viewOnlyKey(reason: PresentationViewOnlyReason): PreviewKey {
	return reason === "legacy" ? "previewPptxEditorViewOnlyLegacy" : viewOnlyReasonKey(reason)
}

// The deck's layouts as the layout menus list them: by master, each layout numbered within its master (the name a
// menu shows when the file gives none).
export interface LayoutChoiceGroup {
	readonly master: SlideRef
	readonly layouts: readonly { readonly ref: SlideRef; readonly number: number; readonly name: string | undefined }[]
}

export function layoutsByMaster(layouts: readonly PresentationLayoutInfo[]): LayoutChoiceGroup[] {
	const groups = new Map<SlideRef, { ref: SlideRef; number: number; name: string | undefined }[]>()

	for (const layout of layouts) {
		const own = groups.get(layout.master) ?? []
		const name = layout.name?.trim()

		own.push({ ref: layout.ref, number: own.length + 1, name: name === "" ? undefined : name })
		groups.set(layout.master, own)
	}

	return [...groups].map(([master, own]) => ({ master, layouts: own }))
}
