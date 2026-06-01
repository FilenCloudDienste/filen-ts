import SafeAreaView from "@/components/ui/safeAreaView"
import { Group } from "@/routes/tabs/more"
import { GestureHandlerScrollView } from "@/components/ui/view"
import { Fragment, memo, useState } from "react"
import { router, useLocalSearchParams } from "expo-router"
import { run } from "@filen/utils"
import { useResolveClassNames } from "uniwind"
import Header from "@/components/ui/header"
import { Platform } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { type fetchData } from "@/queries/useAccount.query"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import prompts from "@/lib/prompts"
import alerts from "@/lib/alerts"
import auth from "@/lib/auth"
import { deserialize } from "@/lib/serializer"
import DismissStack from "@/components/dismissStack"
import { actionSheet } from "@/providers/actionSheet.provider"
import { useTranslation } from "react-i18next"

// The account API stores the country as a plain English name string (no ISO 3166 region code),
// so these cannot be localized via Intl.DisplayNames — they stay a non-translated constant array.
const countries: string[] = [
	"Afghanistan",
	"Albania",
	"Algeria",
	"Andorra",
	"Angola",
	"Antigua and Barbuda",
	"Argentina",
	"Armenia",
	"Australia",
	"Austria",
	"Azerbaijan",
	"Bahamas",
	"Bahrain",
	"Bangladesh",
	"Barbados",
	"Belarus",
	"Belgium",
	"Belize",
	"Benin",
	"Bhutan",
	"Bolivia",
	"Bosnia and Herzegovina",
	"Botswana",
	"Brazil",
	"Brunei",
	"Bulgaria",
	"Burkina Faso",
	"Burundi",
	"Cabo Verde",
	"Cambodia",
	"Cameroon",
	"Canada",
	"Central African Republic",
	"Chad",
	"Chile",
	"China",
	"Colombia",
	"Comoros",
	"Democratic Republic of the Congo",
	"Republic of the Congo",
	"Costa Rica",
	"Cote d'Ivoire",
	"Croatia",
	"Cuba",
	"Cyprus",
	"Czech Republic",
	"Denmark",
	"Djibouti",
	"Dominica",
	"Dominican Republic",
	"Ecuador",
	"Egypt",
	"El Salvador",
	"Equatorial Guinea",
	"Eritrea",
	"Estonia",
	"Eswatini",
	"Ethiopia",
	"Fiji",
	"Finland",
	"France",
	"Gabon",
	"Gambia",
	"Georgia",
	"Germany",
	"Ghana",
	"Greece",
	"Grenada",
	"Guatemala",
	"Guinea",
	"Guinea-Bissau",
	"Guyana",
	"Haiti",
	"Honduras",
	"Hungary",
	"Iceland",
	"India",
	"Indonesia",
	"Iran",
	"Iraq",
	"Ireland",
	"Israel",
	"Italy",
	"Jamaica",
	"Japan",
	"Jordan",
	"Kazakhstan",
	"Kenya",
	"Kiribati",
	"North Korea",
	"South Korea",
	"Kosovo",
	"Kuwait",
	"Kyrgyzstan",
	"Laos",
	"Latvia",
	"Lebanon",
	"Lesotho",
	"Liberia",
	"Libya",
	"Liechtenstein",
	"Lithuania",
	"Luxembourg",
	"Madagascar",
	"Malawi",
	"Malaysia",
	"Maldives",
	"Mali",
	"Malta",
	"Marshall Islands",
	"Mauritania",
	"Mauritius",
	"Mexico",
	"Micronesia",
	"Moldova",
	"Monaco",
	"Mongolia",
	"Montenegro",
	"Morocco",
	"Mozambique",
	"Myanmar",
	"Namibia",
	"Nauru",
	"Nepal",
	"Netherlands",
	"New Zealand",
	"Nicaragua",
	"Niger",
	"Nigeria",
	"North Macedonia",
	"Norway",
	"Oman",
	"Pakistan",
	"Palau",
	"Palestine",
	"Panama",
	"Papua New Guinea",
	"Paraguay",
	"Peru",
	"Philippines",
	"Poland",
	"Portugal",
	"Qatar",
	"Romania",
	"Russia",
	"Rwanda",
	"Saint Kitts and Nevis",
	"Saint Lucia",
	"Saint Vincent and the Grenadines",
	"Samoa",
	"San Marino",
	"Sao Tome and Principe",
	"Saudi Arabia",
	"Senegal",
	"Serbia",
	"Seychelles",
	"Sierra Leone",
	"Singapore",
	"Slovakia",
	"Slovenia",
	"Solomon Islands",
	"Somalia",
	"South Africa",
	"South Sudan",
	"Spain",
	"Sri Lanka",
	"Sudan",
	"Suriname",
	"Sweden",
	"Switzerland",
	"Syria",
	"Taiwan",
	"Tajikistan",
	"Tanzania",
	"Thailand",
	"Timor-Leste",
	"Togo",
	"Tonga",
	"Trinidad and Tobago",
	"Tunisia",
	"Turkey",
	"Turkmenistan",
	"Tuvalu",
	"Uganda",
	"Ukraine",
	"United Arab Emirates",
	"United Kingdom",
	"United States",
	"Uruguay",
	"Uzbekistan",
	"Vanuatu",
	"Vatican City",
	"Venezuela",
	"Vietnam",
	"Yemen",
	"Zambia",
	"Zimbabwe"
].sort((a, b) => a.localeCompare(b))

const Personal = memo(() => {
	const { personal: personalSerialized } = useLocalSearchParams<{
		personal?: string
	}>()
	const { t } = useTranslation()
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const textForeground = useResolveClassNames("text-foreground")
	const textBlue500 = useResolveClassNames("text-blue-500")
	const insets = useSafeAreaInsets()
	const [personal, setPersonal] = useState<Awaited<ReturnType<typeof fetchData>>["personal"] | null>(
		(() => {
			if (!personalSerialized) {
				return null
			}

			try {
				const deserialized = deserialize(personalSerialized) as Awaited<ReturnType<typeof fetchData>>["personal"]

				return deserialized
			} catch {
				return null
			}
		})()
	)
	const [modified, setModified] = useState<boolean>(false)

	if (!personal) {
		return <DismissStack />
	}

	return (
		<Fragment>
			<Header
				title={t("personal_information")}
				transparent={Platform.OS === "ios"}
				shadowVisible={false}
				backVisible={Platform.OS === "android"}
				backgroundColor={Platform.select({
					ios: undefined,
					default: bgBackgroundSecondary.backgroundColor as string
				})}
				leftItems={() => {
					if (Platform.OS === "android") {
						return null
					}

					return [
						{
							type: "button",
							icon: {
								name: "chevron-back-outline",
								color: textForeground.color,
								size: 20
							},
							props: {
								onPress: () => {
									if (router.canGoBack()) {
										router.back()
									}
								}
							}
						}
					]
				}}
				rightItems={() => {
					if (!modified) {
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
							{
								title: t("first_name"),
								subTitle: personal.firstName ?? t("not_set"),
								onPress: async () => {
									const promptResult = await run(async () => {
										return await prompts.input({
											title: t("first_name"),
											message: t("enter_new_first_name"),
											cancelText: t("cancel"),
											okText: t("save"),
											defaultValue: personal.firstName ?? undefined
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

									const firstName = promptResult.data.value.trim()

									if (firstName.length === 0) {
										return
									}

									setModified(true)
									setPersonal(prev => {
										if (!prev) {
											return prev
										}

										return {
											...prev,
											firstName
										}
									})
								}
							},
							{
								title: t("last_name"),
								subTitle: personal.lastName ?? t("not_set"),
								onPress: async () => {
									const promptResult = await run(async () => {
										return await prompts.input({
											title: t("last_name"),
											message: t("enter_new_last_name"),
											cancelText: t("cancel"),
											okText: t("save"),
											defaultValue: personal.lastName ?? undefined
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

									const lastName = promptResult.data.value.trim()

									if (lastName.length === 0) {
										return
									}

									setModified(true)
									setPersonal(prev => {
										if (!prev) {
											return prev
										}

										return {
											...prev,
											lastName
										}
									})
								}
							},
							{
								title: t("company_name"),
								subTitle: personal.companyName ?? t("not_set"),
								onPress: async () => {
									const promptResult = await run(async () => {
										return await prompts.input({
											title: t("company_name"),
											message: t("enter_new_company_name"),
											cancelText: t("cancel"),
											okText: t("save"),
											defaultValue: personal.companyName ?? undefined
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

									const companyName = promptResult.data.value.trim()

									if (companyName.length === 0) {
										return
									}

									setModified(true)
									setPersonal(prev => {
										if (!prev) {
											return prev
										}

										return {
											...prev,
											companyName
										}
									})
								}
							},
							{
								title: t("vat_id"),
								subTitle: personal.vatId ?? t("not_set"),
								onPress: async () => {
									const promptResult = await run(async () => {
										return await prompts.input({
											title: t("vat_id"),
											message: t("enter_new_vat_id"),
											cancelText: t("cancel"),
											okText: t("save"),
											defaultValue: personal.vatId ?? undefined
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

									const vatId = promptResult.data.value.trim()

									if (vatId.length === 0) {
										return
									}

									setModified(true)
									setPersonal(prev => {
										if (!prev) {
											return prev
										}

										return {
											...prev,
											vatId
										}
									})
								}
							},
							{
								title: t("street"),
								subTitle: personal.street ?? t("not_set"),
								onPress: async () => {
									const promptResult = await run(async () => {
										return await prompts.input({
											title: t("street"),
											message: t("enter_new_street"),
											cancelText: t("cancel"),
											okText: t("save"),
											defaultValue: personal.street ?? undefined
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

									const street = promptResult.data.value.trim()

									if (street.length === 0) {
										return
									}

									setModified(true)
									setPersonal(prev => {
										if (!prev) {
											return prev
										}

										return {
											...prev,
											street
										}
									})
								}
							},
							{
								title: t("street_number"),
								subTitle: personal.streetNumber ?? t("not_set"),
								onPress: async () => {
									const promptResult = await run(async () => {
										return await prompts.input({
											title: t("street_number"),
											message: t("enter_new_street_number"),
											cancelText: t("cancel"),
											okText: t("save"),
											defaultValue: personal.streetNumber ?? undefined
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

									const streetNumber = promptResult.data.value.trim()

									if (streetNumber.length === 0) {
										return
									}

									setModified(true)
									setPersonal(prev => {
										if (!prev) {
											return prev
										}

										return {
											...prev,
											streetNumber
										}
									})
								}
							},
							{
								title: t("city"),
								subTitle: personal.city ?? t("not_set"),
								onPress: async () => {
									const promptResult = await run(async () => {
										return await prompts.input({
											title: t("city"),
											message: t("enter_new_city"),
											cancelText: t("cancel"),
											okText: t("save"),
											defaultValue: personal.city ?? undefined
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

									const city = promptResult.data.value.trim()

									if (city.length === 0) {
										return
									}

									setModified(true)
									setPersonal(prev => {
										if (!prev) {
											return prev
										}

										return {
											...prev,
											city
										}
									})
								}
							},
							{
								title: t("postal_code"),
								subTitle: personal.postalCode ?? t("not_set"),
								onPress: async () => {
									const promptResult = await run(async () => {
										return await prompts.input({
											title: t("postal_code"),
											message: t("enter_new_postal_code"),
											cancelText: t("cancel"),
											okText: t("save"),
											defaultValue: personal.postalCode ?? undefined
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

									const postalCode = promptResult.data.value.trim()

									if (postalCode.length === 0) {
										return
									}

									setModified(true)
									setPersonal(prev => {
										if (!prev) {
											return prev
										}

										return {
											...prev,
											postalCode
										}
									})
								}
							},
							{
								title: t("country"),
								subTitle: personal.country ?? t("not_set"),
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
})

export default Personal
