import { Platform } from "react-native"
import notifee, { AndroidImportance, AndroidForegroundServiceType, AuthorizationStatus } from "react-native-notify-kit"
import { bpsToReadable } from "@filen/utils"

const CHANNEL_ID = "transfers"
const CHANNEL_NAME = "Transfers"
const NOTIFICATION_ID = "filen-transfers-fgs"

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
				name: CHANNEL_NAME,
				importance: AndroidImportance.LOW
			})
		})()

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

	public async update(progress: TransferProgressSnapshot): Promise<void> {
		if (Platform.OS !== "android" || !this.running) {
			return
		}

		await this.display(progress)
	}

	public async stop(): Promise<void> {
		if (Platform.OS !== "android" || !this.running) {
			return
		}

		this.running = false

		await notifee.stopForegroundService()
	}

	private async ensurePermission(): Promise<boolean> {
		const status = await this.getStatus()

		if (status === "authorized") {
			return true
		}

		if (status === "notAndroid" || status === "denied" || this.deniedThisSession) {
			return false
		}

		const settings = await notifee.requestPermission()
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
		const body =
			count === 1 ? `1 transfer · ${percent}% · ${speedText}` : `${count} transfers · ${percent}% · ${speedText}`

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
