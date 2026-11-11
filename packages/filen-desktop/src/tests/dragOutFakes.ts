import { vi } from "vitest"
import type {
	DesktopDownloadItem,
	DesktopDragImage,
	DesktopDragState,
	DesktopTransferResult,
	DesktopTransferStart
} from "@filen/shared/desktop"
import type { DragOutAddonMac } from "../main/dragOut/addon.ts"
import type { DragOutAddonWin, DragOutBeginWin } from "../main/dragOut/addonWin.ts"
import { createDragOutService, type DragIcon, type DragOutNative, type DragWindow } from "../main/dragOut/service.ts"
import { DragSessions } from "../main/dragOut/session.ts"
import type { DragTemp } from "../main/dragOut/temp.ts"
import type { Page } from "../main/pages.ts"
import type { DownloadWatch } from "../main/transfers/service.ts"
import type { NativeTreeEntry } from "../shared/nativeProtocol.ts"

// A drag-out service over real sessions, with fake transfers, temp, addons and windows.

export function dragItem(name: string, kind: "file" | "directory" = "file", size = 10): DesktopDownloadItem {
	return { kind, ref: { variant: kind === "file" ? "AnyFile.File" : "AnyNormalDir.Dir", value: `{"name":"${name}"}` }, name, size }
}

export function treeFile(segments: string[], listIndex: number | null, source = 0): NativeTreeEntry {
	return { segments, directory: false, size: 10, mtimeMs: null, listIndex, source }
}

export function treeDir(segments: string[], source = 0): NativeTreeEntry {
	return { segments, directory: true, size: 0, mtimeMs: null, listIndex: null, source }
}

// The first 24 bytes of a PNG of `width` × `height` pixels: what the size checks read.
export function pngOf(width: number, height: number): Uint8Array {
	const bytes = new Uint8Array(33)
	const view = new DataView(bytes.buffer)

	bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
	view.setUint32(16, width)
	view.setUint32(20, height)

	return bytes
}

export function dragImage(width = 100, height = 20, scale = 2): DesktopDragImage {
	return { png: pngOf(width * scale, height * scale), width, height, scale }
}

export const flush = async () => {
	for (let i = 0; i < 10; i++) {
		await Promise.resolve()
	}
}

export interface StartedDownload {
	id: string
	path: string
	watch: DownloadWatch
}

export interface FakeIcon extends DragIcon {
	scale: number
}

export function dragFakes(
	mode: DragOutNative["mode"],
	options: {
		tree?: NativeTreeEntry[]
		user?: string | null
		macAddon?: DragOutAddonMac | null
		winLoader?: () => DragOutAddonWin | null
	} = {}
) {
	const platform = mode === "promise" ? "darwin" : mode === "virtual" ? "win32" : "linux"
	const started: StartedDownload[] = []
	const cancelled: string[] = []
	const released: string[] = []
	const warnings: string[] = []
	const timers = new Map<number, { run: () => void; at: number }>()
	let clock = 0
	let nextTimer = 0
	let nextTransfer = 0
	const start = (path: string, watch: DownloadWatch | undefined): DesktopTransferResult<DesktopTransferStart> => {
		const id = `t${String(nextTransfer++)}`

		started.push({ id, path, watch: watch ?? { onSettled: () => undefined } })

		return { ok: true, value: { status: "started", ids: [id] } }
	}
	const temp: DragTemp = {
		sessionDir: id => Promise.resolve(`/temp/s-${id}`),
		makeDirectories: () => Promise.resolve(),
		deleteLater: () => undefined,
		deleteNow: () => Promise.resolve(),
		sweep: () => Promise.resolve(),
		removeAll: vi.fn(() => Promise.resolve()),
		removeAllSync: () => undefined
	}
	const mac = {
		begins: [] as Parameters<DragOutAddonMac["begin"]>[0][],
		fulfilled: [] as [number, string | null][],
		progressAt: [] as [number, string][],
		progress: [] as [number, number, number][],
		beginError: null as { code: string } | null
	}
	const macAddon: DragOutAddonMac = {
		begin: begin => {
			if (mac.beginError !== null) {
				throw Object.assign(new Error(mac.beginError.code), mac.beginError)
			}

			mac.begins.push(begin)
		},
		progressAt: (ticket, path) => mac.progressAt.push([ticket, path]),
		progress: (ticket, completed, total) => mac.progress.push([ticket, completed, total]),
		fulfil: (ticket, error) => mac.fulfilled.push([ticket, error])
	}
	const win = {
		begins: [] as DragOutBeginWin[],
		completed: [] as [number, string][],
		failed: [] as number[],
		aborted: 0,
		// What DoDragDrop does while it blocks; its answer is begin's.
		during: (() => "dropped") as (begin: DragOutBeginWin) => "dropped" | "cancelled" | "failed"
	}
	const winAddon: DragOutAddonWin = {
		begin: begin => {
			win.begins.push(begin)

			return win.during(begin)
		},
		complete: (ticket, path) => win.completed.push([ticket, path]),
		fail: ticket => win.failed.push(ticket),
		abort: () => {
			win.aborted++
		}
	}
	const drags: { owner: number; files: string[]; icon: FakeIcon }[] = []
	const focused = new Set([1, 2])
	const windows = {
		focused: (owner: number): DragWindow<FakeIcon> | null =>
			focused.has(owner)
				? {
						handle: () => Buffer.alloc(8, owner),
						startDrag: (files, icon) => {
							drags.push({ owner, files, icon })
							startDrag(owner)
						}
					}
				: null
	}
	let startDrag: (owner: number) => void = () => undefined
	const native: DragOutNative =
		mode === "promise"
			? { mode, addon: () => (options.macAddon === undefined ? macAddon : options.macAddon) }
			: mode === "virtual"
				? { mode, addon: options.winLoader ?? (() => winAddon) }
				: { mode }
	const sessions = new DragSessions(
		{
			transfers: {
				startDownload: request =>
					Promise.resolve(start(request.destination.kind === "exact" ? request.destination.path : "", request.watch)),
				startListedDownload: request => {
					const ids = request.entries.map(entry => {
						const result = start(entry.path, request.watch)

						return result.ok && result.value.status === "started" ? (result.value.ids[0] ?? "") : ""
					})

					return Promise.resolve({ ok: true, value: { status: "started", ids } })
				},
				listTree: () => Promise.resolve({ ok: true, value: { entries: options.tree ?? [] } }),
				releaseTree: listingId => {
					released.push(listingId)
				},
				cancel: ids => {
					cancelled.push(...ids)
				}
			},
			temp,
			emit: (state, owner) => {
				service.emit(state, owner)
			},
			now: () => clock,
			setTimer: (run, ms) => {
				const id = nextTimer++

				timers.set(id, { run, at: clock + ms })

				return () => {
					timers.delete(id)
				}
			}
		},
		platform,
		mode
	)
	const icons = { empty: false }
	const service = createDragOutService<FakeIcon>({
		sessions,
		temp,
		native,
		user: () => Promise.resolve(options.user === undefined ? "user" : options.user),
		windows,
		decodeIcon: (png, scale) => ({
			scale,
			isEmpty: () => icons.empty,
			toBitmap: () => {
				const pixels = new DataView(png.buffer, png.byteOffset, png.byteLength)

				return Buffer.alloc(pixels.getUint32(16) * pixels.getUint32(20) * 4)
			}
		}),
		log: {
			warn: message => {
				warnings.push(message)
			}
		}
	})
	const page = (id: number): Page & { states: DesktopDragState[] } => {
		const states: DesktopDragState[] = []

		return {
			id,
			states,
			send: (_channel, payload) => {
				states.push(payload as DesktopDragState)
			}
		}
	}
	const advance = (ms: number) => {
		clock += ms

		for (const [id, timer] of [...timers]) {
			if (timer.at <= clock) {
				timers.delete(id)
				timer.run()
			}
		}
	}
	const settle = (download: StartedDownload | undefined, outcome: "done" | "error" = "done") => {
		if (download === undefined) {
			throw new Error("no such download")
		}

		download.watch.onSettled({ id: download.id, outcome, path: download.path })
	}

	return {
		service,
		sessions,
		temp,
		mac,
		win,
		drags,
		focused,
		icons,
		started,
		cancelled,
		released,
		warnings,
		page,
		advance,
		settle,
		onStartDrag: (run: (owner: number) => void) => {
			startDrag = run
		}
	}
}

export async function preparedId(prepared: ReturnType<ReturnType<typeof dragFakes>["service"]["prepare"]>): Promise<string> {
	const answer = await prepared

	if (!("id" in answer)) {
		throw new Error(`refused: ${answer.refused.reason}`)
	}

	return answer.id
}
