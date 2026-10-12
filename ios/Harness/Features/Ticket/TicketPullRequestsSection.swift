import HarnessKit
import SwiftUI

/// The Details tab's Pull requests section: one row per link (its PR number, then its title or
/// "No title"; tap opens it, swipe removes it), an add field, and Refresh, which fetches every title
/// again. Each change saves the whole list (PATCH pullRequestUrls), and the ticket comes back on the
/// socket, so the rows update on their own. Modeled on TicketRemoteIdRow (TicketSettingsForm).
struct TicketPullRequestsSection: View {
    let ticket: Ticket

    @Environment(BoardStore.self) private var store
    @Environment(Actions.self) private var actions
    @Environment(\.palette) private var c
    @Environment(\.openURL) private var openURL
    @State private var url = ""
    @State private var error: String?
    @State private var refreshing = false
    @FocusState private var focused: Bool

    private var urls: [String] { ticket.pullRequests.map(\.url) }

    var body: some View {
        Section {
            if ticket.pullRequests.isEmpty {
                Text("No pull requests").font(.scaled(size: 14)).foregroundStyle(c.text3)
            }
            ForEach(ticket.pullRequests, id: \.url) { link in
                row(link)
                    .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                        Button(role: .destructive) { remove(link) } label: { Label("Remove", systemImage: "trash") }
                    }
            }
            VStack(alignment: .trailing, spacing: 6) {
                HStack(spacing: 8) {
                    TextField("", text: $url, prompt: Text("Link, e.g. https://github.com/…").foregroundStyle(c.text3))
                        .font(.scaled(size: 14))
                        .foregroundStyle(c.text)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.done)
                        .focused($focused)
                        .onSubmit(add)
                        .accessibilityLabel("Pull request link")
                    HButton("Add", variant: .secondary, small: true, fullWidth: false, action: add)
                        .disabled(url.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                if let error { Text(error).font(.scaled(size: 13)).foregroundStyle(c.red) }
            }
            if !ticket.pullRequests.isEmpty {
                HButton("Refresh titles", icon: "refresh", variant: .ghost, small: true, loading: refreshing, fullWidth: false, action: refresh)
            }
        } header: {
            Text("Pull requests")
        } footer: {
            Text("A title comes from gh when a link is added. Swipe a row to remove it.")
        }
        .listRowBackground(c.bgElev)
    }

    /// The row opens the pull request in the browser.
    private func row(_ link: PullRequestLink) -> some View {
        Button {
            if let u = URL(string: link.url) { openURL(u) }
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                Text(TicketDetailLogic.pullRequestBadge(link.url))
                    .font(.mono(13.5))
                    .foregroundStyle(c.accentText)
                Text(TicketDetailLogic.pullRequestSubtitle(link))
                    .font(.scaled(size: 14))
                    .foregroundStyle(TicketDetailLogic.pullRequestTitle(link) == nil ? c.text3 : c.text2)
                    .lineLimit(2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(TicketDetailLogic.pullRequestAccessibilityLabel(link))
        .accessibilityHint("Opens it in the browser")
    }

    /// Validates the typed link first; a problem shows under the field and nothing is saved.
    private func add() {
        switch PullRequestLogic.adding(url, to: urls) {
        case let .invalid(message):
            error = message
        case let .save(body):
            error = nil
            save(body) { url = "" }
        }
    }

    private func remove(_ link: PullRequestLink) {
        save(PullRequestLogic.removing(link.url, from: urls))
    }

    private func save(_ body: UpdateTicketBody, then done: @escaping @MainActor () -> Void = {}) {
        let key = ticket.key
        Task {
            if await actions.run({ try await store.connectedAPI().updateTicket(key, body) }) != nil { done() }
        }
    }

    private func refresh() {
        let key = ticket.key
        refreshing = true
        Task {
            defer { refreshing = false }
            _ = await actions.run { try await store.connectedAPI().refreshPullRequests(key) }
        }
    }
}
