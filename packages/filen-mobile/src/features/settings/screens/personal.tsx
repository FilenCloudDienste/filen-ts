import SafeAreaView from "@/components/ui/safeAreaView"
import { Group, type Button } from "@/components/ui/settingsGroup"
import { GestureHandlerScrollView } from "@/components/ui/view"
import { Fragment, useState } from "react"
import { router, useLocalSearchParams } from "expo-router"
import { run } from "@filen/utils"
import { useResolveClassNames } from "uniwind"
import SettingsHeader from "@/components/ui/settingsHeader"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { type fetchData } from "@/queries/useAccount.query"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import prompts from "@/lib/prompts"
import alerts from "@/lib/alerts"
import auth from "@/lib/auth"
import { deserializeRouteParam } from "@/lib/serializer"
import DismissStack from "@/components/dismissStack"
import { actionSheet } from "@/providers/actionSheet.provider"
import { useTranslation } from "react-i18next"
import { countries } from "@/features/settings/constants"
import useIsOnline from "@/hooks/useIsOnline"

type StringFieldKey = "firstName" | "lastName" | "companyName" | "vatId" | "street" | "streetNumber" | "city" | "postalCode"

function Personal() {
	const { personal: personalSerialized } = useLocalSearchParams<{
		personal?: string
	}>()
	const { t } = useTranslation()
	const textBlue500 = useResolveClassNames("text-blue-500")
	const insets = useSafeAreaInsets()
	const [personal, setPersonal] = useState<Awaited<ReturnType<typeof fetchData>>["personal"] | null>(
		deserializeRouteParam<Awaited<ReturnType<typeof fetchData>>["personal"]>(personalSerialized)
	)
	const [modified, setModified] = useState<boolean>(false)
	const isOnline = useIsOnline()

	if (!personal) {
		return <DismissStack />
	}

	const personalData = personal

	const makeFieldButton = ({ field, title, message }: { field: StringFieldKey; title: string; message: string }): Button => {
		return {
			title,
			subTitle: personalData[field] ?? t("not_set"),
			subTitleNumberOfLines: 1,
			onPress: async () => {
				const promptResult = await run(async () => {
					return await prompts.input({
						title,
						message,
						cancelText: t("cancel"),
						okText: t("save"),
						defaultValue: personalData[field] ?? undefined
					})
				})

				if (!promptResult.success) {
					console.error(promptResult.error)
					alerts.error(promptResult.error)

					return
				}

				if (promptResult.data.cancelled || promptResult.data.type !== "string") {
					return
				}

				const value = promptResult.data.value.trim()

				if (value.length === 0) {
					return
				}

				setModified(true)
				setPersonal(prev => {
					if (!prev) {
						return prev
					}

					return {
						...prev,
						[field]: value
					}
				})
			}
		}
	}

	return (
		<Fragment>
			<SettingsHeader
				title={t("personal_information")}
				icon="chevron-back-outline"
				onDismiss={() => {
					if (router.canGoBack()) {
						router.back()
					}
				}}
				rightItems={() => {
					if (!modified || !isOnline) {
						return null
					}

					return [
						{
							type: "button",
							icon: {
								name: "checkmark",
								color: textBlue500.color,
								size: 20
							},
							props: {
								onPress: async () => {
									const result = await runWithLoading(async () => {
										const { authedSdkClient } = await auth.getSdkClients()

										await authedSdkClient.updatePersonalInfo(personal)
									})

									if (!result.success) {
										console.error(result.error)
										alerts.error(result.error)

										return
									}
								}
							}
						}
					]
				}}
			/>
			<SafeAreaView
				className="flex-1 bg-background-secondary"
				edges={["left", "right"]}
			>
				<GestureHandlerScrollView
					className="bg-transparent flex-1"
					contentInsetAdjustmentBehavior="automatic"
					contentContainerClassName="px-4 gap-4"
					showsHorizontalScrollIndicator={false}
					contentContainerStyle={{
						paddingBottom: insets.bottom
					}}
				>
					<Group
						className="bg-background-tertiary"
						buttons={[
							makeFieldButton({
								field: "firstName",
								title: t("first_name"),
								message: t("enter_new_first_name")
							}),
							makeFieldButton({
								field: "lastName",
								title: t("last_name"),
								message: t("enter_new_last_name")
							}),
							makeFieldButton({
								field: "companyName",
								title: t("company_name"),
								message: t("enter_new_company_name")
							}),
							makeFieldButton({
								field: "vatId",
								title: t("vat_id"),
								message: t("enter_new_vat_id")
							}),
							makeFieldButton({
								field: "street",
								title: t("street"),
								message: t("enter_new_street")
							}),
							makeFieldButton({
								field: "streetNumber",
								title: t("street_number"),
								message: t("enter_new_street_number")
							}),
							makeFieldButton({
								field: "city",
								title: t("city"),
								message: t("enter_new_city")
							}),
							makeFieldButton({
								field: "postalCode",
								title: t("postal_code"),
								message: t("enter_new_postal_code")
							}),
							{
								title: t("country"),
								subTitle: personal.country ?? t("not_set"),
								subTitleNumberOfLines: 1,
								onPress: () => {
									actionSheet.show({
										buttons: [
											...countries.map(country => ({
												title: country,
												onPress: () => {
													setModified(true)
													setPersonal(prev => {
														if (!prev) {
															return prev
														}

														return {
															...prev,
															country
														}
													})
												}
											})),
											{
												title: t("close"),
												cancel: true
											}
										]
									})
								}
							}
						]}
					/>
				</GestureHandlerScrollView>
			</SafeAreaView>
		</Fragment>
	)
}

export default Personal
