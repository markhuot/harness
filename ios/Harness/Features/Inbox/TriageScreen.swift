import HarnessKit
import SwiftUI

/// One triage item: its title, status and driver, the outcome,
/// a link to the ticket it dispatched, and the triage agent's transcript. A triage session has no
/// folder of its own, so file links resolve where it dispatched to.
struct TriageScreen: View {
    let sessionId: String

    @Environment(BoardStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(\.inTicketSheet) private var inTicketSheet
    @Environment(\.palette) private var c

    var body: some View {
        let state = store.state
        Group {
            if let session = state.sessions[sessionId] {
                let dispatched = InboxLogic.dispatchedTicket(state, session)
                VStack(spacing: 0) {
                    VStack(alignment: .leading, spacing: 10) {
                        Text(session.title).font(.scaled(size: 19, weight: .bold)).foregroundStyle(c.text)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        HStack(spacing: 6) {
                            InboxTriageBadge(session: session)
                            Badge(session.driver, outline: true)
                        }
                        if let outcome = session.outcome, !outcome.isEmpty {
                            TriageOutcomeCallout(session: session, outcome: outcome)
                        }
                        if let dispatched {
                            HButton("Open \(Keys.keyLabel(dispatched))", icon: "chevronRight", small: true, fullWidth: false) {
                                // From the Inbox it's a new choice for the ticket sheet; pushed
                                // inside the sheet, a step within it.
                                if inTicketSheet { router.push(.ticket(key: dispatched.key, tab: nil)) }
                                else { router.openTicket(key: dispatched.key, tab: nil) }
                            }
                        }
                    }
                    .padding(14)
                    .overlay(alignment: .bottom) { Rectangle().fill(c.border).frame(height: 1 / 3) }
                    TranscriptView(sessionId: session.id, emptyHint: "The triage agent's reasoning appears here.")
                }
                .fileLinkScope(InboxLogic.linkContext(state, session))
                .navigationTitle(session.key)
            } else {
                EmptyState(icon: "inbox", title: "Not found")
            }
        }
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// The outcome: green once dispatched, red when triage failed, neutral otherwise, as markdown.
private struct TriageOutcomeCallout: View {
    let session: Session
    let outcome: String
    var body: some View {
        let style = InboxLogic.outcomeStyle(session)
        Callout(tone: Tone(rawValue: style.tone.rawValue) ?? .neutral, icon: style.icon, title: "Outcome") {
            MarkdownView(text: outcome, size: 14)
        }
    }
}
