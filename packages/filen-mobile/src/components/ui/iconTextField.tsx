import { Fragment } from "react"
import { TextInput, type TextInputProps } from "react-native"
import { cn } from "@filen/utils"
import { hairlineHeight } from "@/lib/hairline"
import Ionicons from "@expo/vector-icons/Ionicons"
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
	className?: string
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
			{showDividerBelow && (
				<View
					className="bg-separator ml-12"
					style={hairlineHeight}
				/>
			)}
		</Fragment>
	)
}

export default IconTextField
