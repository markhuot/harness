import Foundation

extension Icons {
    /// The SF Symbol the native app draws for each shared icon name (shared/src/state/icons.ts).
    /// Every name in `names` has one (IconSymbolsTests checks), so a plugin manifest's icon always
    /// draws; the app falls back to `fallbackSymbol` for a name a newer service sends.
    public static let symbols: [String: String] = [
        "plus": "plus",
        "minus": "minus",
        "board": "rectangle.split.3x1",
        "inbox": "tray",
        "settings": "gearshape",
        "folder": "folder",
        "layers": "square.3.layers.3d",
        "x": "xmark",
        "check": "checkmark",
        "copy": "doc.on.doc",
        "checkCircle": "checkmark.circle",
        "alert": "exclamationmark.circle",
        "play": "play",
        "stop": "stop",
        "trash": "trash",
        "send": "paperplane",
        "arrowUp": "arrow.up",
        "chevronRight": "chevron.right",
        "chevronDown": "chevron.down",
        "chevronLeft": "chevron.left",
        "refresh": "arrow.clockwise",
        "globe": "globe",
        "message": "message",
        "fileText": "doc.text",
        "terminal": "terminal",
        "tool": "wrench.and.screwdriver",
        "user": "person",
        "sparkle": "sparkle",
        "bot": "cpu",
        "link": "link",
        "external": "arrow.up.right.square",
        "branch": "arrow.triangle.branch",
        "commit": "smallcircle.filled.circle",
        "conductor": "point.3.connected.trianglepath.dotted",
        "more": "ellipsis",
        "edit": "pencil",
        "image": "photo",
        "eye": "eye",
        "clock": "clock",
        "zap": "bolt",
        "sidebar": "sidebar.left",
        "expand": "arrow.up.left.and.arrow.down.right",
        "shrink": "arrow.down.right.and.arrow.up.left",
        "popout": "arrow.up.forward.square",
        "popin": "arrow.down.backward.square",
        "wifiOff": "wifi.slash",
        "key": "key",
        "hash": "number",
        "filter": "line.3.horizontal.decrease",
        "lock": "lock",
        "shield": "shield",
        "grip": "line.3.horizontal",
        "chevron": "chevron.down",
        "pointer": "cursorarrow",
        "phone": "iphone",
        "ruler": "ruler",
    ]

    public static let fallbackSymbol = "questionmark.square.dashed"

    /// The SF Symbol for an icon name, or the fallback.
    public static func symbol(_ name: String) -> String { symbols[name] ?? fallbackSymbol }
}
