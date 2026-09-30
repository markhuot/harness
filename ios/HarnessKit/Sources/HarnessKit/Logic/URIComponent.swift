import Foundation

/// JavaScript's `encodeURIComponent` / `decodeURIComponent`, which the service and the TS code
/// use for query values and pairing links. Foundation's `urlQueryAllowed` keeps `&`, `=` and `+`,
/// so it can't stand in for them.
public enum URIComponent {
    /// Characters encodeURIComponent leaves alone: A–Z a–z 0–9 - _ . ! ~ * ' ( )
    static let unreserved: CharacterSet = {
        var set = CharacterSet()
        set.insert(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")
        return set
    }()

    public static func encode(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: unreserved) ?? s
    }

    /// nil where decodeURIComponent would throw (a bad `%` escape or invalid UTF-8).
    public static func decode(_ s: String) -> String? {
        s.removingPercentEncoding
    }
}
