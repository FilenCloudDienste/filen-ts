import { createFileRoute } from "@tanstack/react-router"
import { MountsPlaceholder } from "@/features/mounts/components/mountsPlaceholder"

// The bare /mounts index, under the mounts layout's desktop guard: the prompt beside the role list.
export const Route = createFileRoute("/_app/mounts/")({ component: MountsPlaceholder })
