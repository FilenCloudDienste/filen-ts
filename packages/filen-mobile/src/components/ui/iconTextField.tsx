import { Fragment } from "react"
import { TextInput, type TextInputProps } from "react-native"
import Ionicons from "@expo/vector-icons/Ionicons"
import { cn } from "@filen/shared"
import View from "@/components/ui/view"

const IconTextField = ({
	icon,
	iconColor,
	showDividerBelow,
	className,
	...textInputProps
}: {
	icon: React.ComponentProps<typeof Ionicons>["name"]
	iconColor: string
	showDividerBelow?: boolean
} & TextInputProps) => {
	return (
		<Fragment>
			<View className={cn("flex-row items-center px-4", className)}>
				<Ionicons
					name={icon}
					size={18}
					color={iconColor}
				/>
				<TextInput
					{...textInputProps}
					className="text-foreground text-base flex-1 py-4 pl-3 leading-5"
				/>
			</View>
			{showDividerBelow && <View className="h-px bg-separator ml-12" />}
		</Fragment>
	)
}

export default IconTextField
