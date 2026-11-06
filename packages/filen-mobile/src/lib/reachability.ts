import { AppState } from "react-native"
import { REACHABILITY_PROBE } from "@/constants"
import { computeOnline } from "@/lib/connectivity"
import connectionTrust from "@/lib/connectionTrust"
import logger from "@/lib/logger"
import useSocketStore from "@/stores/useSocket.store"

/**
 * What one probe learned. "reachable": Filen answered over a verified connection (any answer, an API
 * error included). "unreachable": no answer (connect failure, timeout, transport error). "unverified":
 * the TLS handshake rejected Filen's certificate. "inconclusive": nothing about the network (the probe
 * could not run), so the state is left as it was.
 */
export type ProbeOutcome = "reachable" | "unreachable" | "unverified" | "inconclusive"

export type ReachabilityProbe = (signal: AbortSignal) => Promise<ProbeOutcome>

/**
 * Whether Filen is reachable, as the SDK sees it: the probe is an SDK request, so it goes through the
 * same certificate verifier as all real traffic, and a certificate the SDK rejects is its own state
 * ("unverified") instead of offline. NetInfo only contributes whether a network interface is up.
 *
 * Requests are kept to what nothing else answers. An authenticated socket is a live verified
 * connection, so while it is up there is no probe; a probe is asked for by evidence (a request failing
 * on the network or on the certificate, the socket dropping, the network changing, the app coming to
 * the foreground) and re-checked on an interval only while the answer can change unseen: offline or
 * unverified, or online in the foreground without a socket. Never more than one in flight, and probes
 * asked for by evidence are spaced by REACHABILITY_PROBE.minGapMs.
 *
 * Also owns `connectionTrust` for the probe's own answers: marks it on "unverified", clears it on
 * "reachable" (a verified round trip), on "unreachable" and when the interface goes down (the next
 * network is unproven). The probe itself is registered by the SDK client owner (auth), so this module
 * does not pull the SDK into the boot path.
 *
 * The same evidence that the network may be back (a network interface coming up or changing, the app
 * coming to the foreground, Filen answering again) asks the SDK to cut its socket's reconnect backoff
 * short, through the hook auth registers, while no authenticated socket is up.
 */
export class Reachability {
	private interfaceConnected: boolean | null = null
	private interfaceType: string | null = null
	private reachable: boolean | null = null
	private online = true
	private active = true
	private started = false
	private probe: ReachabilityProbe | null = null
	private reconnectSocket: (() => void) | null = null
	private probePending = false
	private inFlight = false
	private lastProbeAt: number | null = null
	private timer: ReturnType<typeof setTimeout> | null = null
	private readonly listeners = new Set<(online: boolean) => void>()

	public isOnline(): boolean {
		return computeOnline(this.interfaceConnected, this.reachable)
	}

	/** The probe's last answer: true reachable, false unreachable or unverified, null not known yet. */
	public getReachable(): boolean | null {
		return this.reachable
	}

	/** Called with the new value on every online/offline flip. */
	public subscribe(listener: (online: boolean) => void): () => void {
		this.listeners.add(listener)

		return () => {
			this.listeners.delete(listener)
		}
	}

	public setProbe(probe: ReachabilityProbe): void {
		this.probe = probe

		if (this.probePending) {
			this.probePending = false

			this.requestProbe()
		}
	}

	public setSocketReconnect(reconnect: () => void): void {
		this.reconnectSocket = reconnect
	}

	/** Subscribes to the app state, the socket and the certificate state. Idempotent. */
	public start(): void {
		if (this.started) {
			return
		}

		this.started = true
		this.active = AppState.currentState === "active"

		AppState.addEventListener("change", nextAppState => {
			const active = nextAppState === "active"

			if (active === this.active) {
				return
			}

			this.active = active

			if (active) {
				this.networkMayBeBack()
				this.requestProbe()

				return
			}

			this.schedule()
		})

		useSocketStore.subscribe((state, prev) => {
			const connected = state.state === "connected"

			if (connected === (prev.state === "connected")) {
				return
			}

			if (connected) {
				// An authenticated socket is a verified round trip to Filen.
				this.apply("reachable")
				this.schedule()

				return
			}

			// Torn down for the background is not news about the network.
			if (this.active) {
				this.requestProbe()
			}
		})

		// A certificate failure seen by real traffic while believed reachable: find out whether the
		// network now in use serves one for every request. The probe's own mark comes with reachable
		// already false, so it never asks for another.
		connectionTrust.subscribe(() => {
			if (connectionTrust.isUnverified() && this.reachable !== false) {
				this.requestProbe()
			}
		})

		if (this.active) {
			this.requestProbe()
		}
	}

	/** NetInfo's interface state. A change of network asks for a probe; no interface sends none. */
	public setInterface(isConnected: boolean | null, type: string | null): void {
		if (isConnected === this.interfaceConnected && type === this.interfaceType) {
			return
		}

		this.interfaceConnected = isConnected
		this.interfaceType = type

		if (isConnected === false) {
			this.cancelTimer()
			connectionTrust.clear()
			this.emit()

			return
		}

		this.emit()

		if (isConnected === true) {
			this.networkMayBeBack()
		}

		this.requestProbe()
	}

	/** Asks for a probe as soon as the spacing allows. One already in flight answers it. */
	public requestProbe(): void {
		if (this.interfaceConnected === false || this.inFlight) {
			return
		}

		if (!this.probe) {
			this.probePending = true

			return
		}

		const wait = this.lastProbeAt === null ? 0 : this.lastProbeAt + REACHABILITY_PROBE.minGapMs - Date.now()

		// A probe due inside the gap is due at its end: the periodic intervals are all longer than it.
		if (wait > 0) {
			this.setTimer(wait)

			return
		}

		this.run(this.probe)
	}

	private run(probe: ReachabilityProbe): void {
		this.cancelTimer()

		this.inFlight = true
		this.lastProbeAt = Date.now()

		const controller = new AbortController()
		const timeout = setTimeout(() => {
			controller.abort()
		}, REACHABILITY_PROBE.timeoutMs)

		probe(controller.signal)
			.catch((e: unknown): ProbeOutcome => {
				logger.warn("reachability", "probe threw", { error: e })

				return "inconclusive"
			})
			.then(outcome => {
				clearTimeout(timeout)

				this.inFlight = false

				// A probe cut off by the timeout got no answer in time, whatever it reported for the abort.
				this.apply(controller.signal.aborted && outcome === "inconclusive" ? "unreachable" : outcome)
				this.schedule()
			})
			.catch((e: unknown) => {
				logger.error("reachability", "applying the probe outcome failed", { error: e })
			})
	}

	private apply(outcome: ProbeOutcome): void {
		// The interface went down while the probe ran: its answer is about a network that is gone.
		if (outcome === "inconclusive" || this.interfaceConnected === false) {
			return
		}

		const prevReachable = this.reachable

		if (outcome === "unverified") {
			// reachable first, so the trust listener sees it and asks for no second probe.
			this.reachable = false
			connectionTrust.markUnverified()
		} else {
			this.reachable = outcome === "reachable"
			connectionTrust.clear()
		}

		if (this.reachable !== prevReachable) {
			logger.info("reachability", "changed", { outcome })

			// Back from unreachable or unverified; the first answer after launch is no return.
			if (this.reachable && prevReachable === false) {
				this.networkMayBeBack()
			}
		}

		this.emit()
	}

	// A connected socket has nothing to cut short; otherwise the SDK ignores the call while it has no socket
	// (signed out, or in the background, which closes it) and coalesces a burst into one attempt.
	private networkMayBeBack(): void {
		if (this.reconnectSocket && useSocketStore.getState().state !== "connected") {
			this.reconnectSocket()
		}
	}

	// The periodic re-check, only while the answer can change unseen.
	private schedule(): void {
		if (this.inFlight || this.interfaceConnected === false) {
			return
		}

		if (this.reachable === true && (!this.active || useSocketStore.getState().state === "connected")) {
			this.cancelTimer()

			return
		}

		this.setTimer(this.reachable === true ? REACHABILITY_PROBE.reachableIntervalMs : REACHABILITY_PROBE.unreachableIntervalMs)
	}

	private setTimer(delayMs: number): void {
		this.cancelTimer()

		this.timer = setTimeout(() => {
			this.timer = null

			if (this.probe && !this.inFlight && this.interfaceConnected !== false) {
				this.run(this.probe)
			}
		}, delayMs)
	}

	private cancelTimer(): void {
		if (this.timer !== null) {
			clearTimeout(this.timer)

			this.timer = null
		}
	}

	private emit(): void {
		const online = this.isOnline()

		if (online === this.online) {
			return
		}

		this.online = online

		for (const listener of this.listeners) {
			listener(online)
		}
	}
}

const reachability = new Reachability()

export default reachability
