import { ScreenBody } from "@/components/ui/safeAreaView"
import { Group, type Button } from "@/components/ui/settingsGroup"
import { SettingsScrollView } from "@/components/ui/settingsScrollView"
import { Fragment, useState } from "react"
import { useLocalSearchParams } from "expo-router"
import { goBackIfPossible } from "@/lib/router"
import { COUNTRIES } from "@filen/shared"
import { useResolveClassNames } from "uniwind"
import SettingsHeader from "@/components/ui/settingsHeader"
import { type fetchData } from "@/queries/useAccount.query"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import { inputPrompt } from "@/lib/promptFlow"
import alerts from "@/lib/alerts"
import auth from "@/lib/auth"
import { deserializeRouteParam } from "@/lib/serializer"
import DismissStack from "@/components/dismissStack"
import { actionSheet } from "@/providers/actionSheet.provider"
import { useTranslation } from "react-i18next"
import useIsOnline from "@/hooks/useIsOnline"
import logger from "@/lib/logger"

type StringFieldKey = "firstName" | "lastName" | "companyName" | "vatId" | "street" | "streetNumber" | "city" | "postalCode"

function Personal() {
	const { personal: personalSerialized } = useLocalSearchParams<{
		personal?: string
	}>()
	const { t } = useTranslation()
	const textBlue500 = useResolveClassNames("text-blue-500")
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
				const value = await inputPrompt(
					{
						title,
						message,
						cancelText: t("cancel"),
						okText: t("save"),
						defaultValue: personalData[field] ?? undefined
					},
					{ tag: "settings", message: "personal info field prompt failed", context: { field } },
					{ trim: true }
				)

				if (value === null) {
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
				onDismiss={goBackIfPossible}
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
										logger.error("settings", "updatePersonalInfo failed", { error: result.error })
										alerts.error(result.error)

										return
									}
								}
							}
						}
					]
				}}
			/>
			<ScreenBody>
				<SettingsScrollView>
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
										buttons: COUNTRIES.map(country => ({
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
										}))
									})
								}
							}
						]}
					/>
				</SettingsScrollView>
			</ScreenBody>
		</Fragment>
	)
}

export default Personal
