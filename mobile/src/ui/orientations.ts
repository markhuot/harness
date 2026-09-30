// React Native's Modal is portrait-only unless it says otherwise, which an iPad held in landscape
// (or upside down) shows as a sheet turned the wrong way. Every Modal passes this instead.
import type { ModalProps } from "react-native";

export const ALL_ORIENTATIONS: NonNullable<ModalProps["supportedOrientations"]> = ["portrait", "portrait-upside-down", "landscape-left", "landscape-right"];
