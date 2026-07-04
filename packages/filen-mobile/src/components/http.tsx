import { useSdkClients } from "@/lib/auth"
import type { JsClientInterface, HttpProviderHandle, AnyFile } from "@filen/sdk-rs"
import { type AppStateStatus, AppState } from "react-native"
import useEffectOnce from "@/hooks/useEffectOnce"
import { useEffect, useCallback } from "react"
import { runEffect, run, Semaphore } from "@filen/utils"
import useHttpStore from "@/stores/useHttp.store"
import usePipStore from "@/stores/usePip.store"
import alerts from "@/lib/alerts"
import { queryClient } from "@/queries/client"
import logger from "@/lib/logger"
import { HTTP_PROVIDER_PRIMARY_PORT } from "@/constants"

const mutex = new Semaphore(1)

// Grace window before a background teardown (spec: docs/pip-video-player.md §5.3). The relative
// order of the PiP-start event vs the AppState "background" event is platform- and path-dependent,
// so the destroy is deferred and cancellable by PiP-start (and by a quick return to "active")
// instead of firing immediately. On iOS pending JS timers run in background via RCTTiming; on
// Android JS timers FREEZE while the activity is paused and thaw-fire on resume — the callback
// re-checks state under the mutex, which makes the thaw-fire a benign no-op there (documented
// consequence: on Android a non-PiP background tears the provider down at the next resume).
export const PROVIDER_GRACE_DESTROY_MS = 2500

// First-bind candidate ladder vs same-port priority (spec §5.4): provider URLs are stateless
// bearer capabilities that embed the port, and player sources are initial-only — so once a port is
// bound for this session, restarts must retry the SAME port (never walk the ladder) or every live
// player URL breaks. The ladder only handles an external squatter on the session's FIRST bind.
const FIRST_BIND_LADDER: (number | undefined)[] = [
	HTTP_PROVIDER_PRIMARY_PORT,
	HTTP_PROVIDER_PRIMARY_PORT + 1,
	HTTP_PROVIDER_PRIMARY_PORT + 2,
	undefined
]
const FIRST_BIND_ATTEMPTS_PER_CANDIDATE = 3
const BIND_RETRY_DELAY_MS = 200
// Bound for same-port retries: the previous instance frees the port at its cancel signal, but a
// wedged drain is force-aborted only after 10s (Rust side) — retry until just past that.
const SAME_PORT_RETRY_DEADLINE_MS = 11_000

// Module-level so ensureHttpProviderHealthy() (called from the video preview during a backgrounded
// PiP session) can operate on the same state the component manages. InnerHttp is a singleton shell
// mount, so this is single-owner state with the mutex serializing every transition.
let httpHandle: HttpProviderHandle | null = null
let currentSdkClient: JsClientInterface | null = null
let sessionPort: number | null = null
let graceDestroyTimer: ReturnType<typeof setTimeout> | null = null

function sleep(ms: number): Promise<void> {
	return new Promise<void>(resolve => setTimeout(resolve, ms))
}

// Mutex must be held. Publishes port + getFileUrl on success and re-resolves mounted
// useFileUrlQuerys (defense-in-depth: previews that resolved during the boot window pick up the
// live URL; pairs with the readiness-wait in useFileUrl.query.ts).
async function startProviderLocked(sdkClient: JsClientInterface): Promise<void> {
	if (httpHandle) {
		return
	}

	let handle: HttpProviderHandle | null = null

	if (sessionPort !== null) {
		// Same-port priority: retry the session port until the deadline. Falling to another
		// candidate mid-session would break every previously-issued player URL.
		const deadline = Date.now() + SAME_PORT_RETRY_DEADLINE_MS
		let lastError: unknown = null

		for (;;) {
			try {
				handle = (await sdkClient.startHttpProvider(sessionPort)) as HttpProviderHandle

				break
			} catch (e) {
				lastError = e

				if (Date.now() >= deadline) {
					throw lastError
				}

				await sleep(BIND_RETRY_DELAY_MS)
			}
		}
	} else {
		let lastError: unknown = null

		for (const candidate of FIRST_BIND_LADDER) {
			for (let attempt = 0; attempt < FIRST_BIND_ATTEMPTS_PER_CANDIDATE && !handle; attempt++) {
				try {
					handle = (await sdkClient.startHttpProvider(candidate)) as HttpProviderHandle
				} catch (e) {
					lastError = e

					await sleep(BIND_RETRY_DELAY_MS)
				}
			}

			if (handle) {
				break
			}

			logger.warn("http", "HTTP provider candidate port unavailable, falling through", { candidate })
		}

		if (!handle) {
			throw lastError
		}
	}

	if (!handle) {
		throw new Error("HTTP provider start failed")
	}

	const boundHandle = handle

	sessionPort = boundHandle.port()
	httpHandle = boundHandle

	useHttpStore.getState().setPort(boundHandle.port())
	useHttpStore.getState().setGetFileUrl((file: AnyFile): string => {
		return boundHandle.getFileUrl(file)
	})

	queryClient.invalidateQueries({
		queryKey: ["useFileUrlQuery"]
	})
}

// Mutex must be held.
function destroyProviderLocked(): void {
	if (!httpHandle) {
		return
	}

	httpHandle.uniffiDestroy()
	httpHandle = null

	useHttpStore.getState().setPort(null)
	useHttpStore.getState().setGetFileUrl(null)
}

function cancelGraceDestroy(): void {
	if (graceDestroyTimer !== null) {
		clearTimeout(graceDestroyTimer)

		graceDestroyTimer = null
	}
}

function scheduleGraceDestroy(): void {
	cancelGraceDestroy()

	graceDestroyTimer = setTimeout(() => {
		graceDestroyTimer = null

		run(async defer => {
			await mutex.acquire()

			defer(() => {
				mutex.release()
			})

			// Re-check under the mutex: the timer may thaw-fire on Android resume (timers freeze
			// while the activity is paused), or a PiP session may have started since scheduling.
			if (AppState.currentState === "active" || usePipStore.getState().activeKey !== null) {
				return
			}

			destroyProviderLocked()
		}).then(result => {
			if (!result.success) {
				logger.error("http", "HTTP provider grace teardown failed", { error: result.error })
			}
		})
	}, PROVIDER_GRACE_DESTROY_MS)
}

// Probe + recover the provider during a backgrounded PiP session (spec §5.5). iOS may suspend the
// process while the video is PAUSED in PiP, killing the listening socket; when the user resumes,
// the player's range requests would fail against a dead port. Any HTTP response (even the 400 the
// Rust handler returns for a bogus descriptor) proves liveness; connection refusal means dead —
// restart on the SAME session port so previously-issued player URLs keep working.
export async function ensureHttpProviderHealthy(): Promise<void> {
	const port = useHttpStore.getState().port

	if (port !== null) {
		try {
			await fetch(`http://127.0.0.1:${port}/file?file=x`)

			return
		} catch {
			// Connection refused/reset — the provider is gone; fall through to restart.
		}
	}

	const sdkClient = currentSdkClient

	if (!sdkClient) {
		return
	}

	const result = await run(async defer => {
		await mutex.acquire()

		defer(() => {
			mutex.release()
		})

		destroyProviderLocked()
		await startProviderLocked(sdkClient)
	})

	if (!result.success) {
		logger.error("http", "HTTP provider health recovery failed", { error: result.error })
	}
}

const InnerHttp = ({ sdkClient }: { sdkClient: JsClientInterface }) => {
	const onAppStateChange = useCallback(
		async (nextAppState: AppStateStatus) => {
			if (nextAppState !== "active" && nextAppState !== "background") {
				return
			}

			if (nextAppState === "background") {
				// PiP session active → the provider must keep streaming (spec §5.3). Otherwise
				// schedule the grace teardown — cancellable by PiP-start (event ordering is
				// platform-dependent) and by a quick bounce back to "active".
				if (usePipStore.getState().activeKey === null) {
					scheduleGraceDestroy()
				}

				return
			}

			cancelGraceDestroy()

			const result = await run(async defer => {
				await mutex.acquire()

				defer(() => {
					mutex.release()
				})

				await startProviderLocked(sdkClient)
			})

			if (!result.success) {
				logger.error("http", "HTTP provider lifecycle failed", { nextAppState, error: result.error })
				alerts.error(result.error)
			}
		},
		[sdkClient]
	)

	useEffect(() => {
		currentSdkClient = sdkClient

		return () => {
			currentSdkClient = null
		}
	}, [sdkClient])

	useEffect(() => {
		const { cleanup } = runEffect(defer => {
			const appStateSubscription = AppState.addEventListener("change", onAppStateChange)

			// PiP transitions drive the teardown state directly: a starting session cancels any
			// pending grace destroy (covers PiP-start arriving AFTER the background event); a
			// session ending while backgrounded is a real background from now on.
			const unsubscribePip = usePipStore.subscribe(
				state => state.activeKey,
				(activeKey, previousActiveKey) => {
					if (activeKey !== null) {
						cancelGraceDestroy()

						return
					}

					if (previousActiveKey !== null && AppState.currentState !== "active") {
						scheduleGraceDestroy()
					}
				}
			)

			defer(() => {
				appStateSubscription.remove()
				unsubscribePip()
			})

			defer(() => {
				cancelGraceDestroy()

				if (httpHandle) {
					httpHandle.uniffiDestroy()
					httpHandle = null
					useHttpStore.getState().setPort(null)
					useHttpStore.getState().setGetFileUrl(null)
				}
			})
		})

		return () => {
			cleanup()
		}
	}, [onAppStateChange])

	useEffectOnce(() => {
		// Mount ≠ foreground: an iOS cold background launch (BGProcessingTask) mounts the
		// tree with AppState "background" — starting the HTTP provider there holds a TCP
		// port for nothing during the background window. The AppState listener above
		// starts it on the real "active" transition instead.
		if (AppState.currentState === "active") {
			onAppStateChange("active").catch(e => logger.error("http", "HTTP provider failed on initial mount", { error: e }))
		}
	})

	return null
}

const Http = () => {
	const { authedSdkClient } = useSdkClients()

	if (!authedSdkClient) {
		return null
	}

	return <InnerHttp sdkClient={authedSdkClient} />
}

export default Http
