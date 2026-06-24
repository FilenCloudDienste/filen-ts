import { Platform } from "react-native"
import notifee, { AndroidImportance, AndroidForegroundServiceType, AuthorizationStatus } from "react-native-notify-kit"
import { bpsToReadable } from "@filen/utils"
import i18n from "@/lib/i18n"
import secureStore from "@/lib/secureStore"
import { withSystemPresentation } from "@/lib/systemPresentation"
import logger from "@/lib/logger"

const CHANNEL_ID = "transfers"
const NOTIFICATION_ID = "filen-transfers-fgs"

// secureStore key for the "Background transfers" setting (Android only). Boolean; absent →
// DEFAULT_TRANSFERS_FOREGROUND_SERVICE_ENABLED (on). When off, start() never displays the
// foreground-service notification, so the OS no longer keeps backgrounded transfers alive.
// Read in start() (defense-in-depth for any programmatic caller) and consumed reactively by the
// Advanced settings toggle + the <ForegroundService /> host, which stops/starts the running
// service when the toggle flips mid-transfer.
export const TRANSFERS_FOREGROUND_SERVICE_ENABLED_SECURE_STORE_KEY = "transfersForegroundServiceEnabled"

export const DEFAULT_TRANSFERS_FOREGROUND_SERVICE_ENABLED = true

export type PermissionStatus = "authorized" | "denied" | "notDetermined" | "notAndroid"

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
				return new Promise<void>(() => {})
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

		const granted = await this.ensurePermission()

		if (!granted || signal?.aborted) {
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

	// `running` is a best-effort JS mirror of the OS foreground-service state, not a perfect one:
	// notifee's displayNotification resolving only means the start Intent was dispatched, and the OS
	// can tear the service down on its own (the DATA_SYNC FGS type timeout on a multi-hour transfer),
	// so the mirror can drift from reality in either direction (TC-11). The JS FSM can't observe those
	// native transitions, but it can stay resilient to its own failures: update() self-heals on a
	// rejected display (treats it as a dead/desynced service and clears `running` so the host's count
	// edge re-arms a fresh start()), and stop() always clears `running` even if the native teardown
	// throws, so a transient failure can never strand a permanent zombie that blocks future starts.
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

	// Whether the user has the "Background transfers" setting enabled. Absent → on by default,
	// preserving the prior always-run behavior.
	private async isEnabled(): Promise<boolean> {
		const value = await secureStore.get<boolean>(TRANSFERS_FOREGROUND_SERVICE_ENABLED_SECURE_STORE_KEY)

		return value ?? DEFAULT_TRANSFERS_FOREGROUND_SERVICE_ENABLED
	}

	private async ensurePermission(): Promise<boolean> {
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
