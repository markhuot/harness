import HarnessKit
import SwiftUI

/// Which tab the board screen is: the Board, or the Search tab's searchable board.
enum BoardMode: Hashable, Sendable {
    case board, search
}

/// FEATURE SLOT (Board ticket): the board's columns, cards, moves and paging (screens/Board.tsx,
/// TicketCard.tsx), and the Search tab (`mode: .search`). Replace the body.
///
/// The placeholder lists each column's chip ("Planning, 3", the label sim-check.ts waits for) and
/// its tickets ("GREET-1 Title"), so pairing can be checked end to end before the real board lands.
struct BoardScreen: View {
    let mode: BoardMode

    @Environment(BoardStore.self) private var store
    @Environment(AppModel.self) private var app
    @Environment(Router.self) private var router
    @Environment(\.palette) private var c

    var body: some View {
        let columns = BoardColumns.visibleColumns(store.state.boardColumns(app.prefs.boardProject), hideChildren: app.prefs.hideChildren)
        List {
            ForEach(TicketStatus.allKnown, id: \.self) { status in
                Section {
                    ForEach(columns[status], id: \.id) { t in
                        Button { router.push(.ticket(key: t.key, tab: nil)) } label: {
                            HStack(spacing: 8) {
                                StatusDot(status: t.status)
                                TicketKeyLabel(ticket: t)
                                Text(t.title.isEmpty ? "Untitled" : t.title).foregroundStyle(c.text).lineLimit(1)
                            }
                        }
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel("\(t.key) \(t.title)")
                        .listRowBackground(c.bgElev)
                    }
                } header: {
                    let n = BoardColumns.columnCount(store.state, app.prefs.boardProject, shown: columns, status: status, searching: false)
                    Text("\(statusLabel(status)), \(n)")
                        .accessibilityLabel("\(statusLabel(status)), \(n)")
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(c.bg)
        .overlay { if !store.state.ready { Spinner() } }
        .navigationTitle(mode == .search ? "Search" : "Board")
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button("Projects", systemImage: "sidebar.left") { router.present(.projects(fromSearch: mode == .search)) }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button("New session", systemImage: "plus") { router.present(.newSession(projectId: nil, key: nil)) }
            }
        }
        .safeAreaInset(edge: .top) { ConnectionBanner() }
    }
}
