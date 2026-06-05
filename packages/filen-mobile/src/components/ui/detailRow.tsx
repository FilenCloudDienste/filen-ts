import View from "@/components/ui/view"
import Text from "@/components/ui/text"

export type DetailRowProps = {
	title: string
	value: string | React.ReactNode
}

export const DetailRow = ({ title, value }: DetailRowProps) => {
	return (
		<View className="bg-transparent border-b border-border pb-2 flex-row items-center justify-between gap-4">
			<Text
				className="text-muted-foreground shrink-0"
				numberOfLines={1}
				ellipsizeMode="middle"
			>
				{title}
			</Text>
			<View className="bg-transparent flex-1 justify-end items-center flex-row gap-2">
				{typeof value === "string" ? (
					<Text
						className="text-foreground flex-1 text-right"
						numberOfLines={1}
						ellipsizeMode="middle"
					>
						{value}
					</Text>
				) : (
					value
				)}
			</View>
		</View>
	)
}

export default DetailRow
