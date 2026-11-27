import * as Comlink from "comlink"
import type { AnyFile } from "@filen/sdk-rs"
import { holdWorkerAlive, registerWithSw, sendToSw } from "@/features/drive/lib/saveDownload"
import { sdkApi } from "@/lib/sdk/client"
import { originSize, type ByteOrigin, type OriginAccess } from "@/lib/sdk/byteOrigin"
import { controllerIsCurrent } from "@/lib/sw/register"
import {
	SW_DOWNLOAD_PREFIX,
	SW_MSG_PREVIEW_DELIVERED,
	SW_MSG_PREVIEW_HEAD,
	SW_MSG_PREVIEW_STATUS,
	SW_MSG_REGISTER_PORT_PREVIEW,
	SW_MSG_REGISTER_PREVIEW,
	SW_MSG_RELEASE_PREVIEW,
	SW_MSG_STREAM_GONE,
	SW_PREVIEW_BUCKET_PLAYER,
	SW_PREVIEW_BUCKET_TRANSIENT,
	type PreviewStreamStatus
} from "@/lib/sw/protocol"

// Registers `file` against the SW's inline-preview route (no attachment disposition, an allowlisted
// Content-Type, Range/206-capable) and returns its fetchable, same-origin URL — the src a
// <video>/<audio>/<img> element streams+seeks against directly. Rides saveDownload.ts's shared
// registration seam (session handoff + restart healing), minus the FSA branch and the plain-navigation
// trigger: an inline media element just needs a stable URL, it never "saves" anything.
//
// Passing an earlier `id` re-registers it (the worker may have been restarted or evicted it since),
// so a revisit gets back the same URL rather than a new one. A video or audio element's registration goes
// in the worker's player bucket, which downloads cannot crowd out; `transient` marks a short-lived use (a
// thumbnail's one frame), kept apart so it can never evict a player's either.
//
// `access: "anon"` is a public link's file, which only the SDK worker's unauthenticated client can read: that
// worker serves its ranges on a port (openLinkedRangePortAnon) and the port goes to the service worker,
// which answers the same route by reading through it. The file handle and its key stay in the SDK worker.
// It rejects at once, before any SDK work, when the controlling worker is older than this page's protocol
// (or nothing controls the page), so the caller falls back to MediaSource without waiting on it. A
// registration that a newer one of the same id overtakes resolves with that one; one released while still
// on its way rejects with an AbortError.
export async function previewStreamUrl(
	file: AnyFile,
	name: string,
	contentType: string,
	id: string = crypto.randomUUID(),
	options: { transient?: boolean; access?: PreviewAccess } = {}
): Promise<string> {
	const bucket = previewBucket(contentType, options.transient === true)

	expectDelivery(id)

	if (options.access === "anon") {
		const token = crypto.randomUUID()
		const meta = { name, size: Number(file.size), contentType, ...bucket }

		await registerPortPreview(
			id,
			async port => {
				await sdkApi.openLinkedRangePortAnon(Comlink.transfer(port, [port]), file, token)

				return meta
			},
			() => {
				void sdkApi.cancelPreviewDownload(token)
			}
		)
	} else {
		await registerWithSw(SW_MSG_REGISTER_PREVIEW, {
			id,
			file,
			name,
			size: Number(file.size),
			contentType,
			...bucket
		})
	}

	return `${SW_DOWNLOAD_PREFIX}${id}`
}

// What a port-backed registration is served as.
export interface PortStreamMeta {
	name: string
	size: number
	contentType: string
	// False for bytes the serving side makes as they are read (decoded audio): the service worker reads no
	// window ahead of the one its consumer asks for.
	readAhead?: boolean
}

// Registers a stream whose bytes come from a range port the page has served (lib/media/rangePort.ts) under
// `id` and returns its URL: `open` serves the port it is handed and says what it serves, `cancel` stops
// serving it (on release, or when the id registers again). Same contract as a public link's previewStreamUrl,
// which is one of these.
export async function registerPortStream(
	id: string,
	open: (port: MessagePort) => Promise<PortStreamMeta>,
	cancel: () => void
): Promise<string> {
	expectDelivery(id)
	await registerPortPreview(
		id,
		async port => {
			const meta = await open(port)

			return { ...meta, ...previewBucket(meta.contentType, false) }
		},
		cancel
	)

	return `${SW_DOWNLOAD_PREFIX}${id}`
}

// previewStreamUrl for an origin the SDK worker reads by range that is no file of the drive (an archive's entry): the
// worker serves its ranges on a port the service worker reads through, and no JS buffer holds the bytes.
export function previewOriginStreamUrl(
	origin: ByteOrigin,
	access: OriginAccess,
	name: string,
	contentType: string,
	id: string
): Promise<string> {
	const token = crypto.randomUUID()

	return registerPortStream(
		id,
		async port => {
			await sdkApi.openOriginRangePort(Comlink.transfer(port, [port]), origin, access, token)

			return { name, size: originSize(origin), contentType }
		},
		() => {
			void sdkApi.cancelPreviewDownload(token)
		}
	)
}

// Which SDK client reads the file: the session's, or the unauthenticated one for a public link's.
export type PreviewAccess = "authed" | "anon"

// The page's side of each port-backed registration: how to stop serving its port (on release, or when the id
// registers again), its generation, the worker it went to, and its outcome.
interface PortRegistration {
	cancel: () => void
	generation: number
	target: ServiceWorker
	done: Promise<undefined>
}

const portRegistrations = new Map<string, PortRegistration>()
// Ids are this page's own, so a page-wide counter orders every registration of one id.
let lastGeneration = 0

function cancelPortRegistration(id: string): PortRegistration | undefined {
	const registration = portRegistrations.get(id)

	if (registration !== undefined) {
		portRegistrations.delete(id)
		registration.cancel()
	}

	return registration
}

async function registerPortPreview(
	id: string,
	open: (port: MessagePort) => Promise<PortStreamMeta & { bucket?: string }>,
	cancel: () => void
): Promise<void> {
	const current = await controllerIsCurrent()
	// The worker the URL is fetched through.
	const target = "serviceWorker" in navigator ? navigator.serviceWorker.controller : null

	if (!current || target === null) {
		throw new Error("the service worker cannot serve this preview")
	}

	const outcome = Promise.withResolvers<undefined>()
	const registration: PortRegistration = { cancel, generation: ++lastGeneration, target, done: outcome.promise }
	const { port1, port2 } = new MessageChannel()

	// Only ever awaited through a registration that this one overtook.
	outcome.promise.catch(() => undefined)
	cancelPortRegistration(id)
	portRegistrations.set(id, registration)

	let failure: Error | null = null

	try {
		const meta = await open(port1)

		// Released or overtaken meanwhile, which cancelled it: the worker would only refuse it.
		if (portRegistrations.get(id) === registration) {
			await sendToSw(target, SW_MSG_REGISTER_PORT_PREVIEW, { id, ...meta, generation: registration.generation, port: port2 }, [port2])
		} else {
			port2.close()
		}
	} catch (e) {
		failure = e instanceof Error ? e : new Error(String(e))
		cancel()
		port2.close()
	}

	const latest = portRegistrations.get(id)

	// Overtaken by a newer registration of the id: the URL is that one's now.
	if (latest !== undefined && latest !== registration) {
		outcome.resolve(latest.done)
		await latest.done

		return
	}

	if (latest === undefined) {
		failure = new DOMException("the preview was released while it registered", "AbortError")
	} else if (failure !== null) {
		portRegistrations.delete(id)
	}

	if (failure !== null) {
		outcome.reject(failure)

		throw failure
	}

	outcome.resolve(undefined)
}

function previewBucket(contentType: string, transient: boolean): { bucket?: string } {
	if (transient) {
		return { bucket: SW_PREVIEW_BUCKET_TRANSIENT }
	}

	return /^(video|audio)\//i.test(contentType) ? { bucket: SW_PREVIEW_BUCKET_PLAYER } : {}
}

// Keeps the controlling worker from being terminated while a player is mounted, paused included: an idle
// worker loses its registrations, and a paused element's next range request would then fail. Returns the
// idempotent release; a no-op where there are no service workers.
export function holdPreviewStreamAlive(): () => void {
	return "serviceWorker" in navigator ? holdWorkerAlive(navigator.serviceWorker.controller) : () => undefined
}

// Hands a registration back once its element is done with the URL (emptied, so no further Range request
// comes), so the worker drops the entry and its key material at once. Fire-and-forget and idempotent: a
// worker that has restarted since holds nothing to drop, an older one ignores the message, and a second call
// finds nothing left. A port-backed registration is released whole: the worker's entry (which closes its
// port once no response reads from it), and the serving side through its cancel (a public link's SDK worker
// token, which shuts the port down from there and frees its UnauthClient even if the message never lands);
// both sides' Web Locks go with the port. A registration still on its way is refused when it lands.
export function releasePreviewStream(id: string): void {
	const controller = "serviceWorker" in navigator ? navigator.serviceWorker.controller : null
	const registration = cancelPortRegistration(id)
	const message =
		registration === undefined
			? { type: SW_MSG_RELEASE_PREVIEW, id }
			: { type: SW_MSG_RELEASE_PREVIEW, id, generation: registration.generation }

	controller?.postMessage(message)

	// The worker it registered with, should it no longer be the controller.
	if (registration !== undefined && registration.target !== controller) {
		registration.target.postMessage(message)
	}
}

// Holders per registration id: one id is shared by every viewer of a file in a scope (previewCache.ts), so
// two cards of the same file play from one registration.
const holders = new Map<string, number>()
const pendingReleases = new Map<string, ReturnType<typeof setTimeout>>()

// A viewer starts using `id` (before registering it): its registration stays until the last holder lets go.
export function holdPreviewStream(id: string): void {
	clearTimeout(pendingReleases.get(id))
	pendingReleases.delete(id)
	holders.set(id, (holders.get(id) ?? 0) + 1)
}

// A holder lets go of `id`. The last one releases it (releasePreviewStream) once the current task is done,
// unless `id` is held again first: a strict-mode re-run or a remount that reuses the id keeps the stream its
// element is reading. An id nobody held is released the same way.
export function releasePreviewStreamSoon(id: string): void {
	const remaining = (holders.get(id) ?? 1) - 1

	if (remaining > 0) {
		holders.set(id, remaining)

		return
	}

	holders.delete(id)
	clearTimeout(pendingReleases.get(id))
	pendingReleases.set(
		id,
		setTimeout(() => {
			pendingReleases.delete(id)
			releasePreviewStream(id)
		}, 0)
	)
}

// The registration id of a preview stream URL.
export function previewStreamIdOf(url: string): string {
	return url.slice(url.lastIndexOf("/") + 1)
}

// How long an answer to a status query may take; a worker that does not know the message never answers.
const STATUS_TIMEOUT_MS = 3_000

// Whether the controlling worker can still serve preview `id`, from its registry alone: no range request, no
// SDK read, no network (SW_MSG_PREVIEW_STATUS). "present": it can; "lost": it holds the registration but its
// read path is gone; "missing": it holds none, or nothing controls the page; "unknown": the controller is
// older than this page's protocol (after a deploy, until the update is applied) and cannot be asked, which
// says nothing against a stream it keeps serving.
export async function previewStreamStatus(id: string): Promise<PreviewStreamStatus> {
	const controller = "serviceWorker" in navigator ? navigator.serviceWorker.controller : null

	if (controller === null) {
		return "missing"
	}

	if (!(await controllerIsCurrent())) {
		return "unknown"
	}

	return await new Promise<PreviewStreamStatus>(resolve => {
		const channel = new MessageChannel()
		const settle = (status: PreviewStreamStatus) => {
			clearTimeout(timeout)
			channel.port1.close()
			resolve(status)
		}
		const timeout = setTimeout(() => {
			settle("missing")
		}, STATUS_TIMEOUT_MS)

		channel.port1.onmessage = (event: MessageEvent<{ status?: unknown } | null>) => {
			const status = event.data?.status

			settle(status === "present" || status === "lost" ? status : "missing")
		}
		controller.postMessage({ type: SW_MSG_PREVIEW_STATUS, id }, [channel.port2])
	})
}

// Capability gate: true once a service worker is actually controlling this tab — registered in every
// mode now (dev serves the worker's source module, see lib/sw/register.ts), so this is true once boot
// has claimed the page and false only before that. This is the single flip point every
// streamed viewer branches on before ever calling previewStreamUrl — if inline streaming ever proves
// unreliable in a real browser, forcing this false alone reroutes every viewer to the buffered blob
// fallback, no other call site needs to change.
export function isMediaStreamAvailable(): boolean {
	return "serviceWorker" in navigator && navigator.serviceWorker.controller !== null
}

// How long to let a registered-but-unclaimed worker finish taking control. A page is uncontrolled for
// a moment after every install and update, so this is the ordinary first-load state, not an error.
const SW_CONTROL_TIMEOUT_MS = 5_000

// The awaitable form of the gate above, for callers that would otherwise treat "not yet" as "no".
// Returns immediately in both settled cases: true when a worker already controls the tab, false when
// none is REGISTERED at all, so a browser without one pays nothing rather than burning the timeout on
// every item its caller looks at. Only the genuinely transient case waits.
export async function waitForMediaStream(timeoutMs: number = SW_CONTROL_TIMEOUT_MS): Promise<boolean> {
	if (isMediaStreamAvailable()) {
		return true
	}

	if (!("serviceWorker" in navigator)) {
		return false
	}

	const registration = await navigator.serviceWorker.getRegistration().catch(() => undefined)

	if (registration === undefined) {
		return false
	}

	return await new Promise<boolean>(resolve => {
		function settle(value: boolean): void {
			clearTimeout(timer)
			navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange)
			resolve(value)
		}

		function onControllerChange(): void {
			if (navigator.serviceWorker.controller !== null) {
				settle(true)
			}
		}

		const timer = setTimeout(() => {
			settle(false)
		}, timeoutMs)

		navigator.serviceWorker.addEventListener("controllerchange", onControllerChange)

		// Re-checked after the listener is attached: control can land in the gap between the early
		// return above and this subscription, and controllerchange does not replay.
		onControllerChange()
	})
}

// Calls `listener` once a service worker takes control of the page, however long after the page loaded (a first visit
// whose worker claims it late: Firefox cannot finish clients.claim while the SDK's wasm threads block). Returns the
// unsubscribe; a no-op where there are no service workers.
export function onMediaStreamAvailable(listener: () => void): () => void {
	if (!("serviceWorker" in navigator)) {
		return () => undefined
	}

	const container = navigator.serviceWorker
	const handle = (): void => {
		if (container.controller !== null) {
			listener()
		}
	}

	container.addEventListener("controllerchange", handle)

	return () => {
		container.removeEventListener("controllerchange", handle)
	}
}

// Calls `listener` whenever the controlling service worker answers a range request for preview `id` with
// 404 (SW_MSG_STREAM_GONE): the element's stream is gone, whether or not the browser says so. Returns the
// unsubscribe; a no-op where there are no service workers.
export function onPreviewStreamGone(id: string, listener: () => void): () => void {
	if (!("serviceWorker" in navigator)) {
		return () => undefined
	}

	const container = navigator.serviceWorker
	const handle = (event: MessageEvent): void => {
		const data: unknown = event.data

		if (
			typeof data === "object" &&
			data !== null &&
			"type" in data &&
			data.type === SW_MSG_STREAM_GONE &&
			"id" in data &&
			data.id === id
		) {
			listener()
		}
	}

	container.addEventListener("message", handle)

	return () => {
		container.removeEventListener("message", handle)
	}
}

// Ids whose inline response reached the file's last byte (SW_MSG_PREVIEW_DELIVERED), oldest first. Bounded: only the
// previews on screen are ever asked about.
const delivered = new Set<string>()
const MAX_DELIVERED = 64
const deliveryWaiters = new Map<string, Set<() => void>>()
let hearingDeliveries = false

function markDelivered(id: string): void {
	delivered.delete(id)
	delivered.add(id)

	if (delivered.size > MAX_DELIVERED) {
		const oldest = delivered.values().next().value

		if (oldest !== undefined) {
			delivered.delete(oldest)
		}
	}

	for (const waiter of deliveryWaiters.get(id) ?? []) {
		waiter()
	}
}

// A (re)registration of `id` starts its stream over: only a delivery after it counts. Listens from the first one on,
// so an acknowledgement that lands before anything asks is kept.
function expectDelivery(id: string): void {
	delivered.delete(id)

	if (hearingDeliveries || !("serviceWorker" in navigator)) {
		return
	}

	hearingDeliveries = true
	navigator.serviceWorker.addEventListener("message", (event: MessageEvent) => {
		const data: unknown = event.data

		if (
			typeof data === "object" &&
			data !== null &&
			"type" in data &&
			data.type === SW_MSG_PREVIEW_DELIVERED &&
			"id" in data &&
			typeof data.id === "string"
		) {
			markDelivered(data.id)
		} else if (
			typeof data === "object" &&
			data !== null &&
			"type" in data &&
			data.type === SW_MSG_PREVIEW_HEAD &&
			"id" in data &&
			typeof data.id === "string" &&
			"bytes" in data &&
			data.bytes instanceof Uint8Array
		) {
			keepHead(data.id, data.bytes)
		}
	})
}

// Heads the worker posted (SW_MSG_PREVIEW_HEAD) that nothing has asked for yet, oldest first: bounded, a head is up to
// SW_PREVIEW_HEAD_BYTES.
const heads = new Map<string, Uint8Array>()
const MAX_HEADS = 4
const headWaiters = new Map<string, Set<(head: Uint8Array) => void>>()

function keepHead(id: string, head: Uint8Array): void {
	const waiters = headWaiters.get(id)

	if (waiters !== undefined) {
		headWaiters.delete(id)

		for (const waiter of waiters) {
			waiter(head)
		}

		return
	}

	heads.delete(id)
	heads.set(id, head)

	if (heads.size > MAX_HEADS) {
		const oldest = heads.keys().next().value

		if (oldest !== undefined) {
			heads.delete(oldest)
		}
	}
}

// The head of preview `id`'s next inline response from byte 0 (or of one that already passed and nothing took), as the
// worker read it for that response: no read of its own. Only a type previewHeadPosted names has one. Null once
// `signal` aborts.
export function previewStreamHead(id: string, signal: AbortSignal): Promise<Uint8Array | null> {
	const kept = heads.get(id)

	if (kept !== undefined) {
		heads.delete(id)

		return Promise.resolve(kept)
	}

	if (signal.aborted) {
		return Promise.resolve(null)
	}

	return new Promise(resolve => {
		const waiters = headWaiters.get(id) ?? new Set<(head: Uint8Array) => void>()
		const aborted = () => {
			waiters.delete(arrived)

			if (waiters.size === 0 && headWaiters.get(id) === waiters) {
				headWaiters.delete(id)
			}

			resolve(null)
		}
		const arrived = (head: Uint8Array) => {
			signal.removeEventListener("abort", aborted)
			resolve(head)
		}

		waiters.add(arrived)
		headWaiters.set(id, waiters)
		signal.addEventListener("abort", aborted, { once: true })
	})
}

// Whether the worker has acknowledged that preview `id`'s response reached the file's last byte, waiting up to
// `graceMs` for an acknowledgement still on its way (it may land just after the element's own error event). A
// controller older than SW_MSG_PREVIEW_DELIVERED never sends one, so it reads as undelivered.
export function previewDelivered(id: string, graceMs: number): Promise<boolean> {
	if (delivered.has(id)) {
		return Promise.resolve(true)
	}

	return new Promise(resolve => {
		const waiters = deliveryWaiters.get(id) ?? new Set<() => void>()
		const settle = (value: boolean) => {
			clearTimeout(timer)
			waiters.delete(arrived)

			if (waiters.size === 0) {
				deliveryWaiters.delete(id)
			}

			resolve(value)
		}
		const arrived = () => {
			settle(true)
		}
		const timer = setTimeout(() => {
			settle(false)
		}, graceMs)

		waiters.add(arrived)
		deliveryWaiters.set(id, waiters)
	})
}

// How long an image's error waits for its delivery acknowledgement, which may land just after it; and how much longer
// while the worker still serves the registration, so its response may still be finishing (a background tab or a busy
// worker posts late).
const DELIVERY_GRACE_MS = 1_000
const DELIVERY_FINISH_GRACE_MS = 10_000

// Whether preview `id`'s response reached the file's last byte, for an element that just failed on it: true once
// acknowledged; false at once when the worker no longer serves the registration (the stream broke), else after the
// longer grace.
export async function previewDeliveredAfterError(id: string): Promise<boolean> {
	if (await previewDelivered(id, DELIVERY_GRACE_MS)) {
		return true
	}

	if ((await previewStreamStatus(id)) !== "present") {
		return delivered.has(id)
	}

	return await previewDelivered(id, DELIVERY_FINISH_GRACE_MS)
}
