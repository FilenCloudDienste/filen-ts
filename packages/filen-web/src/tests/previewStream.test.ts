import { afterEach, describe, expect, it, vi } from "vitest"
import type { AnyFile } from "@filen/sdk-rs"
import {
	SW_DOWNLOAD_PREFIX,
	SW_MSG_PREVIEW_STATUS,
	SW_MSG_REGISTER_PORT_PREVIEW,
	SW_MSG_REGISTER_PREVIEW,
	SW_MSG_RELEASE_PREVIEW,
	SW_PREVIEW_BUCKET_PLAYER,
	SW_PREVIEW_BUCKET_TRANSIENT,
	SW_PROTOCOL_VERSION
} from "@/lib/sw/protocol"

// previewStreamUrl is the request half of the inline-preview seam; its release side
// (SW_MSG_RELEASE_PREVIEW) and the SDK-side cancel of an anon range port (cancelPreviewDownload)
// are pinned further down.
// registerWithSw is saveDownload.ts's shared registration seam (session handoff, restart healing, ack
// plumbing), already pinned by saveDownload.test.ts; only the registration payload/URL shape unique to
// the preview route is re-verified here.

const { registerWithSw, holdWorkerAlive, sendToSw, activeServiceWorker, sdk } = vi.hoisted(() => ({
	registerWithSw: vi.fn(),
	holdWorkerAlive: vi.fn(),
	sendToSw: vi.fn(),
	activeServiceWorker: vi.fn(),
	sdk: { openLinkedRangePortAnon: vi.fn(), cancelPreviewDownload: vi.fn() }
}))

vi.mock("@/features/drive/lib/saveDownload", () => ({ registerWithSw, holdWorkerAlive, sendToSw, activeServiceWorker }))
vi.mock("@/lib/sdk/client", () => ({ sdkApi: sdk }))

function testFile(overrides: Partial<AnyFile> = {}): AnyFile {
	return {
		uuid: "file-uuid",
		meta: { type: "encrypted", data: "x" },
		parent: "parent-uuid",
		size: 4_096n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 0n,
		chunks: 1n,
		canMakeThumbnail: false,
		...overrides
	} as AnyFile
}

afterEach(() => {
	vi.clearAllMocks()
	vi.unstubAllGlobals()
})

describe("previewStreamUrl", () => {
	it("registers the file against SW_MSG_REGISTER_PREVIEW and returns a SW_DOWNLOAD_PREFIX url", async () => {
		registerWithSw.mockResolvedValue(undefined)

		const { previewStreamUrl } = await import("@/features/preview/lib/previewStream")
		const file = testFile()
		const url = await previewStreamUrl(file, "clip.mp4", "video/mp4")

		expect(url.startsWith(SW_DOWNLOAD_PREFIX)).toBe(true)

		expect(registerWithSw).toHaveBeenCalledTimes(1)
		const [type, payload] = registerWithSw.mock.calls[0] as [string, Record<string, unknown>]

		expect(type).toBe(SW_MSG_REGISTER_PREVIEW)
		expect(payload).toMatchObject({ file, name: "clip.mp4", size: 4_096, contentType: "video/mp4" })
		expect(payload["id"]).toBe(url.slice(SW_DOWNLOAD_PREFIX.length))
	})

	it("mints a distinct id per call", async () => {
		registerWithSw.mockResolvedValue(undefined)

		const { previewStreamUrl } = await import("@/features/preview/lib/previewStream")
		const a = await previewStreamUrl(testFile(), "a.mp4", "video/mp4")
		const b = await previewStreamUrl(testFile(), "b.mp4", "video/mp4")

		expect(a).not.toBe(b)
	})

	it("re-registers a given id and returns its same url", async () => {
		registerWithSw.mockResolvedValue(undefined)

		const { previewStreamUrl } = await import("@/features/preview/lib/previewStream")
		const url = await previewStreamUrl(testFile(), "clip.mp4", "video/mp4", "known-id")

		expect(url).toBe(`${SW_DOWNLOAD_PREFIX}known-id`)
		expect((registerWithSw.mock.calls[0] as [string, Record<string, unknown>])[1]["id"]).toBe("known-id")
	})

	it("files a transient registration (a thumbnail's frame) and a player's in buckets of their own", async () => {
		registerWithSw.mockResolvedValue(undefined)

		const { previewStreamUrl } = await import("@/features/preview/lib/previewStream")

		await previewStreamUrl(testFile(), "a.mp4", "video/mp4", "thumb-id", { transient: true })
		await previewStreamUrl(testFile(), "b.mp4", "video/mp4", "player-id")

		const payload = (index: number) => (registerWithSw.mock.calls[index] as [string, Record<string, unknown>])[1]

		expect(payload(0)["bucket"]).toBe(SW_PREVIEW_BUCKET_TRANSIENT)
		expect(payload(1)["bucket"]).toBe(SW_PREVIEW_BUCKET_PLAYER)

		// An image preview is no player: it shares the downloads' bucket.
		await previewStreamUrl(testFile(), "c.png", "image/png", "image-id")
		expect(payload(2)).not.toHaveProperty("bucket")
	})

	it("propagates a registration failure — caller (usePreviewStreamUrl) maps it to a fallback state, not a toast", async () => {
		registerWithSw.mockRejectedValue(new Error("no room in sw registry"))

		const { previewStreamUrl } = await import("@/features/preview/lib/previewStream")

		await expect(previewStreamUrl(testFile(), "clip.mp4", "video/mp4")).rejects.toThrow("no room in sw registry")
	})
})

describe("isMediaStreamAvailable", () => {
	it("true once a service worker is controlling the tab", async () => {
		vi.stubGlobal("navigator", { serviceWorker: { controller: {} } })

		const { isMediaStreamAvailable } = await import("@/features/preview/lib/previewStream")

		expect(isMediaStreamAvailable()).toBe(true)
	})

	it("false when no service worker has claimed the page yet", async () => {
		vi.stubGlobal("navigator", { serviceWorker: { controller: null } })

		const { isMediaStreamAvailable } = await import("@/features/preview/lib/previewStream")

		expect(isMediaStreamAvailable()).toBe(false)
	})

	it("false where the browser has no service worker support at all", async () => {
		vi.stubGlobal("navigator", {})

		const { isMediaStreamAvailable } = await import("@/features/preview/lib/previewStream")

		expect(isMediaStreamAvailable()).toBe(false)
	})
})

describe("waitForMediaStream", () => {
	it("true immediately when a worker already controls the tab, without consulting the registration", async () => {
		const getRegistration = vi.fn()

		vi.stubGlobal("navigator", { serviceWorker: { controller: {}, getRegistration } })

		const { waitForMediaStream } = await import("@/features/preview/lib/previewStream")

		await expect(waitForMediaStream(50)).resolves.toBe(true)
		expect(getRegistration).not.toHaveBeenCalled()
	})

	it("false immediately when nothing is registered — dev registers none, so there is no 'yet' to wait for", async () => {
		const addEventListener = vi.fn()

		vi.stubGlobal("navigator", {
			serviceWorker: { controller: null, getRegistration: vi.fn().mockResolvedValue(undefined), addEventListener }
		})

		const { waitForMediaStream } = await import("@/features/preview/lib/previewStream")

		await expect(waitForMediaStream(50)).resolves.toBe(false)
		// The point of the early return: nothing subscribes, so a caller in dev pays no timeout per item.
		expect(addEventListener).not.toHaveBeenCalled()
	})

	it("waits for a registered worker to take control rather than reporting it absent", async () => {
		const serviceWorker: Record<string, unknown> = {
			controller: null,
			getRegistration: vi.fn().mockResolvedValue({}),
			addEventListener: vi.fn((_: string, handler: () => void) => {
				// Control lands a tick after the caller subscribes — the ordinary first-load sequence.
				setTimeout(() => {
					serviceWorker["controller"] = {}
					handler()
				}, 5)
			}),
			removeEventListener: vi.fn()
		}

		vi.stubGlobal("navigator", { serviceWorker })

		const { waitForMediaStream } = await import("@/features/preview/lib/previewStream")

		await expect(waitForMediaStream(1_000)).resolves.toBe(true)
		expect(serviceWorker["removeEventListener"]).toHaveBeenCalled()
	})

	it("false once the wait expires, and unsubscribes so a later controllerchange settles nothing", async () => {
		const removeEventListener = vi.fn()

		vi.stubGlobal("navigator", {
			serviceWorker: {
				controller: null,
				getRegistration: vi.fn().mockResolvedValue({}),
				addEventListener: vi.fn(),
				removeEventListener
			}
		})

		const { waitForMediaStream } = await import("@/features/preview/lib/previewStream")

		await expect(waitForMediaStream(20)).resolves.toBe(false)
		expect(removeEventListener).toHaveBeenCalled()
	})

	it("settles on control that lands between the early check and the subscription", async () => {
		const serviceWorker: Record<string, unknown> = {
			controller: null,
			// Resolving the registration is the await that opens that gap; control arrives inside it.
			getRegistration: vi.fn().mockImplementation(() => {
				serviceWorker["controller"] = {}

				return Promise.resolve({})
			}),
			addEventListener: vi.fn(),
			removeEventListener: vi.fn()
		}

		vi.stubGlobal("navigator", { serviceWorker })

		const { waitForMediaStream } = await import("@/features/preview/lib/previewStream")

		await expect(waitForMediaStream(20)).resolves.toBe(true)
	})
})

describe("releasePreviewStream", () => {
	it("tells the controlling worker to drop the registration, and does nothing without one", async () => {
		const postMessage = vi.fn()

		vi.stubGlobal("navigator", { serviceWorker: { controller: { postMessage } } })

		const { releasePreviewStream } = await import("@/features/preview/lib/previewStream")

		releasePreviewStream("known-id")
		expect(postMessage).toHaveBeenCalledWith({ type: SW_MSG_RELEASE_PREVIEW, id: "known-id" })

		vi.stubGlobal("navigator", { serviceWorker: { controller: null } })
		expect(() => {
			releasePreviewStream("other")
		}).not.toThrow()
	})
})

describe("holdPreviewStream / releasePreviewStreamSoon", () => {
	it("releases a shared id only once its last holder lets go, after the current task", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })

		try {
			const postMessage = vi.fn()

			vi.stubGlobal("navigator", { serviceWorker: { controller: { postMessage } } })

			const { holdPreviewStream, releasePreviewStreamSoon } = await import("@/features/preview/lib/previewStream")

			// Two cards of the same file; the one scrolled away lets go.
			holdPreviewStream("shared")
			holdPreviewStream("shared")
			releasePreviewStreamSoon("shared")
			await vi.advanceTimersByTimeAsync(10)
			expect(postMessage).not.toHaveBeenCalled()

			// The last one goes: released, unless held again first (a remount).
			releasePreviewStreamSoon("shared")
			holdPreviewStream("shared")
			await vi.advanceTimersByTimeAsync(10)
			expect(postMessage).not.toHaveBeenCalled()

			releasePreviewStreamSoon("shared")
			await vi.advanceTimersByTimeAsync(10)
			expect(postMessage).toHaveBeenCalledExactlyOnceWith({ type: SW_MSG_RELEASE_PREVIEW, id: "shared" })
		} finally {
			vi.useRealTimers()
		}
	})
})

describe("holdPreviewStreamAlive", () => {
	it("holds the controlling worker alive until released, and is a no-op without service workers", async () => {
		const controller = { postMessage: vi.fn() }
		const release = vi.fn()

		holdWorkerAlive.mockReturnValue(release)
		vi.stubGlobal("navigator", { serviceWorker: { controller } })

		const { holdPreviewStreamAlive } = await import("@/features/preview/lib/previewStream")

		holdPreviewStreamAlive()()
		expect(holdWorkerAlive).toHaveBeenCalledWith(controller)
		expect(release).toHaveBeenCalledTimes(1)

		vi.stubGlobal("navigator", {})
		expect(() => {
			holdPreviewStreamAlive()()
		}).not.toThrow()
		expect(holdWorkerAlive).toHaveBeenCalledTimes(1)
	})
})

describe("previewStreamUrl (anon)", () => {
	// The controlling worker: answers a status query with `status`, when given one.
	function anonReady(options: { version?: number; status?: string } = {}) {
		const controller = {
			postMessage: vi.fn((data: { type?: string }, transfer?: Transferable[]) => {
				const reply = transfer?.[0]

				if (data.type === SW_MSG_PREVIEW_STATUS && options.status !== undefined && reply instanceof MessagePort) {
					reply.postMessage({ status: options.status })
				}
			})
		}

		sdk.openLinkedRangePortAnon.mockResolvedValue(undefined)
		sdk.cancelPreviewDownload.mockResolvedValue(undefined)
		sendToSw.mockResolvedValue(undefined)
		vi.stubGlobal("navigator", { serviceWorker: { controller, addEventListener: vi.fn() } })
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.resolve(Response.json({ v: options.version ?? SW_PROTOCOL_VERSION })))
		)

		return controller
	}

	function tokenOf(call: number): string {
		return (sdk.openLinkedRangePortAnon.mock.calls[call] as [MessagePort, AnyFile, string])[2]
	}

	function payloadOf(call: number): Record<string, unknown> {
		return (sendToSw.mock.calls[call] as [unknown, string, Record<string, unknown>])[2]
	}

	it("opens an anon range port and hands only its reading end and the file's name, size and type to the controller", async () => {
		const controller = anonReady()

		const { previewStreamUrl } = await import("@/features/preview/lib/previewStream")
		const file = testFile()
		const url = await previewStreamUrl(file, "clip.mp4", "video/mp4", "anon-id", { access: "anon" })

		expect(url).toBe(`${SW_DOWNLOAD_PREFIX}anon-id`)
		expect(registerWithSw).not.toHaveBeenCalled()
		expect(sdk.openLinkedRangePortAnon).toHaveBeenCalledTimes(1)

		const [served, servedFile] = sdk.openLinkedRangePortAnon.mock.calls[0] as [MessagePort, AnyFile, string]

		expect(served).toBeInstanceOf(MessagePort)
		expect(servedFile).toBe(file)

		const [target, type, payload, transfer] = sendToSw.mock.calls[0] as [unknown, string, Record<string, unknown>, Transferable[]]

		// The worker the URL is fetched through.
		expect(target).toBe(controller)
		expect(type).toBe(SW_MSG_REGISTER_PORT_PREVIEW)
		// Nothing secret: no file handle (its key), no token, no link.
		expect(Object.keys(payload).sort()).toEqual(["bucket", "contentType", "generation", "id", "name", "port", "size"])
		expect(payload).toMatchObject({
			id: "anon-id",
			name: "clip.mp4",
			size: 4_096,
			contentType: "video/mp4",
			bucket: SW_PREVIEW_BUCKET_PLAYER
		})
		expect(payload["port"]).toBeInstanceOf(MessagePort)
		expect(payload["port"]).not.toBe(served)
		expect(transfer).toEqual([payload["port"]])
	})

	it("rejects at once, before any SDK work, when the controlling worker is older than this page", async () => {
		anonReady({ version: SW_PROTOCOL_VERSION - 1 })

		const { previewStreamUrl } = await import("@/features/preview/lib/previewStream")

		await expect(previewStreamUrl(testFile(), "clip.mp4", "video/mp4", "old-sw", { access: "anon" })).rejects.toThrow()
		expect(sdk.openLinkedRangePortAnon).not.toHaveBeenCalled()
		expect(sendToSw).not.toHaveBeenCalled()
	})

	it("rejects at once when nothing controls the page", async () => {
		anonReady()
		vi.stubGlobal("navigator", { serviceWorker: { controller: null } })

		const { previewStreamUrl } = await import("@/features/preview/lib/previewStream")

		await expect(previewStreamUrl(testFile(), "clip.mp4", "video/mp4", "no-sw", { access: "anon" })).rejects.toThrow()
		expect(sdk.openLinkedRangePortAnon).not.toHaveBeenCalled()
	})

	it("asks the controller its version once", async () => {
		anonReady()

		const { previewStreamUrl } = await import("@/features/preview/lib/previewStream")

		await previewStreamUrl(testFile(), "clip.mp4", "video/mp4", "once-1", { access: "anon" })
		await previewStreamUrl(testFile(), "clip.mp4", "video/mp4", "once-2", { access: "anon" })

		expect(fetch).toHaveBeenCalledTimes(1)
	})

	it("releases a port registration whole, and a second release changes nothing", async () => {
		const controller = anonReady()

		const { previewStreamUrl, releasePreviewStream } = await import("@/features/preview/lib/previewStream")

		await previewStreamUrl(testFile(), "clip.mp4", "video/mp4", "anon-id-1", { access: "anon" })
		releasePreviewStream("anon-id-1")

		expect(sdk.cancelPreviewDownload).toHaveBeenCalledWith(tokenOf(0))
		expect(controller.postMessage).toHaveBeenCalledWith({
			type: SW_MSG_RELEASE_PREVIEW,
			id: "anon-id-1",
			generation: payloadOf(0)["generation"]
		})

		releasePreviewStream("anon-id-1")
		expect(sdk.cancelPreviewDownload).toHaveBeenCalledTimes(1)
		expect(controller.postMessage).toHaveBeenLastCalledWith({ type: SW_MSG_RELEASE_PREVIEW, id: "anon-id-1" })
	})

	it("cancels the previous port of an id registered again, and keeps the new one with a newer generation", async () => {
		anonReady()

		const { previewStreamUrl, releasePreviewStream } = await import("@/features/preview/lib/previewStream")

		await previewStreamUrl(testFile(), "clip.mp4", "video/mp4", "anon-id-2", { access: "anon" })
		await previewStreamUrl(testFile(), "clip.mp4", "video/mp4", "anon-id-2", { access: "anon" })

		expect(tokenOf(0)).not.toBe(tokenOf(1))
		expect(sdk.cancelPreviewDownload.mock.calls).toEqual([[tokenOf(0)]])
		expect(Number(payloadOf(1)["generation"])).toBeGreaterThan(Number(payloadOf(0)["generation"]))

		releasePreviewStream("anon-id-2")
		expect(sdk.cancelPreviewDownload).toHaveBeenLastCalledWith(tokenOf(1))
	})

	it("resolves a registration a newer one of the same id overtook with that one", async () => {
		anonReady()

		const slow = Promise.withResolvers<undefined>()

		sdk.openLinkedRangePortAnon.mockReturnValueOnce(slow.promise)

		const { previewStreamUrl } = await import("@/features/preview/lib/previewStream")
		const first = previewStreamUrl(testFile(), "clip.mp4", "video/mp4", "anon-id-4", { access: "anon" })

		await vi.waitFor(() => {
			expect(sdk.openLinkedRangePortAnon).toHaveBeenCalledTimes(1)
		})

		const second = previewStreamUrl(testFile(), "clip.mp4", "video/mp4", "anon-id-4", { access: "anon" })

		await expect(second).resolves.toBe(`${SW_DOWNLOAD_PREFIX}anon-id-4`)
		slow.resolve(undefined)
		await expect(first).resolves.toBe(`${SW_DOWNLOAD_PREFIX}anon-id-4`)
		expect(sdk.cancelPreviewDownload).toHaveBeenCalledWith(tokenOf(0))
	})

	it("rejects a registration released while on its way, its SDK side cancelled", async () => {
		const controller = anonReady()
		const slow = Promise.withResolvers<undefined>()

		sdk.openLinkedRangePortAnon.mockReturnValueOnce(slow.promise)

		const { previewStreamUrl, releasePreviewStream } = await import("@/features/preview/lib/previewStream")
		const registering = previewStreamUrl(testFile(), "clip.mp4", "video/mp4", "anon-id-5", { access: "anon" })

		await vi.waitFor(() => {
			expect(sdk.openLinkedRangePortAnon).toHaveBeenCalledTimes(1)
		})
		releasePreviewStream("anon-id-5")
		slow.resolve(undefined)

		await expect(registering).rejects.toMatchObject({ name: "AbortError" })
		expect(sdk.cancelPreviewDownload).toHaveBeenCalledWith(tokenOf(0))
		// Never handed to the worker, and the release named the generation it covers in case it had been.
		expect(sendToSw).not.toHaveBeenCalled()

		const released = controller.postMessage.mock.calls.at(-1)?.[0]

		expect(released).toMatchObject({ type: SW_MSG_RELEASE_PREVIEW, id: "anon-id-5" })
		expect(Object.keys(released ?? {})).toContain("generation")
	})

	it("cancels the SDK worker's side when the service worker refuses the registration", async () => {
		anonReady()
		sendToSw.mockRejectedValue(new Error("service worker did not respond"))

		const { previewStreamUrl, releasePreviewStream } = await import("@/features/preview/lib/previewStream")

		await expect(previewStreamUrl(testFile(), "clip.mp4", "video/mp4", "anon-id-3", { access: "anon" })).rejects.toThrow(
			"service worker did not respond"
		)
		expect(sdk.cancelPreviewDownload).toHaveBeenCalledWith(tokenOf(0))

		releasePreviewStream("anon-id-3")
		expect(sdk.cancelPreviewDownload).toHaveBeenCalledTimes(1)
	})
})

describe("previewStreamStatus", () => {
	function controllerAnswering(status: string | null, version = SW_PROTOCOL_VERSION) {
		const controller = {
			postMessage: vi.fn((_data: unknown, transfer?: Transferable[]) => {
				const reply = transfer?.[0]

				if (status !== null && reply instanceof MessagePort) {
					reply.postMessage({ status })
				}
			})
		}

		vi.stubGlobal("navigator", { serviceWorker: { controller } })
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.resolve(Response.json({ v: version })))
		)

		return controller
	}

	it("asks the controller, never the stream", async () => {
		const { previewStreamStatus } = await import("@/features/preview/lib/previewStream")

		for (const status of ["present", "lost", "missing"] as const) {
			const controller = controllerAnswering(status)

			await expect(previewStreamStatus("id-1")).resolves.toBe(status)

			const [data, transfer] = controller.postMessage.mock.calls[0] ?? []

			expect(data).toEqual({ type: SW_MSG_PREVIEW_STATUS, id: "id-1" })
			expect(transfer?.[0]).toBeInstanceOf(MessagePort)
		}

		expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining(SW_DOWNLOAD_PREFIX), expect.anything())
	})

	it("is missing without a controller, and unknown with one older than this page, without asking it", async () => {
		const { previewStreamStatus } = await import("@/features/preview/lib/previewStream")

		vi.stubGlobal("navigator", { serviceWorker: { controller: null } })
		await expect(previewStreamStatus("id-1")).resolves.toBe("missing")

		const old = controllerAnswering("present", SW_PROTOCOL_VERSION - 1)

		await expect(previewStreamStatus("id-1")).resolves.toBe("unknown")
		expect(old.postMessage).not.toHaveBeenCalled()
	})

	it("is missing when the controller does not answer", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })

		try {
			controllerAnswering(null)

			const { previewStreamStatus } = await import("@/features/preview/lib/previewStream")
			const status = previewStreamStatus("id-1")

			await vi.advanceTimersByTimeAsync(5_000)
			await expect(status).resolves.toBe("missing")
		} finally {
			vi.useRealTimers()
		}
	})
})

describe("onPreviewStreamGone", () => {
	it("hears the worker's stream-gone report for its own id only, until unsubscribed", async () => {
		const { onPreviewStreamGone } = await import("@/features/preview/lib/previewStream")
		const { SW_MSG_STREAM_GONE } = await import("@/lib/sw/protocol")
		const container = new EventTarget()

		vi.stubGlobal("navigator", { serviceWorker: container })

		const listener = vi.fn()
		const stop = onPreviewStreamGone("id-1", listener)
		const post = (data: unknown): void => {
			container.dispatchEvent(new MessageEvent("message", { data }))
		}

		post({ type: SW_MSG_STREAM_GONE, id: "id-2" })
		post({ type: "other", id: "id-1" })
		post({ type: SW_MSG_STREAM_GONE, id: "id-1" })
		stop()
		post({ type: SW_MSG_STREAM_GONE, id: "id-1" })

		expect(listener).toHaveBeenCalledOnce()
		vi.unstubAllGlobals()
	})
})

describe("previewDelivered", () => {
	function serviceWorkerContainer() {
		const container = new EventTarget()

		vi.stubGlobal("navigator", { serviceWorker: container })

		return (data: unknown): void => {
			container.dispatchEvent(new MessageEvent("message", { data }))
		}
	}

	it("keeps an acknowledgement that lands before anything asks, for the registered id only", async () => {
		vi.resetModules()

		const post = serviceWorkerContainer()
		const { previewDelivered, previewStreamUrl } = await import("@/features/preview/lib/previewStream")
		const { SW_MSG_PREVIEW_DELIVERED } = await import("@/lib/sw/protocol")

		registerWithSw.mockResolvedValue(undefined)
		await previewStreamUrl(testFile(), "photo.heic", "image/heic", "id-1")
		post({ type: SW_MSG_PREVIEW_DELIVERED, id: "id-1" })

		expect(await previewDelivered("id-1", 0)).toBe(true)
		expect(await previewDelivered("id-2", 0)).toBe(false)
	})

	it("waits a grace period for an acknowledgement still on its way, and forgets it when the id registers again", async () => {
		vi.resetModules()

		const post = serviceWorkerContainer()
		const { previewDelivered, previewStreamUrl } = await import("@/features/preview/lib/previewStream")
		const { SW_MSG_PREVIEW_DELIVERED } = await import("@/lib/sw/protocol")

		registerWithSw.mockResolvedValue(undefined)
		await previewStreamUrl(testFile(), "photo.heic", "image/heic", "id-1")

		const waiting = previewDelivered("id-1", 1_000)

		post({ type: "other", id: "id-1" })
		post({ type: SW_MSG_PREVIEW_DELIVERED, id: "id-1" })

		expect(await waiting).toBe(true)

		await previewStreamUrl(testFile(), "photo.heic", "image/heic", "id-1")

		expect(await previewDelivered("id-1", 10)).toBe(false)
	})
})

describe("previewStreamHead", () => {
	function serviceWorkerContainer() {
		const container = new EventTarget()

		vi.stubGlobal("navigator", { serviceWorker: container })

		return (data: unknown): void => {
			container.dispatchEvent(new MessageEvent("message", { data }))
		}
	}

	it("hands over the head the worker posts for the id, whether it lands before or after the ask", async () => {
		vi.resetModules()

		const post = serviceWorkerContainer()
		const { previewStreamHead, previewStreamUrl } = await import("@/features/preview/lib/previewStream")
		const { SW_MSG_PREVIEW_HEAD } = await import("@/lib/sw/protocol")

		registerWithSw.mockResolvedValue(undefined)
		await previewStreamUrl(testFile(), "cat.gif", "image/gif", "id-1")

		const waiting = previewStreamHead("id-1", new AbortController().signal)

		post({ type: SW_MSG_PREVIEW_HEAD, id: "id-2", bytes: new Uint8Array([2]) })
		post({ type: SW_MSG_PREVIEW_HEAD, id: "id-1", bytes: new Uint8Array([1]) })

		expect([...((await waiting) ?? [])]).toEqual([1])
		expect([...((await previewStreamHead("id-2", new AbortController().signal)) ?? [])]).toEqual([2])
	})

	it("answers null once aborted", async () => {
		vi.resetModules()
		serviceWorkerContainer()

		const { previewStreamHead } = await import("@/features/preview/lib/previewStream")
		const controller = new AbortController()
		const waiting = previewStreamHead("id-1", controller.signal)

		controller.abort()
		expect(await waiting).toBeNull()
	})
})
