// The DOCX viewer's controls as serialisable commands and state: an app renders its own toolbar from the
// state and the command table, and sends commands back (directly on web, over the bridge from a native
// toolbar to an Expo DOM component on mobile). The surface that owns pages, zoom and find applies them.

export const DOCX_MIN_ZOOM = 0.25
export const DOCX_MAX_ZOOM = 4
export const DOCX_ZOOM_STEPS: readonly number[] = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4]

export type DocxViewerCommand =
	| { readonly type: "page.previous" }
	| { readonly type: "page.next" }
	// 0-based.
	| { readonly type: "page.goto"; readonly page: number }
	| { readonly type: "zoom.in" }
	| { readonly type: "zoom.out" }
	// 1 = 100 %.
	| { readonly type: "zoom.set"; readonly zoom: number }
	// Adds `delta` to the zoom on screen (wheel and pinch gestures, which arrive faster than renders).
	| { readonly type: "zoom.by"; readonly delta: number }
	| { readonly type: "zoom.fitWidth" }
	| { readonly type: "find.open" }
	| { readonly type: "find.close" }
	// Options left out keep the last search's.
	| { readonly type: "find.query"; readonly query: string; readonly caseSensitive?: boolean; readonly wholeWord?: boolean }
	| { readonly type: "find.next" }
	| { readonly type: "find.previous" }

export type DocxViewerCommandType = DocxViewerCommand["type"]

// What a document allows. The viewer is read-only; selection, copy and find always work.
export interface DocxCapabilities {
	readonly readOnly: boolean
	readonly select: boolean
	readonly copy: boolean
	readonly find: boolean
}

export const DOCX_VIEWER_CAPABILITIES: DocxCapabilities = { readOnly: true, select: true, copy: true, find: true }

export interface DocxViewerState {
	readonly status: "loading" | "streaming" | "ready" | "error"
	readonly capabilities: DocxCapabilities
	// 0-based page in the middle of the view.
	readonly page: number
	readonly pageCount: number
	// False while layout is still adding pages (pageCount is then an estimate).
	readonly pageCountFinal: boolean
	readonly zoom: number
	readonly zoomMode: "fitWidth" | "custom"
	readonly find: {
		readonly open: boolean
		readonly query: string
		readonly caseSensitive: boolean
		// Word's "Find whole words only".
		readonly wholeWord: boolean
		readonly count: number
		// There are more matches than `count` (DOCX_FIND_LIMIT).
		readonly capped: boolean
		// Index of the current match, or -1.
		readonly active: number
	}
}

export type DocxCommandGroup = "navigation" | "zoom" | "find"

export interface DocxCommandInfo {
	readonly type: DocxViewerCommandType
	// A stable id an app maps to its own translation.
	readonly labelKey: string
	// A neutral icon id an app maps to its own icon set; absent for commands without one.
	readonly icon?: string
	// Platform-neutral shortcut ("mod" = Cmd on Apple platforms, Ctrl elsewhere).
	readonly shortcut?: string
	readonly group: DocxCommandGroup
}

export const DOCX_VIEWER_COMMANDS: readonly DocxCommandInfo[] = [
	{ type: "page.previous", labelKey: "docx.page.previous", icon: "chevron-left", group: "navigation" },
	{ type: "page.next", labelKey: "docx.page.next", icon: "chevron-right", group: "navigation" },
	{ type: "page.goto", labelKey: "docx.page.goto", group: "navigation" },
	{ type: "zoom.out", labelKey: "docx.zoom.out", icon: "zoom-out", shortcut: "mod+-", group: "zoom" },
	{ type: "zoom.in", labelKey: "docx.zoom.in", icon: "zoom-in", shortcut: "mod+=", group: "zoom" },
	{ type: "zoom.set", labelKey: "docx.zoom.set", group: "zoom" },
	{ type: "zoom.by", labelKey: "docx.zoom.by", group: "zoom" },
	{ type: "zoom.fitWidth", labelKey: "docx.zoom.fitWidth", icon: "fit-width", group: "zoom" },
	{ type: "find.open", labelKey: "docx.find.open", icon: "search", shortcut: "mod+f", group: "find" },
	{ type: "find.close", labelKey: "docx.find.close", icon: "close", shortcut: "escape", group: "find" },
	{ type: "find.query", labelKey: "docx.find.query", group: "find" },
	{ type: "find.next", labelKey: "docx.find.next", icon: "chevron-down", shortcut: "enter", group: "find" },
	{ type: "find.previous", labelKey: "docx.find.previous", icon: "chevron-up", shortcut: "shift+enter", group: "find" }
]

export function clampZoom(zoom: number): number {
	return Number.isFinite(zoom) ? Math.min(DOCX_MAX_ZOOM, Math.max(DOCX_MIN_ZOOM, zoom)) : 1
}

// The zoom that fits `pageWidth` (px at 100 %) into `viewportWidth` with `gutter` px on each side, never
// above 100 % unless `upscale`.
export function fitWidthZoom(viewportWidth: number, pageWidth: number, gutter: number, upscale = false): number {
	if (!(viewportWidth > 0 && pageWidth > 0)) return 1

	const zoom = (viewportWidth - 2 * gutter) / pageWidth

	return clampZoom(upscale ? zoom : Math.min(1, zoom))
}

// Whether a step in (or out) changes the zoom: off at the limits.
export function canZoomIn(zoom: number): boolean {
	return zoom < DOCX_MAX_ZOOM - 1e-3
}

export function canZoomOut(zoom: number): boolean {
	return zoom > DOCX_MIN_ZOOM + 1e-3
}

// The next step above (direction 1) or below (-1) the current zoom.
export function stepZoom(zoom: number, direction: 1 | -1): number {
	if (direction > 0) return DOCX_ZOOM_STEPS.find(step => step > zoom + 1e-3) ?? DOCX_MAX_ZOOM

	return [...DOCX_ZOOM_STEPS].reverse().find(step => step < zoom - 1e-3) ?? DOCX_MIN_ZOOM
}

export function isDocxCommandEnabled(state: DocxViewerState, type: DocxViewerCommandType): boolean {
	const ready = state.status === "streaming" || state.status === "ready"

	switch (type) {
		case "page.previous":
			return ready && state.page > 0
		case "page.next":
			return ready && state.page < state.pageCount - 1
		case "page.goto":
			return ready && state.pageCount > 0
		case "zoom.in":
			return canZoomIn(state.zoom)
		case "zoom.out":
			return canZoomOut(state.zoom)
		case "zoom.set":
		case "zoom.by":
			return true
		case "zoom.fitWidth":
			return state.zoomMode !== "fitWidth"
		case "find.open":
		case "find.query":
			return ready && state.capabilities.find
		case "find.close":
			return state.find.open
		case "find.next":
		case "find.previous":
			return state.find.count > 0
	}
}

// Untrusted input (a bridge message) to a command, or undefined.
export function parseDocxViewerCommand(value: unknown): DocxViewerCommand | undefined {
	if (typeof value !== "object" || value === null) return undefined

	const type: unknown = Reflect.get(value, "type")

	switch (type) {
		case "page.previous":
		case "page.next":
		case "zoom.in":
		case "zoom.out":
		case "zoom.fitWidth":
		case "find.open":
		case "find.close":
		case "find.next":
		case "find.previous":
			return { type }
		case "page.goto": {
			const page: unknown = Reflect.get(value, "page")

			return typeof page === "number" && Number.isInteger(page) && page >= 0 ? { type, page } : undefined
		}
		case "zoom.set": {
			const zoom: unknown = Reflect.get(value, "zoom")

			return typeof zoom === "number" && Number.isFinite(zoom) ? { type, zoom: clampZoom(zoom) } : undefined
		}
		case "zoom.by": {
			const delta: unknown = Reflect.get(value, "delta")

			return typeof delta === "number" && Number.isFinite(delta)
				? { type, delta: Math.max(-DOCX_MAX_ZOOM, Math.min(DOCX_MAX_ZOOM, delta)) }
				: undefined
		}
		case "find.query": {
			const query: unknown = Reflect.get(value, "query")
			const caseSensitive: unknown = Reflect.get(value, "caseSensitive")
			const wholeWord: unknown = Reflect.get(value, "wholeWord")

			return typeof query === "string" && query.length <= 1000
				? {
						type,
						query,
						...(typeof caseSensitive === "boolean" ? { caseSensitive } : {}),
						...(typeof wholeWord === "boolean" ? { wholeWord } : {})
					}
				: undefined
		}
		default:
			return undefined
	}
}
