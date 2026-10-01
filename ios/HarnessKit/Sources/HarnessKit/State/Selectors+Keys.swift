import Foundation

// The reducer.ts selectors that resolve ticket keys the UI references but the store may not hold
// (done tickets page in): dependency chips and the keys DetailFetcher should fetch.

extension BoardState {
    /// A dependency is satisfied when the ticket it names is done. A key that isn't loaded is
    /// "unknown" (not "pending"): done tickets aren't all in memory, so a missing ticket is most
    /// likely an older done one. Clients fetch unresolved keys (`unresolvedKeys`) and the state settles.
    public func dependencyStates(_ ticket: Ticket) -> [DepState] {
        ticket.dependsOn.map { key in
            let dep = ticketByKey(key)
            let state: DepState.Kind = dep == nil ? .unknown : dep!.status == .done ? .done : .pending
            return DepState(key: key, done: state == .done, state: state, ticket: dep, missing: dep == nil && missingKeys[JSString.upper(key)] == true)
        }
    }

    /// Ticket keys the UI references but the store can't resolve yet: dependencies of loaded
    /// tickets, dependents from details, and triage outcomes ("Dispatched to FOO-123"). Keys the
    /// service already 404'd are left out. Fetch each with getTicket and dispatch `.detail` (with
    /// requestedKey) or `.missingKeys`. Upper-cased and sorted (TS: insertion order).
    public func unresolvedKeys(_ extra: [String] = []) -> [String] {
        guard ready else { return [] }
        var known: Set<String> = []
        for t in tickets.values { known.insert(JSString.upper(t.key)) }
        for k in keyAliases.keys { known.insert(k) }
        var out: Set<String> = []
        func want(_ k: String) {
            let u = JSString.upper(k)
            if !known.contains(u) && missingKeys[u] != true { out.insert(u) }
        }
        for t in tickets.values { t.dependsOn.forEach(want) }
        for keys in dependents.values { keys.forEach(want) }
        for s in sessions.values where s.kind == .triage {
            if let k = Format.dispatchedKey(s) { want(k) }
        }
        extra.forEach(want)
        return out.sorted(by: JSString.less)
    }
}
