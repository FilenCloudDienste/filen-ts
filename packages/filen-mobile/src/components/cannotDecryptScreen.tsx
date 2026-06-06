import { useTranslation } from "react-i18next"
import View from "@/components/ui/view"
import Text from "@/components/ui/text"
import { cannotDecryptPlaceholder } from "@/lib/decryption"

export type CannotDecryptScreenSurface = "note" | "drive" | "linkedFile" | "linkedDir" | "publicLink" | "driveInfo"

export const CannotDecryptScreen = ({ uuid }: { uuid: string; surface?: CannotDecryptScreenSurface }) => {
	const { t } = useTranslation()

	return (
		<View className="flex-1 items-center justify-center p-8">
			<Text className="text-foreground text-base font-medium text-center mb-2 leading-5">{cannotDecryptPlaceholder(uuid)}</Text>
			<Text className="text-muted-foreground text-sm text-center leading-5">{t("cannot_decrypt_body")}</Text>
		</View>
	)
}

export default CannotDecryptScreen
