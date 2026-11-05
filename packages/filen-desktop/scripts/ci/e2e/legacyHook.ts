import { fail, freePort, waitFor } from "../support.ts"
import { connectCdp, listTargets, type Cdp } from "./cdp/inspector.ts"

// An old client's update launch, hooked before any of its code runs. It starts with --inspect-brk; at the first break a
// module-load hook goes in, then the app runs. The hook always:
//
//   frees its    start its worker threads without the inspector flags: a worker inherits --inspect-brk and waits for a
//   workers      debugger forever, so the old main process never sees its worker start (3.0.47 starts its updater only
//                after that)
//   relaunches   app.relaunch() without options (electron-updater's deb and rpm install relaunches that way) relaunches
//   as started   the command line the app was started with, which holds --inspect-brk; the hook relaunches the
//                executable the harness started (`relaunchAs`) with the app's own arguments less the inspector flags,
//                as a user's app would be relaunched
//
// and can:
//
//   hold sync    wrap its worker's invoke so that sync starts and sync updates are dropped (chain L: its updater starts
//                before its sync worker, but the download and the install race the first sync cycle, which would carry
//                the closed-app edits before 4.x sees them); the updater itself is untouched
//   point the    for a client without an E2E hook (3.0.47): when electron-updater loads, set its feed to the loopback
//   updater      one, and wrap the app's Updater.prototype.initialize so that update-downloaded calls the app's own
//                installUpdate() (what its restart prompt runs), once; the relaunched app is not hooked, so it never
//                installs again
//
// It reports itself in globalThis.__e2eHook. Node built-ins only: the update scenario at install depth runs it.

const INSPECTOR_TIMEOUT_MS = 60_000

export interface HookOptions {
	holdSync: boolean
	// The loopback feed the updater is pointed at; null leaves it alone (the client's own E2E hook does that).
	feed: string | null
	// The executable the app was started as (Linux deb and rpm: the old release's own name), which a relaunch runs.
	relaunchAs: string
}

export interface HookState {
	// worker_threads' Worker drops the inspector flags.
	threads: boolean
	// electron's app.relaunch is wrapped, and the command line a relaunch ran (null before one).
	relaunch: boolean
	relaunched: string[] | null
	// The worker's invoke is wrapped, and the calls it dropped.
	held: boolean
	dropped: string[]
	// setFeedURL was called on electron-updater's autoUpdater, and the app's Updater wrapped.
	feed: boolean
	updater: boolean
	// installUpdate() calls, and the last one's failure.
	installs: number
	error: string | null
}

// The hook as one expression, evaluated on the first paused frame. Self-contained: the feed crosses as a JSON literal.
export function hookScript({ holdSync, feed, relaunchAs }: HookOptions): string {
	return `(() => {
	const Module = process.getBuiltinModule("module")
	const state = (globalThis.__e2eHook = { threads: false, relaunch: false, relaunched: null, held: false, dropped: [], feed: false, updater: false, installs: 0, error: null })
	const holdSync = ${JSON.stringify(holdSync)}
	const feed = ${JSON.stringify(feed)}
	const relaunchAs = ${JSON.stringify(relaunchAs)}
	let autoUpdater = null
	const load = Module._load
	Module._load = function (...args) {
		const exported = load.apply(this, args)
		if (!state.threads && args[0] === "worker_threads" && exported && typeof exported.Worker === "function") {
			const Thread = exported.Worker
			const execArgv = (process.execArgv || []).filter(arg => !arg.startsWith("--inspect"))
			exported.Worker = class extends Thread {
				constructor(file, options) {
					super(file, options && options.execArgv !== undefined ? options : { ...options, execArgv })
				}
			}
			state.threads = true
		}
		const app = !state.relaunch && args[0] === "electron" && exported ? exported.app : undefined
		if (app && typeof app.relaunch === "function") {
			const relaunch = app.relaunch
			app.relaunch = function (options) {
				if (options !== undefined) {
					return relaunch.call(this, options)
				}
				const rest = (process.argv || []).slice(1).filter(arg => !arg.startsWith("--inspect"))
				state.relaunched = [relaunchAs, ...rest]
				console.log("e2e hook: app.relaunch() as " + JSON.stringify(state.relaunched))
				return relaunch.call(this, { execPath: relaunchAs, args: rest })
			}
			state.relaunch = true
		}
		const Worker = exported && exported.Worker
		if (holdSync && !state.held && typeof Worker === "function" && Worker.prototype && typeof Worker.prototype.invoke === "function") {
			const invoke = Worker.prototype.invoke
			Worker.prototype.invoke = function (channel, data) {
				if (channel === "restartSync" || channel === "startSync" || String(channel).startsWith("sync")) {
					state.dropped.push(String(channel))
					return Promise.resolve(undefined)
				}
				return invoke.call(this, channel, data)
			}
			state.held = true
		}
		if (feed !== null && !state.feed && args[0] === "electron-updater" && exported && exported.autoUpdater) {
			autoUpdater = exported.autoUpdater
			autoUpdater.setFeedURL({ provider: "generic", url: feed })
			state.feed = true
		}
		const Updater = exported && (exported.Updater || exported.default)
		if (feed !== null && !state.updater && typeof Updater === "function" && Updater.prototype &&
			typeof Updater.prototype.initialize === "function" && typeof Updater.prototype.installUpdate === "function") {
			const initialize = Updater.prototype.initialize
			Updater.prototype.initialize = function (...rest) {
				const result = initialize.apply(this, rest)
				const self = this
				if (autoUpdater !== null) {
					// After the app's own listener (registered first), which marks the update downloaded and available.
					autoUpdater.once("update-downloaded", () => {
						setTimeout(() => {
							state.installs++
							Promise.resolve(self.installUpdate()).catch(error => { state.error = String(error) })
						}, 2000)
					})
				}
				return result
			}
			state.updater = true
		}
		return exported
	}
	return "hooked"
})()`
}

// Whether the hook did what it was asked to, by the time the app's modules are loaded.
export function hookReady(state: HookState | null, options: Pick<HookOptions, "holdSync" | "feed">): boolean {
	return state !== null && state.relaunch && (!options.holdSync || state.held) && (options.feed === null || (state.feed && state.updater))
}

// The old main process's inspector on `port`, once it answers.
export async function inspector(port: number): Promise<Cdp> {
	const targets = await waitFor(`the old main process's inspector on port ${String(port)}`, INSPECTOR_TIMEOUT_MS, async () => {
		const list = await listTargets(port)

		return list?.some(entry => entry.webSocketDebuggerUrl !== undefined) === true ? list : null
	})

	return connectCdp(targets.find(entry => entry.webSocketDebuggerUrl !== undefined)?.webSocketDebuggerUrl ?? fail("no inspector target"))
}

export interface UpdateLaunchHook {
	args: string[]
	// Installs the hook, lets the app run and waits until it took; its state then.
	started(): Promise<HookState>
}

export async function legacyUpdateHook(options: HookOptions): Promise<UpdateLaunchHook> {
	const port = await freePort()

	return {
		args: [`--inspect-brk=127.0.0.1:${String(port)}`],
		async started() {
			const cdp = await inspector(port)

			try {
				// Under --inspect-brk the process runs nothing until it is let go, then breaks before its first statement
				// (before any app module loads). At that break the main thread serves the debugger only: the hook runs on the
				// paused frame (Debugger.evaluateOnCallFrame); a plain Runtime.evaluate is never answered there.
				const paused = cdp.nextEvent("Debugger.paused", INSPECTOR_TIMEOUT_MS)

				// Awaited below; this only keeps a rejection before then from going unhandled.
				paused.catch(() => undefined)
				await cdp.send("Debugger.enable")
				await cdp.send("Runtime.runIfWaitingForDebugger")

				const frame = ((await paused) as { callFrames?: { callFrameId?: string; url?: string }[] }).callFrames?.[0]
				const hooked = (await cdp.send("Debugger.evaluateOnCallFrame", {
					callFrameId: frame?.callFrameId ?? fail("the first break has no call frame"),
					expression: hookScript(options),
					returnByValue: true
				})) as { result?: { value?: unknown }; exceptionDetails?: { exception?: { description?: string } } }

				if (hooked.result?.value !== "hooked") {
					fail(
						`the launch hook did not install at ${frame?.url ?? "an unknown frame"}: ${hooked.exceptionDetails?.exception?.description ?? JSON.stringify(hooked.result)}`
					)
				}

				// No later break (an entry-script one, say) may hold the app once it is let go.
				await cdp.send("Debugger.setSkipAllPauses", { skip: true })
				await cdp.send("Debugger.resume")

				// A synchronous read of the hook's state, polled; a read that meets the app mid-start is asked again.
				let last: HookState | null = null

				return await waitFor(
					"the old app's launch hook to take",
					INSPECTOR_TIMEOUT_MS,
					async () => {
						const read = await cdp
							.evaluate("JSON.stringify(globalThis.__e2eHook ?? null)", { awaitPromise: false })
							.catch(() => null)

						last = typeof read === "string" ? (JSON.parse(read) as HookState | null) : last

						return hookReady(last, options) ? last : null
					},
					250
				).catch((error: unknown) =>
					fail(`${error instanceof Error ? error.message : String(error)}; hook state ${JSON.stringify(last)}`)
				)
			} finally {
				// Detached, so nothing holds the process at its exit for the update.
				cdp.close()
			}
		}
	}
}

// The old app's setup launch (--inspect), for a release without an E2E hook: its updater checks the production feed 15
// s after its window opens and, finding a newer 3.x there, downloads it and tells the page, which may then prompt over
// the forms the chain fills. Its checks are switched off before that (no event follows); the update launch hooks its
// own instance. Returns what it did.
export async function quietUpdater(port: number): Promise<string> {
	const cdp = await inspector(port)

	try {
		return String(
			await cdp.evaluate(
				'(() => { const updater = process.mainModule.require("electron-updater").autoUpdater; updater.checkForUpdates = () => Promise.resolve(null); return "checkForUpdates replaced" })()',
				{ awaitPromise: false }
			)
		)
	} finally {
		cdp.close()
	}
}
