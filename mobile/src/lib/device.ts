// What to call this device in copy ("stored in the iPad's Keychain"): the app is one build for
// iPhone and iPad.
import { Platform } from "react-native";

export const DEVICE = Platform.OS === "ios" && Platform.isPad ? "iPad" : "iPhone";
