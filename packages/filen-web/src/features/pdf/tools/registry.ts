import { createElement, type ComponentType, type ReactNode } from "react"
import type { LucideIcon } from "lucide-react"
import type { PdfToolAvailability, PdfToolClass, PdfWidgetSummary } from "@filen/office/core/pdfedit"
import type { PdfCommandName } from "@filen/office/dom/pdfedit"
import type { PdfViewport } from "@filen/office/dom/pdf"
import type { PdfDomDocument } from "@filen/office/react/pdf"
import type { PdfEditSessionModel, PdfEditSnapshot } from "@filen/office/react/pdfedit"
import type { ToolKeyName } from "@filen/office/react/pdfedit/tools"
import type { PdfEditSwap } from "@/features/pdf/session/swap"
import type { PdfPagesController } from "@/features/pdf/pages/pagesController"
import type { ActionDef } from "@/lib/keymap/registry"
import type { PreviewKey } from "@/lib/i18n"
import type { PdfSigningRequest } from "@/features/pdf/signing/signDocument"

// The PDF editor's tools, one module per feature (tools/<feature>.tool.tsx), each registered by one line in
// tools/index.ts. A tool says where it sits in the ribbon, its label and icon, its keys (collected into the pdfEditor
// keymap section, lib/keymap.ts), when it is offered, and what it does: an action tool runs once (`run`), a mode tool
// becomes the active tool and draws on the pages through its Overlay. The `idle` tool (selection) is the one in effect
// while no mode tool is active: its Overlay is on the pages then. Every tool's Panel is mounted beside the pages and
// shows itself when it has something to show. Everything it changes goes through the editor session's commands
// (dom/pdfedit/commands), so the swap from the viewer to the editor happens on its first use, with the input that
// started it kept and replayed.

export type PdfRibbonTab = "home" | "fillSign" | "pages" | "protect" | "tools"

export const PDF_RIBBON_TABS: readonly PdfRibbonTab[] = ["home", "fillSign", "pages", "protect", "tools"]

// What decides whether a tool is offered: may this file be edited here at all (canEditPdf, online), and, once the
// editor has the document, what its signatures and its author's restrictions allow. Before the swap `tools` is null:
// nothing is known to forbid yet, and the editor refuses what it must once it opens.
export interface PdfPolicyState {
	readonly editable: boolean
	readonly online: boolean
	readonly tools: PdfToolAvailability | null
}

// Offered, or not with the reason shown on the control.
export type PdfToolVerdict = { readonly enabled: true } | { readonly enabled: false; readonly reasonKey: PreviewKey }

// What a tool works with. `edit` runs `change` on the editor session, starting the editor first when the viewer still
// shows pdf.js (the change waits for it; a failure to start is shown by the host, never thrown here).
export interface PdfToolContext {
	// `dropped` runs instead when the change never will (the editor did not start, was poisoned or closed).
	edit(change: (session: PdfEditSessionModel) => Promise<unknown>, dropped?: () => void): void
	// Ends the active mode tool (back to selection).
	finish(): void
	// Makes `tool` the active mode tool, with `variant` (one of its variants' ids) when it has variants.
	activate(tool: string, variant?: string): void
	// The active mode tool, null while the idle one is in effect.
	readonly activeTool: string | null
	readonly swap: PdfEditSwap
	// The editor's snapshot, null before the swap.
	readonly snapshot: PdfEditSnapshot | null
	// Changes may be made now (the file may be edited here, and the app is online).
	readonly editable: boolean
	// The pages rail's selection and the page operations (absent where the viewer has no editing).
	readonly pages?: PdfPagesController
	// Saves, names and the editor's lifetime, from the viewer around it.
	readonly host: PdfToolHost
	// A tool's one-line notice under the ribbon (it dismisses itself with notify(null)); null clears it.
	notify(notice: ReactNode): void
	// Places a certificate signature and signs it as the last step of a save (signing/signDocument.ts); true once the
	// signed file is saved. The signer is terminated either way.
	sign(request: PdfSigningRequest): Promise<boolean>
}

// Runs `read` on the editor session (starting the editor first if needed) and answers what it returns, its failure
// coming back here instead of the host's generic "couldn't be made" notice; rejected too when the editor never ran it
// (it did not start, was poisoned or closed). Never call it from inside another change: changes run one after another.
export function withPdfSession<T>(context: PdfToolContext, read: (session: PdfEditSessionModel) => Promise<T>): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		context.edit(
			session => read(session).then(resolve, reject),
			() => {
				reject(new Error("the editor did not start"))
			}
		)
	})
}

// Where a save a tool asks for goes: a new version of the file (the preview's Save, with its checks), or a new file
// beside it named "<name> (<suffix>).pdf" (the first free one).
export type PdfToolSaveTarget = { readonly kind: "version" } | { readonly kind: "copy"; readonly suffix: (number: number) => string }

export type PdfToolSaveOutcome =
	// `name`: the copy's.
	| { readonly status: "saved"; readonly name: string | null }
	// Refused or failed (a SaveRefusedError says why; nothing was written).
	| { readonly status: "failed"; readonly error: unknown }
	// Not started (another save running, a dialog open) or abandoned by the user.
	| { readonly status: "cancelled" }

// What the viewer around the editor offers its tools beyond changes.
export interface PdfToolHost {
	// The file's name, and the names taken beside it (lowercased), for a copy's name.
	readonly fileName: string
	takenNames(): Promise<ReadonlySet<string>>
	// A save in place is possible (the file may be written here).
	readonly canSaveInPlace: boolean
	save(target: PdfToolSaveTarget): Promise<PdfToolSaveOutcome>
	// The owner password unlocked the document: the editor reopens the file with it from now on.
	unlocked(password: string): void
	// Leaves the editor, back to the file as last saved (unsaved changes go).
	close(): void
}

// A key pressed or released on the page surface (outside fields), offered to the tool in effect: Enter, Escape
// (pdf.escape), Delete (pdf.delete), the arrows, and Space (held: a temporary hand). `page` is the 0-based page in
// view.
export interface PdfToolKeyEvent {
	readonly kind: "down" | "up"
	readonly key: ToolKeyName | "Space"
	readonly shift: boolean
	readonly alt: boolean
	readonly page: number
}

export interface PdfToolOverlayProps {
	readonly context: PdfToolContext
	// 0-based page, and the viewport that maps its bottom-left user space to the page's box.
	readonly page: number
	readonly viewport: PdfViewport
	// The page's form widgets, once the editor has read them (null before the swap).
	readonly widgets: readonly PdfWidgetSummary[] | null
	// The editor has the document: `viewport` is its page's (display space = its user space flipped, origin top left);
	// before the swap it is pdf.js's.
	readonly editing: boolean
	// The document shown: the viewer's (pdf.js) before the swap, the editor's after.
	readonly document: PdfDomDocument
	// The tool's chosen variant (one of `variants`), null for a tool without.
	readonly variant: string | null
}

export interface PdfToolPanelProps {
	readonly context: PdfToolContext
	readonly document: PdfDomDocument
	// Its tool is the active one.
	readonly active: boolean
	readonly phone: boolean
}

// One choice of a tool with variants (Highlight ▾: underline, strikethrough, …), offered in its ribbon menu.
export interface PdfToolVariant {
	readonly id: string
	readonly labelKey: PreviewKey
	readonly icon: LucideIcon
}

export interface PdfTool {
	readonly id: string
	readonly ribbon: { readonly tab: PdfRibbonTab; readonly group: string; readonly order: number }
	readonly labelKey: PreviewKey
	readonly icon: LucideIcon
	// The kind of change it makes (the signature policy and the author's restrictions speak of these).
	readonly toolClass: PdfToolClass
	// Its keys: the ids it handles, defined in `actions` (registered in the pdfEditor section).
	readonly actionIds: readonly string[]
	readonly actions: readonly ActionDef[]
	readonly enabledWhen: (policy: PdfPolicyState) => PdfToolVerdict
	// The commands it dispatches (for review: a tool never changes the document any other way).
	readonly commands: readonly PdfCommandName[]
	// An action tool runs once; without `run` it is a mode tool, active until finished.
	readonly run?: (context: PdfToolContext) => void
	// A mode tool's variants, the first the default, chosen in its ribbon menu.
	readonly variants?: readonly PdfToolVariant[]
	// The tool in effect while no mode tool is active (selection), shown pressed then.
	readonly idle?: true
	// A key on the page surface while the tool is in effect: true when it took the key.
	readonly onKey?: (event: PdfToolKeyEvent, context: PdfToolContext) => boolean
	readonly Overlay?: ComponentType<PdfToolOverlayProps>
	readonly Panel?: ComponentType<PdfToolPanelProps>
	// Where its Panel sits: beside the pages (default), or above them ("top": a bar, or a view laid over the pages).
	readonly panelSlot?: PdfToolPanelSlot
}

export type PdfToolPanelSlot = "top" | "side"

// A Panel shown only while its tool is the active one, for panels whose mounting starts what they show.
export function whileActive(Panel: ComponentType<PdfToolPanelProps>): ComponentType<PdfToolPanelProps> {
	return function ActivePanel(props: PdfToolPanelProps) {
		return props.active ? createElement(Panel, props) : null
	}
}

// The usual rule: offered where the file may be edited and the document allows the tool's kind of change.
export function toolEnabled(toolClass: PdfToolClass, policy: PdfPolicyState): PdfToolVerdict {
	if (!policy.editable) return { enabled: false, reasonKey: "previewPdfToolNotEditable" }
	if (!policy.online) return { enabled: false, reasonKey: "previewPdfToolOffline" }

	const block = policy.tools?.[toolClass] ?? null

	if (block === "signed") return { enabled: false, reasonKey: "previewPdfToolSigned" }
	if (block === "restricted") return { enabled: false, reasonKey: "previewPdfOwnerRestricted" }

	return { enabled: true }
}

// The tools of a ribbon tab in their groups' order, then their own.
export function toolsOfTab(tools: readonly PdfTool[], tab: PdfRibbonTab): PdfTool[] {
	return tools.filter(tool => tool.ribbon.tab === tab).sort((a, b) => a.ribbon.order - b.ribbon.order)
}

// The tool in effect: the active mode tool, else the idle one.
export function toolInEffect(tools: readonly PdfTool[], activeTool: string | null): PdfTool | undefined {
	return tools.find(tool => (activeTool === null ? tool.idle === true : tool.id === activeTool))
}

// A tool's variant: the chosen one when it is one of the tool's, else its first; null without variants.
export function toolVariant(tool: PdfTool, chosen: string | undefined): PdfToolVariant | null {
	const variants = tool.variants ?? []

	return variants.find(variant => variant.id === chosen) ?? variants[0] ?? null
}
