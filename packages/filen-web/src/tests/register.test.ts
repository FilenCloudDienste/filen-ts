import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SW_SKIP_WAITING_MESSAGE } from "@/lib/sw/protocol"

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

function fakeWorker(state: string) {
	return { ...fakeEventTarget(), state, postMessage: vi.fn() }
}

type FakeWorker = ReturnType<typeof fakeWorker>

function fakeRegistration(waiting: FakeWorker | null = null, installing: FakeWorker | null = null) {
	return { ...fakeEventTarget(), waiting, installing }
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
})

afterEach(() => {
	vi.unstubAllEnvs()
	vi.unstubAllGlobals()
})

describe("registerSW / applyUpdate (fake navigator.serviceWorker + window.location)", () => {
	it("first visit: a controllerchange from clients.claim() does not reload or prompt", async () => {
		const registration = fakeRegistration()
		const { reload, register, fireControllerChange } = setupBrowser(registration)
		const onUpdateReady = vi.fn()

		const { registerSW } = await freshRegisterModule()

		registerSW(onUpdateReady)
		await flush()

		expect(register).toHaveBeenCalledWith("/sw.js", { type: "module" })

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

		const installing = fakeWorker("installing")

		registration.installing = installing
		setController(fakeWorker("activated")) // an existing controller: an update, not a first install
		registration.dispatch("updatefound")

		installing.state = "installed"
		installing.dispatch("statechange")

		expect(onUpdateReady).toHaveBeenCalledTimes(1)
	})

	it("a worker already waiting when register() resolves fires the update-ready callback exactly once", async () => {
		const waiting = fakeWorker("installed")
		const registration = fakeRegistration(waiting)
		const { setController } = setupBrowser(registration)
		const onUpdateReady = vi.fn()

		setController(fakeWorker("activated"))

		const { registerSW } = await freshRegisterModule()

		registerSW(onUpdateReady)
		await flush()

		expect(onUpdateReady).toHaveBeenCalledTimes(1)
	})

	it("an installing worker found by the sync check plus a later stray updatefound still fires the callback exactly once", async () => {
		const installing = fakeWorker("installing")
		const registration = fakeRegistration(null, installing)
		const { setController } = setupBrowser(registration)
		const onUpdateReady = vi.fn()

		setController(fakeWorker("activated"))

		const { registerSW } = await freshRegisterModule()

		registerSW(onUpdateReady)
		await flush()

		installing.state = "installed"
		installing.dispatch("statechange")

		// the registration has since moved on (installing cleared) -- a late updatefound for it
		// must not attach a second watcher and double-fire the callback.
		registration.installing = null
		registration.dispatch("updatefound")

		expect(onUpdateReady).toHaveBeenCalledTimes(1)
	})

	it("applyUpdate posts SKIP_WAITING and the resulting controllerchange reloads exactly once", async () => {
		const waiting = fakeWorker("installed")
		const registration = fakeRegistration(waiting)
		const { reload, setController, fireControllerChange } = setupBrowser(registration)

		setController(fakeWorker("activated"))

		const { registerSW, applyUpdate } = await freshRegisterModule()

		registerSW(vi.fn())
		await flush()

		applyUpdate()

		expect(waiting.postMessage).toHaveBeenCalledTimes(1)
		expect(waiting.postMessage).toHaveBeenCalledWith({ type: SW_SKIP_WAITING_MESSAGE })

		fireControllerChange()
		expect(reload).toHaveBeenCalledTimes(1)

		// a second controllerchange (or a spurious re-fire of the first) must never re-navigate.
		fireControllerChange()
		expect(reload).toHaveBeenCalledTimes(1)
	})

	it("ignoring the update prompt (no applyUpdate call) never reloads on a later controllerchange", async () => {
		const waiting = fakeWorker("installed")
		const registration = fakeRegistration(waiting)
		const { reload, setController, fireControllerChange } = setupBrowser(registration)
		const onUpdateReady = vi.fn()

		setController(fakeWorker("activated"))

		const { registerSW } = await freshRegisterModule()

		registerSW(onUpdateReady)
		await flush()

		expect(onUpdateReady).toHaveBeenCalledTimes(1)

		fireControllerChange()

		expect(reload).not.toHaveBeenCalled()
	})
})
