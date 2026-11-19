import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SW_MSG_ACTIVE_STREAMS, SW_MSG_BUILD, SW_MSG_CLAIM, SW_PROTOCOL_VERSION, SW_SKIP_WAITING_MESSAGE } from "@/lib/sw/protocol"

// register.ts keeps its whole state machine (started/registration/updateRequested/reloaded) in
// module-level `let`s, so every test needs its own module instance -- `vi.resetModules()` + a
// dynamic re-import before each one, mirroring src/lib/keymap/registry.test.ts's freshRegistry()
// pattern, instead of a reset export added just for tests.
//
// The module reaches the browser only through ambient globals (navigator, window), never through
// injected parameters, so those globals are replaced wholesale with plain listener-capturing fakes
// via vi.stubGlobal. No DOM lib (happy-dom is not a project dependency) is needed for that.

type Listener = () => void

function fakeEventTarget() {
	const listeners = new Map<string, Set<Listener>>()

	return {
		addEventListener(type: string, cb: Listener): void {
			const existing = listeners.get(type)

			if (existing) {
				existing.add(cb)
			} else {
				listeners.set(type, new Set([cb]))
			}
		},
		dispatch(type: string): void {
			for (const cb of listeners.get(type) ?? []) {
				cb()
			}
		}
	}
}

const PAGE_BUILD = "build-a"

// Answers the build and stream-count queries on the transferred port the way sw.ts does; `null` never
// answers (a worker older than the query). `activeStreams` is read at each ask, so a test can end a
// download between two.
function fakeWorker(state: string, build: string | null = PAGE_BUILD) {
	const worker = {
		...fakeEventTarget(),
		state,
		activeStreams: 0 as number | null,
		postMessage: vi.fn((message: { type: string }, ports?: FakePort[]) => {
			if (message.type === SW_MSG_BUILD && build !== null) {
				ports?.[0]?.postMessage({ build })
			}

			if (message.type === SW_MSG_ACTIVE_STREAMS && worker.activeStreams !== null) {
				ports?.[0]?.postMessage({ active: worker.activeStreams })
			}
		})
	}

	return worker
}

interface FakePort {
	onmessage: ((event: { data: unknown }) => void) | null
	postMessage: (data: unknown) => void
	close: () => void
}

// Delivers on a microtask, so flush() below covers the round trip.
class FakeMessageChannel {
	readonly port1: FakePort = { onmessage: null, postMessage: () => undefined, close: () => undefined }
	readonly port2: FakePort = {
		onmessage: null,
		postMessage: data => {
			queueMicrotask(() => this.port1.onmessage?.({ data }))
		},
		close: () => undefined
	}
}

// Without the queries, so a test can tell them apart from SKIP_WAITING.
function postedTypes(worker: FakeWorker): string[] {
	return worker.postMessage.mock.calls
		.map(([message]) => message.type)
		.filter(type => type !== SW_MSG_BUILD && type !== SW_MSG_ACTIVE_STREAMS)
}

type FakeWorker = ReturnType<typeof fakeWorker>

function fakeRegistration(waiting: FakeWorker | null = null, installing: FakeWorker | null = null, active: FakeWorker | null = null) {
	return { ...fakeEventTarget(), waiting, installing, active }
}

type FakeRegistration = ReturnType<typeof fakeRegistration>

// Stubs navigator.serviceWorker (register() resolving to the given fake registration, plus
// controllerchange capture) and window.location.reload -- the only two ambient surfaces
// registerSW/applyUpdate touch.
function setupBrowser(registration: FakeRegistration) {
	const reload = vi.fn()
	const register = vi.fn().mockResolvedValue(registration)
	const serviceWorker = { ...fakeEventTarget(), controller: null as FakeWorker | null, register }

	vi.stubGlobal("window", { location: { reload } })
	vi.stubGlobal("navigator", { serviceWorker })
	vi.stubGlobal("MessageChannel", FakeMessageChannel)

	return {
		reload,
		register,
		setController: (worker: FakeWorker | null): void => {
			serviceWorker.controller = worker
		},
		fireControllerChange: (): void => {
			serviceWorker.dispatch("controllerchange")
		}
	}
}

async function freshRegisterModule() {
	vi.resetModules()
	return import("@/lib/sw/register")
}

// Lets the register() promise's .then() continuation (queued as a microtask) run before assertions
// -- registerSW itself is synchronous and never awaited by callers.
async function flush(): Promise<void> {
	await new Promise(resolve => setTimeout(resolve, 0))
}

beforeEach(() => {
	// registerSW no-ops outside prod builds (see register.ts's own comment) -- every case here
	// exercises the real path.
	vi.stubEnv("PROD", true)
	vi.stubEnv("VITE_BUILD_ID", PAGE_BUILD)
})

afterEach(() => {
	vi.unstubAllEnvs()
	vi.unstubAllGlobals()
})

describe("registerSW / applyUpdate (fake navigator.serviceWorker + window.location)", () => {
	it("dev registers the worker's source module, which the dev server transforms and scopes to the root", async () => {
		// There is no built sw.js outside PROD (vite.sw.config.ts is a separate build), and the source
		// path sits below the root — so the scope has to be asked for, and vite.config.ts's dev server
		// answers Service-Worker-Allowed to permit it.
		vi.stubEnv("PROD", false)

		const { register } = setupBrowser(fakeRegistration())
		const { registerSW } = await freshRegisterModule()

		registerSW(vi.fn())

		expect(register).toHaveBeenCalledWith("/src/sw/sw.ts", { type: "module", scope: "/" })
	})

	it("first visit: a controllerchange from clients.claim() does not reload or prompt", async () => {
		const registration = fakeRegistration()
		const { reload, register, fireControllerChange } = setupBrowser(registration)
		const onUpdateReady = vi.fn()

		const { registerSW } = await freshRegisterModule()

		registerSW(onUpdateReady)
		await flush()

		expect(register).toHaveBeenCalledWith("/sw.js", { type: "module", scope: "/" })

		fireControllerChange()

		expect(onUpdateReady).not.toHaveBeenCalled()
		expect(reload).not.toHaveBeenCalled()
	})

	it("updatefound -> statechange on the new worker fires the update-ready callback exactly once", async () => {
		const registration = fakeRegistration()
		const { setController } = setupBrowser(registration)
		const onUpdateReady = vi.fn()

		const { registerSW } = await freshRegisterModule()

		registerSW(onUpdateReady)
		await flush()

		const installing = fakeWorker("installing", "build-b")
		const active = fakeWorker("activated")

		registration.installing = installing
		registration.active = active // an active worker already: an update, not a first install
		setController(active)
		registration.dispatch("updatefound")

		registration.installing = null
		registration.waiting = installing
		installing.state = "installed"
		installing.dispatch("statechange")
		await flush()

		expect(onUpdateReady).toHaveBeenCalledTimes(1)
	})

	it("first install: the claim reaching the page before the worker's installed state does not prompt", async () => {
		// Firefox, several tabs opening the origin at once: controllerchange (the worker still
		// "installing" as the page sees it) lands before that same worker's "installed" statechange.
		const installing = fakeWorker("installing")
		const registration = fakeRegistration(null, installing)
		const { setController, fireControllerChange } = setupBrowser(registration)
		const onUpdateReady = vi.fn()

		const { registerSW } = await freshRegisterModule()

		registerSW(onUpdateReady)
		await flush()

		setController(installing)
		fireControllerChange()

		registration.installing = null
		registration.waiting = installing
		installing.state = "installed"
		installing.dispatch("statechange")

		registration.waiting = null
		registration.active = installing
		installing.state = "activating"
		installing.dispatch("statechange")
		await flush()

		expect(onUpdateReady).not.toHaveBeenCalled()
	})

	it("first install: an installed state change arriving after the worker became active does not prompt", async () => {
		const installing = fakeWorker("installing")
		const registration = fakeRegistration(null, installing)
		const { setController } = setupBrowser(registration)
		const onUpdateReady = vi.fn()

		const { registerSW } = await freshRegisterModule()

		registerSW(onUpdateReady)
		await flush()

		registration.installing = null
		registration.active = installing
		setController(installing)
		installing.state = "installed"
		installing.dispatch("statechange")
		await flush()

		expect(onUpdateReady).not.toHaveBeenCalled()
	})

	it("first install: a worker waiting with no active one beside it, the page already claimed, does not prompt", async () => {
		const waiting = fakeWorker("installed")
		const { setController } = setupBrowser(fakeRegistration(waiting))
		const onUpdateReady = vi.fn()

		setController(waiting)

		const { registerSW } = await freshRegisterModule()

		registerSW(onUpdateReady)
		await flush()

		expect(onUpdateReady).not.toHaveBeenCalled()
	})

	it("a worker already waiting when register() resolves fires the update-ready callback exactly once", async () => {
		const waiting = fakeWorker("installed", "build-b")
		const active = fakeWorker("activated")
		const registration = fakeRegistration(waiting, null, active)
		const { setController } = setupBrowser(registration)
		const onUpdateReady = vi.fn()

		setController(active)

		const { registerSW } = await freshRegisterModule()

		registerSW(onUpdateReady)
		await flush()

		expect(onUpdateReady).toHaveBeenCalledTimes(1)
	})

	it("an installing worker found by the sync check plus a later stray updatefound still fires the callback exactly once", async () => {
		const installing = fakeWorker("installing", "build-b")
		const active = fakeWorker("activated")
		const registration = fakeRegistration(null, installing, active)
		const { setController } = setupBrowser(registration)
		const onUpdateReady = vi.fn()

		setController(active)

		const { registerSW } = await freshRegisterModule()

		registerSW(onUpdateReady)
		await flush()

		installing.state = "installed"
		installing.dispatch("statechange")

		// the registration has since moved on (installing cleared) -- a late updatefound for it
		// must not attach a second watcher and double-fire the callback.
		registration.installing = null
		registration.dispatch("updatefound")
		await flush()

		expect(onUpdateReady).toHaveBeenCalledTimes(1)
	})

	it("applyUpdate posts SKIP_WAITING and the resulting controllerchange reloads exactly once", async () => {
		const waiting = fakeWorker("installed", "build-b")
		const active = fakeWorker("activated")
		const registration = fakeRegistration(waiting, null, active)
		const { reload, setController, fireControllerChange } = setupBrowser(registration)

		setController(active)

		const { registerSW, applyUpdate } = await freshRegisterModule()
		const onDeferred = vi.fn()

		registerSW(vi.fn(), onDeferred)
		await flush()

		applyUpdate()
		await flush()

		expect(postedTypes(waiting)).toEqual([SW_SKIP_WAITING_MESSAGE])
		// Nothing streamed, so nothing was held back.
		expect(onDeferred).not.toHaveBeenCalled()

		fireControllerChange()
		expect(reload).toHaveBeenCalledTimes(1)

		// a second controllerchange (or a spurious re-fire of the first) must never re-navigate.
		fireControllerChange()
		expect(reload).toHaveBeenCalledTimes(1)
	})

	it("ignoring the update prompt (no applyUpdate call) never reloads on a later controllerchange", async () => {
		const waiting = fakeWorker("installed", "build-b")
		const active = fakeWorker("activated")
		const registration = fakeRegistration(waiting, null, active)
		const { reload, setController, fireControllerChange } = setupBrowser(registration)
		const onUpdateReady = vi.fn()

		setController(active)

		const { registerSW } = await freshRegisterModule()

		registerSW(onUpdateReady)
		await flush()

		expect(onUpdateReady).toHaveBeenCalledTimes(1)

		fireControllerChange()

		expect(reload).not.toHaveBeenCalled()
	})

	it("a worker of the page's own build installed beside an active one never prompts", async () => {
		// A second registration of the same build (several tabs, a re-registered origin): same sw.js, so
		// nothing to update to.
		const registration = fakeRegistration()
		const { setController } = setupBrowser(registration)
		const onUpdateReady = vi.fn()

		const { registerSW } = await freshRegisterModule()

		registerSW(onUpdateReady)
		await flush()

		const installing = fakeWorker("installing")
		const active = fakeWorker("activated", "build-b")

		registration.installing = installing
		registration.active = active
		setController(active)
		registration.dispatch("updatefound")

		installing.state = "installed"
		installing.dispatch("statechange")
		await flush()

		expect(onUpdateReady).not.toHaveBeenCalled()
	})

	it("a worker of the page's own build waiting beside an older active one takes over without a prompt or a reload", async () => {
		// The tab reloaded into a new deploy while the old worker still controlled it.
		const waiting = fakeWorker("installed")
		const active = fakeWorker("activated", "build-b")
		const registration = fakeRegistration(waiting, null, active)
		const { reload, setController, fireControllerChange } = setupBrowser(registration)
		const onUpdateReady = vi.fn()

		setController(active)

		const { registerSW } = await freshRegisterModule()

		registerSW(onUpdateReady)
		await flush()

		expect(postedTypes(waiting)).toEqual([SW_SKIP_WAITING_MESSAGE])
		expect(onUpdateReady).not.toHaveBeenCalled()

		fireControllerChange()

		expect(reload).not.toHaveBeenCalled()
	})

	it("a page loaded uncontrolled beside an active worker asks it to claim the page, without a prompt or a reload", async () => {
		// Firefox after a reload, or any hard reload.
		const active = fakeWorker("activated")
		const { reload, fireControllerChange } = setupBrowser(fakeRegistration(null, null, active))
		const onUpdateReady = vi.fn()
		const { registerSW } = await freshRegisterModule()

		registerSW(onUpdateReady)
		await flush()

		expect(postedTypes(active)).toEqual([SW_MSG_CLAIM])

		fireControllerChange()

		expect(onUpdateReady).not.toHaveBeenCalled()
		expect(reload).not.toHaveBeenCalled()
	})

	it("a page its active worker controls asks for no claim", async () => {
		const active = fakeWorker("activated")
		const { setController } = setupBrowser(fakeRegistration(null, null, active))

		setController(active)

		const { registerSW } = await freshRegisterModule()

		registerSW(vi.fn())
		await flush()

		expect(postedTypes(active)).toEqual([])
	})

	it("a waiting worker that never answers the build query neither prompts nor takes over", async () => {
		vi.useFakeTimers()

		try {
			const waiting = fakeWorker("installed", null)
			const active = fakeWorker("activated")
			const { setController } = setupBrowser(fakeRegistration(waiting, null, active))
			const onUpdateReady = vi.fn()

			setController(active)

			const { registerSW } = await freshRegisterModule()

			registerSW(onUpdateReady)
			await vi.runAllTimersAsync()

			expect(onUpdateReady).not.toHaveBeenCalled()
			expect(postedTypes(waiting)).toEqual([])
		} finally {
			vi.useRealTimers()
		}
	})

	it("a local build (no build id) never prompts for a worker of a local build", async () => {
		vi.stubEnv("VITE_BUILD_ID", undefined)

		const waiting = fakeWorker("installed", null)
		const active = fakeWorker("activated")

		waiting.postMessage.mockImplementation((message: { type: string }, ports?: FakePort[]) => {
			if (message.type === SW_MSG_BUILD) {
				ports?.[0]?.postMessage({ build: null })
			}
		})

		const { setController } = setupBrowser(fakeRegistration(waiting, null, active))
		const onUpdateReady = vi.fn()

		setController(active)

		const { registerSW } = await freshRegisterModule()

		registerSW(onUpdateReady)
		await flush()

		expect(onUpdateReady).not.toHaveBeenCalled()
	})

	it("applyUpdate holds the update back while the active worker streams a download, then sends it once none runs", async () => {
		vi.useFakeTimers()

		try {
			const waiting = fakeWorker("installed", "build-b")
			const active = fakeWorker("activated")
			const { reload, setController, fireControllerChange } = setupBrowser(fakeRegistration(waiting, null, active))

			setController(active)
			active.activeStreams = 1

			const { registerSW, applyUpdate } = await freshRegisterModule()
			const onDeferred = vi.fn()

			registerSW(vi.fn(), onDeferred)
			await vi.advanceTimersByTimeAsync(0)

			applyUpdate()
			await vi.advanceTimersByTimeAsync(0)

			expect(postedTypes(waiting)).toEqual([])
			expect(onDeferred).toHaveBeenCalledTimes(1)

			// A second click while held back (a Reload prompt shown again) is told again, but starts no second takeover.
			applyUpdate()
			expect(onDeferred).toHaveBeenCalledTimes(2)
			await vi.advanceTimersByTimeAsync(5_000)

			expect(postedTypes(waiting)).toEqual([])
			expect(active.postMessage.mock.calls.filter(([message]) => message.type === SW_MSG_ACTIVE_STREAMS)).toHaveLength(2)
			// Not told on every re-ask.
			expect(onDeferred).toHaveBeenCalledTimes(2)

			active.activeStreams = 0
			await vi.advanceTimersByTimeAsync(5_000)

			expect(postedTypes(waiting)).toEqual([SW_SKIP_WAITING_MESSAGE])

			fireControllerChange()
			expect(reload).toHaveBeenCalledTimes(1)
			expect(onDeferred).toHaveBeenCalledTimes(2)
		} finally {
			vi.useRealTimers()
		}
	})

	it("an own-build takeover waits for the active worker's downloads too", async () => {
		vi.useFakeTimers()

		try {
			const waiting = fakeWorker("installed")
			const active = fakeWorker("activated", "build-b")
			const { setController } = setupBrowser(fakeRegistration(waiting, null, active))

			setController(active)
			active.activeStreams = 2

			const { registerSW } = await freshRegisterModule()
			const onDeferred = vi.fn()

			registerSW(vi.fn(), onDeferred)
			await vi.advanceTimersByTimeAsync(0)

			expect(postedTypes(waiting)).toEqual([])
			// The user confirmed nothing here (no prompt), so there is nothing to explain.
			expect(onDeferred).not.toHaveBeenCalled()

			active.activeStreams = 0
			await vi.advanceTimersByTimeAsync(5_000)

			expect(postedTypes(waiting)).toEqual([SW_SKIP_WAITING_MESSAGE])
		} finally {
			vi.useRealTimers()
		}
	})

	it("applyUpdate during a held-back own-build takeover is told it waits, and starts no second takeover", async () => {
		vi.useFakeTimers()

		try {
			const waiting = fakeWorker("installed")
			const active = fakeWorker("activated", "build-b")
			const { setController } = setupBrowser(fakeRegistration(waiting, null, active))

			setController(active)
			active.activeStreams = 1

			const { registerSW, applyUpdate } = await freshRegisterModule()
			const onDeferred = vi.fn()

			registerSW(vi.fn(), onDeferred)
			await vi.advanceTimersByTimeAsync(0)

			expect(onDeferred).not.toHaveBeenCalled()

			applyUpdate()
			expect(onDeferred).toHaveBeenCalledTimes(1)
			await vi.advanceTimersByTimeAsync(5_000)

			expect(active.postMessage.mock.calls.filter(([message]) => message.type === SW_MSG_ACTIVE_STREAMS)).toHaveLength(2)
			expect(onDeferred).toHaveBeenCalledTimes(1)

			active.activeStreams = 0
			await vi.advanceTimersByTimeAsync(5_000)

			expect(postedTypes(waiting)).toEqual([SW_SKIP_WAITING_MESSAGE])
		} finally {
			vi.useRealTimers()
		}
	})

	it("an active worker that never answers the stream query lets the update through after the timeout", async () => {
		vi.useFakeTimers()

		try {
			const waiting = fakeWorker("installed", "build-b")
			const active = fakeWorker("activated")
			const { setController } = setupBrowser(fakeRegistration(waiting, null, active))

			setController(active)
			active.activeStreams = null

			const { registerSW, applyUpdate } = await freshRegisterModule()
			const onDeferred = vi.fn()

			registerSW(vi.fn(), onDeferred)
			await vi.advanceTimersByTimeAsync(0)

			applyUpdate()
			await vi.advanceTimersByTimeAsync(1_000)

			expect(postedTypes(waiting)).toEqual([])

			await vi.advanceTimersByTimeAsync(1_000)

			expect(postedTypes(waiting)).toEqual([SW_SKIP_WAITING_MESSAGE])
			expect(onDeferred).not.toHaveBeenCalled()
		} finally {
			vi.useRealTimers()
		}
	})

	it("a held-back update whose worker is replaced by a newer one is never sent to the old one", async () => {
		vi.useFakeTimers()

		try {
			const waiting = fakeWorker("installed", "build-b")
			const active = fakeWorker("activated")
			const registration = fakeRegistration(waiting, null, active)
			const { setController } = setupBrowser(registration)

			setController(active)
			active.activeStreams = 1

			const { registerSW, applyUpdate } = await freshRegisterModule()

			registerSW(vi.fn())
			await vi.advanceTimersByTimeAsync(0)

			applyUpdate()
			await vi.advanceTimersByTimeAsync(0)

			registration.waiting = fakeWorker("installed", "build-c")
			active.activeStreams = 0
			await vi.advanceTimersByTimeAsync(5_000)

			expect(postedTypes(waiting)).toEqual([])
		} finally {
			vi.useRealTimers()
		}
	})

	it("applyUpdate with no waiting worker reloads once and posts nothing", async () => {
		const active = fakeWorker("activated")
		const { reload, setController } = setupBrowser(fakeRegistration(null, null, active))

		setController(active)

		const { registerSW, applyUpdate } = await freshRegisterModule()

		registerSW(vi.fn())
		await flush()

		applyUpdate()
		await flush()

		expect(reload).toHaveBeenCalledTimes(1)
		expect(active.postMessage).not.toHaveBeenCalled()
	})
})

// The answer `/__sw/version` gives, or a rejection.
function stubVersionFetch(...answers: unknown[]) {
	const fetchMock = vi.fn(() => {
		const answer = answers.length > 1 ? answers.shift() : answers[0]

		if (answer instanceof Error) {
			return Promise.reject(answer)
		}

		return Promise.resolve(answer as Response)
	})

	vi.stubGlobal("fetch", fetchMock)

	return fetchMock
}

describe("controllerProtocolVersion / controllerIsCurrent", () => {
	it("resolves null with no controller and asks nothing", async () => {
		setupBrowser(fakeRegistration())

		const fetchMock = stubVersionFetch(Response.json({ v: SW_PROTOCOL_VERSION }))
		const { controllerProtocolVersion } = await freshRegisterModule()

		expect(await controllerProtocolVersion()).toBeNull()
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it("asks once per controller, and again after the controller changes", async () => {
		const { setController } = setupBrowser(fakeRegistration())

		setController(fakeWorker("activated"))

		const fetchMock = stubVersionFetch(Response.json({ v: 7 }), Response.json({ v: 8 }))
		const { controllerProtocolVersion } = await freshRegisterModule()

		expect(await controllerProtocolVersion()).toBe(7)
		expect(await controllerProtocolVersion()).toBe(7)
		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(fetchMock).toHaveBeenCalledWith("/__sw/version", { cache: "no-store" })

		setController(fakeWorker("activated"))

		expect(await controllerProtocolVersion()).toBe(8)
		expect(fetchMock).toHaveBeenCalledTimes(2)
	})

	it.each([
		["a rejected fetch", new Error("worker restarting")],
		["a non-ok response", new Response(null, { status: 503 })],
		["a body without a numeric version", Response.json({ v: "20" })]
	])("%s resolves null and is asked again on the next call", async (_name, failure) => {
		const { setController } = setupBrowser(fakeRegistration())

		setController(fakeWorker("activated"))

		const fetchMock = stubVersionFetch(failure, Response.json({ v: SW_PROTOCOL_VERSION }))
		const { controllerProtocolVersion } = await freshRegisterModule()

		expect(await controllerProtocolVersion()).toBeNull()
		await flush()

		expect(await controllerProtocolVersion()).toBe(SW_PROTOCOL_VERSION)
		expect(fetchMock).toHaveBeenCalledTimes(2)
	})

	it.each([
		[SW_PROTOCOL_VERSION, true],
		[SW_PROTOCOL_VERSION + 1, true],
		[SW_PROTOCOL_VERSION - 1, false],
		[null, false]
	])("controllerIsCurrent for version %s is %s", async (version, current) => {
		const { setController } = setupBrowser(fakeRegistration())

		setController(fakeWorker("activated"))
		stubVersionFetch(Response.json(version === null ? {} : { v: version }))

		const { controllerIsCurrent } = await freshRegisterModule()

		expect(await controllerIsCurrent()).toBe(current)
	})
})
