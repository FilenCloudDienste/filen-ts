import { memo } from "react"
import View from "@/components/ui/view"
import Text from "@/components/ui/text"
import { cannotDecryptPlaceholder } from "@/lib/decryption"

export type CannotDecryptScreenSurface = "note" | "drive" | "linkedFile" | "linkedDir" | "publicLink" | "driveInfo"

export const CannotDecryptScreen = memo(({ uuid }: { uuid: string; surface?: CannotDecryptScreenSurface }) => {
	return (
		<View className="flex-1 items-center justify-center p-8">
			<Text className="text-foreground text-base font-medium text-center mb-2 leading-5">
				{cannotDecryptPlaceholder(uuid)}
			</Text>
			<Text className="text-muted-foreground text-sm text-center leading-5">tbd_cannot_decrypt_body</Text>
		</View>
	)
})

CannotDecryptScreen.displayName = "CannotDecryptScreen"

export default CannotDecryptScreen
