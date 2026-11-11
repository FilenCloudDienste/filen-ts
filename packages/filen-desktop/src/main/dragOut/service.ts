import path from "node:path"
import type {
	DesktopDownloadItem,
	DesktopDragImage,
	DesktopDragOutcome,
	DesktopDragPrepared,
	DesktopDragState
} from "@filen/shared/desktop"
import { CHANNELS } from "../../shared/channels.ts"
import type { Page } from "../pages.ts"
import type { DragOutAddonMac } from "./addon.ts"
import type { DragOutAddonWin } from "./addonWin.ts"
import { pngPixels } from "./image.ts"
import type { DragPayload, DragSessions } from "./session.ts"
import type { DragTemp } from "./temp.ts"

// Main's drag-out: the page prepares a session once its drag leaves the window, then begins the OS drag, which runs
// through the platform's native path. macOS hands Finder file promises (filen-mac.node) and answers each write Finder
// asks for; Windows offers Explorer virtual files (filen-drag.node), whose DoDragDrop blocks main's JS until the drop,
// so nothing here may be needed before it returns; Linux drags the staged copies with webContents.startDrag. One
// native drag at a time: Linux's nested loop and macOS's drag tracking can re-enter IPC.

// The native side per platform. The addon getters load on first use; Windows' throws when its file does not load.
export type DragOutNative =
	{ mode: "promise"; addon(): DragOutAddonMac | null } | { mode: "virtual"; addon(): DragOutAddonWin | null } | { mode: "staged" }

// The part of an Electron NativeImage the drag reads.
export interface DragIcon {
	isEmpty(): boolean
	toBitmap(options: { scaleFactor: number }): Buffer
}

// The window a page's drag starts from.
export interface DragWindow<Icon extends DragIcon> {
	// getNativeWindowHandle(): the NSView (macOS) or HWND (Windows).
	handle(): Buffer
	// webContents.startDrag: returns after the drop or cancel without saying which.
	startDrag(files: string[], icon: Icon): void
}

export interface DragOutDeps<Icon extends DragIcon> {
	sessions: DragSessions
	temp: DragTemp
	native: DragOutNative
	// The signed-in user's id; null when signed out.
	user(): Promise<string | null>
	// The page's window when it has the focus; a drag begins only from there.
	windows: { focused(owner: number): DragWindow<Icon> | null }
	// nativeImage.createFromBuffer(png, { scaleFactor }).
	decodeIcon(png: Buffer, scaleFactor: number): Icon
	log: { warn(message: string): void }
}

export interface DragOutService {
	prepare(page: Page, items: readonly DesktopDownloadItem[]): Promise<DesktopDragPrepared>
	begin(page: Page, id: string, image: DesktopDragImage): Promise<DesktopDragOutcome>
	release(page: Page, id: string): void
	subscribe(page: Page, on: boolean): void
	// The sessions' emit: a state goes to its owner page only, and the latest live one is replayed to it on subscribe.
	emit(state: DesktopDragState, owner: number): void
	// The page was destroyed, crashed or navigated away.
	pageGone(owner: number): void
	// Sessions holding listings, tickets or downloads (the host's demand).
	live(): number
	nativeDragRunning(): boolean
	// Resolves once no native drag runs.
	idle(): Promise<void>
	// Quit, before the host stops: every session ends, every waiting Finder write and Explorer read fails.
	quit(): void
	// Sign-out, before the host stops; the answer removes the temp once it has.
	signedOut(): () => Promise<void>
}

const UNAVAILABLE = { refused: { reason: "unavailable" } } as const satisfies DesktopDragPrepared

// Why the macOS addon's begin threw; a released button means the page's drag ended meanwhile.
function addonCode(error: unknown): string | null {
	return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : null
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

// Finder's URL for promised item `planned`: absolute and normalized, a direct child of the drop's directory, named
// `planned` or Finder's unique form of it ("name 2.ext", "name 2"), which it picks when the name is taken.
export function suppliedPathFits(target: string, planned: string): boolean {
	const name = path.posix.basename(target)

	if (!path.posix.isAbsolute(target) || name.length === 0 || path.posix.join(path.posix.dirname(target), name) !== target) {
		return false
	}

	if (name === planned) {
		return true
	}

	for (const match of name.matchAll(/ (?:[2-9]|[1-9]\d+)(?=\.|$)/g)) {
		if (name.slice(0, match.index) + name.slice(match.index + match[0].length) === planned) {
			return true
		}
	}

	return false
}

export function createDragOutService<Icon extends DragIcon>(deps: DragOutDeps<Icon>): DragOutService {
	const { sessions, native, log } = deps
	const pages = new Map<number, Page>()
	// The latest state of every live id, for a page that subscribes late.
	const latest = new Map<string, { owner: number; state: DesktopDragState }>()
	// The begin running now, settled by its own end or by the session's ended state (quit, the sessions' watchdog).
	let current: { id: string; settle(outcome: DesktopDragOutcome, ended?: boolean): void } | null = null
	let idleWaiters: (() => void)[] = []
	// Windows: a loader that threw stays unavailable; whether the addon was loaded (quit aborts it).
	let winBroken = false
	let winLoaded: DragOutAddonWin | null = null

	function winAddon(): DragOutAddonWin | null {
		if (native.mode !== "virtual" || winBroken) {
			return null
		}

		try {
			winLoaded = native.addon()
		} catch (error) {
			winBroken = true
			log.warn(`dragOut: filen-drag.node did not load: ${message(error)}`)
		}

		return winLoaded
	}

	function available(): boolean {
		switch (native.mode) {
			case "promise":
				return native.addon() !== null
			case "virtual":
				return winAddon() !== null
			case "staged":
				return true
		}
	}

	// Runs once per begin: the session hears the outcome (unless it `ended` already), the page's begin resolves and
	// quit may go on.
	function settler(id: string, resolve: (outcome: DesktopDragOutcome) => void): (outcome: DesktopDragOutcome) => void {
		let settled = false
		const settle = (outcome: DesktopDragOutcome, ended = false) => {
			if (settled) {
				return
			}

			settled = true

			if (current?.id === id) {
				current = null
			}

			if (!ended) {
				sessions.ended(id, outcome)
			}

			resolve(outcome)

			const waiters = idleWaiters

			idleWaiters = []

			for (const waiter of waiters) {
				waiter()
			}
		}

		current = { id, settle }

		return settle
	}

	function beginPromise(
		addon: DragOutAddonMac,
		window: DragWindow<Icon>,
		id: string,
		payload: Extract<DragPayload, { mode: "promise" }>,
		image: DesktopDragImage,
		png: Buffer
	): Promise<DesktopDragOutcome> {
		return new Promise(resolve => {
			const settle = settler(id, resolve)

			try {
				addon.begin({
					view: window.handle(),
					items: payload.items.map(item => ({ name: item.name, directory: item.directory, contentType: null })),
					image: { png, width: image.width, height: image.height },
					onWrite: (ticket, index, target) => {
						const planned = payload.items[index]?.name

						if (planned === undefined || !suppliedPathFits(target, planned)) {
							log.warn(`dragOut: Finder asked for item ${String(index)} at ${target}; refused`)
							addon.fulfil(ticket, "invalidPath")

							return
						}

						sessions.promise(
							id,
							ticket,
							index,
							target,
							(bytes, size) => {
								addon.progress(ticket, bytes, size)
							},
							temp => {
								if (path.posix.isAbsolute(temp)) {
									addon.progressAt(ticket, temp)
								}
							},
							error => {
								addon.fulfil(ticket, error)
							}
						)
					},
					onCancel: ticket => {
						sessions.cancelTicket(id, ticket)
					},
					onEnded: operation => {
						settle(operation === "copy" ? "dropped" : "cancelled")
					}
				})
			} catch (error) {
				const code = addonCode(error)

				if (code !== "buttonReleased") {
					log.warn(`dragOut: Finder drag did not begin: ${code ?? message(error)}`)
				}

				settle(code === "buttonReleased" ? "cancelled" : "failed")
			}
		})
	}

	// Blocks in DoDragDrop. The callbacks queued meanwhile run after it returned and after the session heard the end.
	function beginVirtual(
		addon: DragOutAddonWin,
		window: DragWindow<Icon>,
		id: string,
		payload: Extract<DragPayload, { mode: "virtual" }>,
		bitmap: { bgra: Buffer; width: number; height: number }
	): Promise<DesktopDragOutcome> {
		return new Promise(resolve => {
			const settle = settler(id, resolve)
			let outcome: DesktopDragOutcome = "failed"

			try {
				outcome = addon.begin({
					hwnd: window.handle(),
					entries: payload.entries.map(entry => ({
						path: entry.relativePath,
						directory: entry.directory,
						size: BigInt(entry.size),
						mtimeMs: entry.mtimeMs
					})),
					image: bitmap,
					onContents: (ticket, index) => {
						sessions.contents(id, ticket, index, file => {
							if (file === null) {
								addon.fail(ticket)
							} else {
								addon.complete(ticket, file)
							}
						})
					},
					onRelease: ticket => {
						sessions.streamReleased(id, ticket)
					},
					onOperationEnd: () => {
						sessions.operationEnded(id)
					}
				})
			} catch (error) {
				log.warn(`dragOut: Explorer drag did not begin: ${message(error)}`)
			}

			settle(outcome)
		})
	}

	// startDrag runs a nested loop until the drop or cancel and cannot tell which: the end is "ended".
	function beginStaged(
		window: DragWindow<Icon>,
		id: string,
		payload: Extract<DragPayload, { mode: "staged" }>,
		icon: Icon
	): Promise<DesktopDragOutcome> {
		return new Promise(resolve => {
			const settle = settler(id, resolve)

			try {
				window.startDrag(payload.paths, icon)
				settle("ended")
			} catch (error) {
				log.warn(`dragOut: drag did not begin: ${message(error)}`)
				settle("failed")
			}
		})
	}

	return {
		prepare: async (page, items) => (!available() || (await deps.user()) === null ? UNAVAILABLE : sessions.prepare(page.id, items)),
		begin: (page, id, image) => {
			const window = deps.windows.focused(page.id)

			if (window === null) {
				return Promise.resolve("failed")
			}

			const beginnable = sessions.beginnable(page.id, id)

			if (beginnable !== "ready") {
				return Promise.resolve(beginnable === "notReady" ? "notReady" : "failed")
			}

			const payload = sessions.payload(page.id, id)
			const png = Buffer.from(image.png.buffer, image.png.byteOffset, image.png.byteLength)

			// Everything that can refuse is checked before the session is marked begun.
			switch (payload?.mode) {
				case "promise": {
					const addon = native.mode === "promise" ? native.addon() : null

					if (addon === null || !sessions.markBegun(id)) {
						return Promise.resolve("failed")
					}

					return beginPromise(addon, window, id, payload, image, png)
				}
				case "virtual": {
					const addon = winAddon()
					const pixels = pngPixels(image.png)
					const icon = deps.decodeIcon(png, image.scale)
					const bgra = icon.isEmpty() ? null : icon.toBitmap({ scaleFactor: image.scale })

					if (
						addon === null ||
						pixels === null ||
						bgra?.byteLength !== pixels.width * pixels.height * 4 ||
						!sessions.markBegun(id)
					) {
						return Promise.resolve("failed")
					}

					return beginVirtual(addon, window, id, payload, { bgra, width: pixels.width, height: pixels.height })
				}
				case "staged": {
					const icon = deps.decodeIcon(png, image.scale)

					// startDrag returns silently on an empty icon; no drag would run.
					if (icon.isEmpty() || !sessions.markBegun(id)) {
						return Promise.resolve("failed")
					}

					return beginStaged(window, id, payload, icon)
				}
				case undefined:
					return Promise.resolve("failed")
			}
		},
		release: (page, id) => {
			sessions.release(page.id, id)
		},
		subscribe: (page, on) => {
			if (!on) {
				pages.delete(page.id)

				return
			}

			pages.set(page.id, page)

			for (const entry of latest.values()) {
				if (entry.owner === page.id) {
					page.send(CHANNELS.dragState, entry.state)
				}
			}
		},
		emit: (state, owner) => {
			if (state.state === "ended") {
				latest.delete(state.id)

				// Quit, sign-out or the watchdog ended the drag that runs now.
				if (current?.id === state.id) {
					current.settle(state.outcome, true)
				}
			} else {
				latest.set(state.id, { owner, state })
			}

			pages.get(owner)?.send(CHANNELS.dragState, state)
		},
		pageGone: owner => {
			pages.delete(owner)
			sessions.ownerGone(owner)

			for (const [id, entry] of latest) {
				if (entry.owner === owner) {
					latest.delete(id)
				}
			}
		},
		live: () => sessions.live(),
		nativeDragRunning: () => sessions.nativeDragRunning(),
		idle: () =>
			current === null
				? Promise.resolve()
				: new Promise(resolve => {
						idleWaiters.push(resolve)
					}),
		// The running drag's session ends with the others; its ended state settles the begin.
		quit: () => {
			sessions.abortAll("quit")
			current?.settle("cancelled", true)
			winLoaded?.abort()
		},
		signedOut: () => {
			sessions.abortAll("signedOut")
			current?.settle("cancelled", true)

			return () => deps.temp.removeAll()
		}
	}
}
