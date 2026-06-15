import type { ListRenderItemInfo } from "@/components/ui/virtualList"
import type { DriveItem } from "@/types"
import type { DrivePath } from "@/hooks/useDrivePath"
import Text from "@/components/ui/text"
import { getSharerIdentity } from "@/features/drive/driveSharer"

// Shows the counterparty email (sharer for shared-in, recipient for shared-out) as its own
// metadata row. ONLY at the shared virtual root — i.e. root-level shared items, where a single
// item can appear once per sender/recipient and the email disambiguates otherwise-identical
// rows. Inside a shared subdirectory every item has the same counterparty, so it's omitted.
const ShareEmail = ({ info, drivePath }: { info: ListRenderItemInfo<DriveItem>; drivePath: DrivePath }) => {
	if (drivePath.type !== "sharedIn" && drivePath.type !== "sharedOut") {
		return null
	}

	if (info.item.type !== "sharedRootFile" && info.item.type !== "sharedRootDirectory") {
		return null
	}

	const identity = getSharerIdentity(info.item)

	if (!identity) {
		return null
	}

	return (
		<Text
			className="text-xs text-muted-foreground"
			numberOfLines={1}
			ellipsizeMode="middle"
		>
			{identity.email}
		</Text>
	)
}

export default ShareEmail
