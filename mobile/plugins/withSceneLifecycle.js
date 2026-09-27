// iOS 27 asserts at launch unless an app adopts the UIScene life cycle. Expo SDK 57 ships the
// scene delegate (EXExpoAppSceneDelegate) but its prebuild template still starts React Native from
// the app delegate. This plugin wires the scene path: the scene manifest in Info.plist, and an
// AppDelegate that only creates the React Native factory (the scene delegate creates the window).
const { withAppDelegate, withInfoPlist } = require("expo/config-plugins");

const WINDOW_BLOCK = /#if os\(iOS\) \|\| os\(tvOS\)\s*window = UIWindow\(frame: UIScreen\.main\.bounds\)\s*factory\.startReactNative\([\s\S]*?\)\s*#endif\s*/;

module.exports = function withSceneLifecycle(config) {
  config = withInfoPlist(config, (c) => {
    c.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [{ UISceneConfigurationName: "Default Configuration", UISceneDelegateClassName: "EXExpoAppSceneDelegate" }],
      },
    };
    return c;
  });
  return withAppDelegate(config, (c) => {
    if (c.modResults.language !== "swift") throw new Error("withSceneLifecycle expects a Swift AppDelegate");
    let src = c.modResults.contents;
    if (!src.includes("ExpoReactNativeFactoryProvider")) {
      src = src.replace("class AppDelegate: ExpoAppDelegate {", "class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {");
    }
    if (WINDOW_BLOCK.test(src)) src = src.replace(WINDOW_BLOCK, "// The scene delegate (EXExpoAppSceneDelegate) creates the window and starts React Native.\n    ");
    if (!src.includes("ExpoReactNativeFactoryProvider") || src.includes("UIWindow(frame: UIScreen.main.bounds)")) {
      throw new Error("withSceneLifecycle: the AppDelegate template changed; update the plugin");
    }
    c.modResults.contents = src;
    return c;
  });
};
