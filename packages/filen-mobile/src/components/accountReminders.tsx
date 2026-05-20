import { memo, useEffect, useRef, useState } from "react"
import { AppState, type AppStateStatus } from "react-native"
import { router, usePathname } from "expo-router"
import { run, runEffect } from "@filen/utils"
import useAccountQuery from "@/queries/useAccount.query"
import useAppStore from "@/stores/useApp.store"
import prompts from "@/lib/prompts"
import alerts from "@/lib/alerts"

const AccountReminders = memo(() => {
	const accountQuery = useAccountQuery()
	const pathname = usePathname()
	const biometricUnlocked = useAppStore(state => state.biometricUnlocked)
	const [appState, setAppState] = useState<AppStateStatus>(() => AppState.currentState)
	const firedRef = useRef<boolean>(false)

	useEffect(() => {
		const { cleanup } = runEffect(defer => {
			const subscription = AppState.addEventListener("change", nextAppState => {
				setAppState(nextAppState)
			})

			defer(() => {
				subscription.remove()
			})
		})

		return () => {
			cleanup()
		}
	}, [])

	useEffect(() => {
		if (firedRef.current) {
			return
		}

		if (!pathname.startsWith("/tabs/")) {
			return
		}

		if (biometricUnlocked !== true) {
			return
		}

		if (appState !== "active") {
			return
		}

		if (accountQuery.status !== "success" || accountQuery.isFetching || !accountQuery.data) {
			return
		}

		firedRef.current = true

		const data = accountQuery.data

		const showReminders = async (): Promise<void> => {
			if (!data.didExportMasterKeys) {
				const masterKeysResult = await prompts.alert({
					title: "tbd_master_keys_reminder_title",
					message: "tbd_master_keys_reminder_message",
					okText: "tbd_export_now",
					cancelText: "tbd_later"
				})

				if (!masterKeysResult.cancelled) {
					router.push("/security")

					return
				}
			}

			if (data.storageUsed > data.maxStorage) {
				await prompts.info({
					title: "tbd_storage_exceeded_title",
					message: "tbd_storage_exceeded_message",
					okText: "tbd_ok"
				})
			}
		}

		run(showReminders).then(result => {
			if (!result.success) {
				console.error(result.error)
				alerts.error(result.error)
			}
		})
	}, [pathname, biometricUnlocked, appState, accountQuery.status, accountQuery.isFetching, accountQuery.data])

	return null
})

AccountReminders.displayName = "AccountReminders"

export default AccountReminders
