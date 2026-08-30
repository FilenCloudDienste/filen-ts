import { Platform, AppState } from "react-native"
import notifee, { AndroidImportance, AndroidForegroundServiceType, AuthorizationStatus } from "react-native-notify-kit"
import { bpsToReadable } from "@filen/utils"
import i18n from "@/lib/i18n"
import secureStore from "@/lib/secureStore"
import { withSystemPresentation } from "@/lib/systemPresentation"
import logger from "@/lib/logger"

const CHANNEL_ID = "transfers"
const NOTIFICATION_ID = "filen-transfers-fgs"

// notifee posts this when Android tears the foreground service down for exceeding its type's time
// budget — on Android 15+ dataSync is capped at 6 hours per 24, after which the OS both stops the
// service and REJECTS further starts until the app is foregrounded again. It arrives as a raw type
// id because notifee's own EventType enum stops at FG_ALREADY_EXIST (8), so it is matched
// numerically. Without it `running` would keep claiming a service that no longer exists.
const FOREGROUND_SERVICE_TIMEOUT_EVENT_TYPE = 9

// secureStore key for the "Background transfers" setting (Android only). Boolean; absent →
// DEFAULT_TRANSFERS_FOREGROUND_SERVICE_ENABLED (on). When off, start() never displays the
// foreground-service notification, so the OS no longer keeps backgrounded transfers alive.
// Read in start() (defense-in-depth for any programmatic caller) and consumed reactively by the
// Advanced settings toggle + the <ForegroundService /> host, which stops/starts the running
// service when the toggle flips mid-transfer.
export const TRANSFERS_FOREGROUND_SERVICE_ENABLED_SECURE_STORE_KEY = "transfersForegroundServiceEnabled"

export const DEFAULT_TRANSFERS_FOREGROUND_SERVICE_ENABLED = true

export type PermissionStatus = "authorized" | "denied" | "notDetermined" | "notAndroid"

// Whether the "Background transfers" setting is on but the OS notification permission is denied — i.e. the
// toggle is enabled yet the foreground service cannot start (Android needs POST_NOTIFICATIONS to display the
// FGS notification, and start() gates on it). Drives the Advanced screen's warning + open-settings affordance.
// `notDetermined` is NOT a gap — start() prompts for it.
export function backgroundTransfersNotificationGap(enabled: boolean, status: PermissionStatus): boolean {
	return enabled && status === "denied"
}

export type TransferProgressSnapshot = {
	count: number
	progress: number
	speed: number
}

class ForegroundService {
	private initPromise: Promise<void> | null = null
	private running = false
	private deniedThisSession = false

	public init(): Promise<void> {
		if (Platform.OS !== "android") {
			return Promise.resolve()
		}

		if (this.initPromise) {
			return this.initPromise
		}

		this.initPromise = (async () => {
			notifee.registerForegroundService(() => {
				return new Promise<void>(() => {
					// Keep the foreground service alive until stopForegroundService() is called.
					// The promise never resolves, so the service never stops on its own.
					// The host's running mirror is cleared when stopForegroundService() is called (or if it throws), so the host can re-arm a fresh start() on the next count/foreground edge.
					;(async () => {
						while (this.running) {
							await new Promise(resolve => setTimeout(resolve, 1000))
						}
					})()
				})
			})

			// The ongoing transfers notification emits events (e.g. dismissal) while the app is backgrounded.
			// notifee requires a background-event handler for these or it logs a warning and drops them. The
			// notification has no actions, so the only event worth acting on is the service timing out.
			notifee.onBackgroundEvent(async ({ type }) => {
				this.handleNotifeeEvent(type)
			})

			notifee.onForegroundEvent(({ type }) => {
				this.handleNotifeeEvent(type)
			})

			await notifee.createChannel({
				id: CHANNEL_ID,
				name: i18n.t("transfers_channel_name"),
				importance: AndroidImportance.LOW
			})
		})().catch(err => {
			logger.error("transfers-fgs", "Foreground service init failed", { error: err })

			this.initPromise = null

			throw err
		})

		return this.initPromise
	}

	public async getStatus(): Promise<PermissionStatus> {
		if (Platform.OS !== "android") {
			return "notAndroid"
		}

		await this.init()

		const settings = await notifee.getNotificationSettings()

		switch (settings.authorizationStatus) {
			case AuthorizationStatus.AUTHORIZED:
			case AuthorizationStatus.PROVISIONAL:
				return "authorized"
			case AuthorizationStatus.DENIED:
				return "denied"
			default:
				return "notDetermined"
		}
	}

	public async openSettings(): Promise<void> {
		if (Platform.OS !== "android") {
			return
		}

		await notifee.openNotificationSettings()
	}

	public async start(progress: TransferProgressSnapshot, signal?: AbortSignal): Promise<void> {
		if (Platform.OS !== "android" || signal?.aborted) {
			return
		}

		if (!(await this.isEnabled()) || signal?.aborted) {
			return
		}

		await this.init()

		if (signal?.aborted) {
			return
		}

		const granted = await this.requestPermission()

		if (!granted || signal?.aborted) {
			return
		}

		// The app may have backgrounded during the awaits above (isEnabled / init / requestPermission).
		// Starting the foreground service from the background risks the UNCATCHABLE
		// ForegroundServiceDidNotStartInTimeException — a frozen process never runs onStartCommand
		// before the OS promotion deadline (30s, plus a 10s ANR grace) and is then killed
		// asynchronously, where no try/catch can intercept it. Bail if we're no longer active; the
		// host's AppState→active handler re-attempts start() on the next foreground, where promotion
		// is safe. This is the last line of defense even if a caller forgets to gate on foreground.
		if (AppState.currentState !== "active") {
			return
		}

		await this.display(progress)

		this.running = true
	}

	// Whether the foreground-service notification is currently displayed. Used by the host to retry
	// start() when the app returns to the foreground after a background-start was rejected (TC-10):
	// on Android 12+ starting a foreground service from the background throws, so start() rejects and
	// `running` stays false — the host re-attempts once it is foreground (where the start is allowed).
	public isRunning(): boolean {
		return this.running
	}

	// `running` mirrors the OS foreground-service state across three signals, because a display
	// resolving only means the start Intent was dispatched — it never proves the service is alive:
	//   - the OS timing the DATA_SYNC type out is observed via handleNotifeeEvent, the one teardown
	//     the platform actually announces;
	//   - a rejected display is treated as a dead/desynced service here, clearing `running` so the
	//     host's count edge re-arms a fresh start();
	//   - stop() clears `running` even if the native teardown throws, so a transient failure can
	//     never strand a zombie that blocks every future start.
	// Displays against a LIVE service no longer re-enter startForegroundService() at all — the
	// react-native-notify-kit patch refreshes the notification in place — so an update can only
	// reach a start once the service is already gone, which is exactly what the signals above
	// prevent while backgrounded.
	public async update(progress: TransferProgressSnapshot): Promise<void> {
		if (Platform.OS !== "android" || !this.running) {
			return
		}

		try {
			await this.display(progress)
		} catch (err) {
			// A reissued display can be rejected if the service is no longer live (OS timeout) or if
			// the app is backgrounded (background-start rejection). Drop the stale `running` mirror so
			// the host re-attempts start() on the next count/foreground edge instead of looping updates
			// against a dead service.
			logger.warn("transfers-fgs", "Foreground service update failed; clearing running state to allow re-arm", {
				error: err
			})

			this.running = false
		}
	}

	public async stop(): Promise<void> {
		if (Platform.OS !== "android" || !this.running) {
			return
		}

		// Clear the mirror unconditionally: even if stopForegroundService() throws, the JS FSM must not
		// keep believing a service is live (that would block every future start() and update() forever).
		this.running = false

		try {
			await notifee.stopForegroundService()
		} catch (err) {
			logger.warn("transfers-fgs", "Foreground service stop failed", {
				error: err
			})
		}
	}

	// The one notifee event this service acts on: Android timing the foreground service out. The OS
	// has already stopped the service by the time this arrives, so the mirror must drop with it —
	// otherwise update() would keep displaying against a dead service, and each of those displays
	// would ask notifee to start a fresh one from the background, which Android answers by killing
	// the process. Clearing here lets the host re-arm from the foreground instead, where a start is
	// both permitted and resets the OS time budget.
	private handleNotifeeEvent(type: number): void {
		if (type !== FOREGROUND_SERVICE_TIMEOUT_EVENT_TYPE || !this.running) {
			return
		}

		logger.warn("transfers-fgs", "Android timed the foreground service out; clearing running state to allow re-arm")

		this.running = false
	}

	// Whether the user has the "Background transfers" setting enabled. Absent → on by default,
	// preserving the prior always-run behavior.
	private async isEnabled(): Promise<boolean> {
		const value = await secureStore.get<boolean>(TRANSFERS_FOREGROUND_SERVICE_ENABLED_SECURE_STORE_KEY)

		return value ?? DEFAULT_TRANSFERS_FOREGROUND_SERVICE_ENABLED
	}

	public async requestPermission(): Promise<boolean> {
		const status = await this.getStatus()

		if (status === "authorized") {
			return true
		}

		if (status === "notAndroid" || status === "denied" || this.deniedThisSession) {
			return false
		}

		const settings = await withSystemPresentation(() => notifee.requestPermission())
		const granted =
			settings.authorizationStatus === AuthorizationStatus.AUTHORIZED ||
			settings.authorizationStatus === AuthorizationStatus.PROVISIONAL

		if (!granted) {
			this.deniedThisSession = true
		}

		return granted
	}

	private async display(progress: TransferProgressSnapshot): Promise<void> {
		const { count, progress: ratio, speed } = progress
		const percent = Math.round(ratio * 100)
		const speedText = speed > 0 ? bpsToReadable(speed) : "—"
		// `count` stays a number so i18next selects the right plural form; `percent` is passed as a
		// string because i18next's TS types collapse the interpolation overload once a key has 3+
		// variables and one is numeric — stringifying it keeps the call fully typed.
		const body = i18n.t("transfers_progress", {
			count,
			percent: percent.toString(),
			speed: speedText
		})

		await notifee.displayNotification({
			id: NOTIFICATION_ID,
			title: "Filen",
			body,
			android: {
				channelId: CHANNEL_ID,
				asForegroundService: true,
				foregroundServiceTypes: [AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_DATA_SYNC],
				ongoing: true,
				onlyAlertOnce: true,
				progress: {
					max: 100,
					current: Math.max(0, Math.min(100, percent)),
					indeterminate: count > 0 && ratio === 0
				}
			}
		})
	}
}

const foregroundService = new ForegroundService()

export default foregroundService
