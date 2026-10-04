import {
	UploadIcon,
	HistoryIcon,
	RotateCcwIcon,
	FolderInputIcon,
	PencilIcon,
	FilePenIcon,
	Trash2Icon,
	FileXIcon,
	UsersIcon,
	UserMinusIcon,
	LinkIcon,
	FolderPlusIcon,
	PaletteIcon,
	StarIcon,
	StarOffIcon,
	LogInIcon,
	ShieldAlertIcon,
	KeyRoundIcon,
	ShieldCheckIcon,
	ShieldOffIcon,
	UserXIcon,
	MailIcon,
	TicketIcon,
	CircleHelpIcon,
	type LucideIcon
} from "lucide-react"
import type { EventIconKey, EventTone } from "@/features/settings/lib/eventModel"

// The glyph for each of the event model's actions.
export const EVENT_ICONS = {
	upload: UploadIcon,
	version: HistoryIcon,
	restore: RotateCcwIcon,
	move: FolderInputIcon,
	rename: PencilIcon,
	edit: FilePenIcon,
	trash: Trash2Icon,
	delete: FileXIcon,
	share: UsersIcon,
	unshare: UserMinusIcon,
	link: LinkIcon,
	createDirectory: FolderPlusIcon,
	color: PaletteIcon,
	favorite: StarIcon,
	unfavorite: StarOffIcon,
	signIn: LogInIcon,
	failedSignIn: ShieldAlertIcon,
	password: KeyRoundIcon,
	twoFactorOn: ShieldCheckIcon,
	twoFactorOff: ShieldOffIcon,
	accountDeletion: UserXIcon,
	email: MailIcon,
	code: TicketIcon,
	unknown: CircleHelpIcon
} as const satisfies Record<EventIconKey, LucideIcon>

// The icon tile's tint per tone.
export const EVENT_TONE_CLASS = {
	default: "bg-muted text-muted-foreground",
	warning: "bg-warning/15 text-warning-foreground",
	danger: "bg-destructive/15 text-destructive"
} as const satisfies Record<EventTone, string>
