import { useEffect, useRef } from "react"
import { useTranslation } from "react-i18next"
import { router, usePathname } from "expo-router"
import { run } from "@filen/utils"
import useAccountQuery from "@/queries/useAccount.query"
import useAppStore from "@/stores/useApp.store"
import prompts from "@/lib/prompts"
import alerts from "@/lib/alerts"
import useIsAppActive from "@/hooks/useIsAppActive"

const AccountReminders = () => {
	const { t } = useTranslation()
	const accountQuery = useAccountQuery()
	const pathname = usePathname()
	const biometricUnlocked = useAppStore(state => state.biometricUnlocked)
	const isActive = useIsAppActive()
	const firedRef = useRef<boolean>(false)

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

		if (!isActive) {
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
					title: t("master_keys_reminder_title"),
					message: t("master_keys_reminder_message"),
					okText: t("export_now"),
					cancelText: t("later")
				})

				if (!masterKeysResult.cancelled) {
					router.push("/security")

					return
				}
			}

			if (data.storageUsed > data.maxStorage) {
				await prompts.info({
					title: t("storage_exceeded_title"),
					message: t("storage_exceeded_message"),
					okText: t("ok")
				})
			}
		}

		run(showReminders).then(result => {
			if (!result.success) {
				console.error(result.error)
				alerts.error(result.error)
			}
		})
	}, [pathname, biometricUnlocked, isActive, accountQuery.status, accountQuery.isFetching, accountQuery.data, t])

	return null
}

export default AccountReminders
