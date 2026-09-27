// A small inline icon set (lucide-style strokes) so we don't pull an icon library. The paths are
// shared with the iOS app (@harness/shared/state "icons").

import { ICON_PATHS as paths, type IconName } from "@harness/shared/state";

export { isIconName, type IconName } from "@harness/shared/state";


export function Icon({ name, size = 14, className, strokeWidth = 1.75 }: { name: IconName; size?: number; className?: string; strokeWidth?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d={paths[name]} />
    </svg>
  );
}
