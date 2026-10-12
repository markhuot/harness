import Foundation

/// The Details tab's pull request list (Ticket.pullRequests) as edits: the PATCH body for adding a
/// typed link or removing one. The service does the same checks (`validPullRequestUrls`), so this
/// only says what the human can fix before saving.
public enum PullRequestLogic {
    /// What adding a link does: the body to save, or the problem to show under the field.
    public enum Edit: Equatable, Sendable {
        case save(UpdateTicketBody)
        case invalid(String)
    }

    /// The service's rule (`PULL_REQUEST_URL`, `/^https?:\/\/\S+$/`), checked on the trimmed text.
    public static func isPullRequestUrl(_ url: String) -> Bool {
        url.wholeMatch(of: /https?:\/\/\S+/) != nil
    }

    /// The list with each link trimmed and duplicates dropped, keeping the first of each.
    public static func normalized(_ urls: [String]) -> [String] {
        var seen = Set<String>()
        return urls.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { seen.insert($0).inserted }
    }

    /// The whole list with `input` appended, or why it can't be: not an http(s) link, or already
    /// on the ticket. Trims the input first.
    public static func adding(_ input: String, to current: [String]) -> Edit {
        let url = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard isPullRequestUrl(url) else {
            return .invalid("Enter a link that starts with https:// or http://")
        }
        guard !normalized(current).contains(url) else {
            return .invalid("That pull request is already linked")
        }
        return .save(body(normalized(current + [url])))
    }

    /// The whole list with `url` taken out, in its order. Removing a link the list doesn't have
    /// changes nothing.
    public static func removing(_ url: String, from current: [String]) -> UpdateTicketBody {
        body(normalized(current).filter { $0 != url })
    }

    /// The PATCH body that sets the whole list.
    public static func body(_ urls: [String]) -> UpdateTicketBody {
        UpdateTicketBody(pullRequestUrls: urls)
    }
}
