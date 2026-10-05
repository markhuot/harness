// harness-widgets-reload: reloads the Harness desktop widgets' timelines, then exits. The Electron
// app has no WidgetKit of its own, so app/src/main/widgets.ts runs this when the board changes.
// app/scripts/package.ts compiles it into Harness.app/Contents/MacOS, which makes the app its
// bundle (Bundle.main), and WidgetKit reloads the widgets that app contains.
import WidgetKit

WidgetCenter.shared.reloadAllTimelines()
