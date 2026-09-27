// The desktop's icon set (paths shared via @harness/shared/state), drawn with react-native-svg.
import Svg, { Path } from "react-native-svg";
import { ICON_PATHS, type IconName } from "@harness/shared/state";

export type { IconName };

export function Icon({ name, size = 14, color, strokeWidth = 1.75 }: { name: IconName; size?: number; color: string; strokeWidth?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      <Path d={ICON_PATHS[name]} />
    </Svg>
  );
}
