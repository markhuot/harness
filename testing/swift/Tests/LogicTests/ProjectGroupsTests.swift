import Testing
import HarnessKit

@Suite struct ProjectGroupsTests {
    private func project(_ key: String, group: String? = nil, groupId: String? = nil) -> Project {
        Project(id: "p-\(key)", key: key, name: key, path: "/\(key)", nextSeq: 1, useWorktrees: true, group: group, groupId: groupId, createdAt: 0, updatedAt: 0)
    }

    private func state(_ projects: Project...) -> BoardState {
        var s = BoardState()
        for p in projects { s.projects[p.id] = p }
        return s
    }

    @Test func groupsAreListedOnceByIdAlphabeticallyAndAnUngroupedProjectHasNone() {
        let list = ProjectGroups.list([
            project("A", group: "work", groupId: "g-1"), project("B"), project("C", group: "Alpha", groupId: "g-2"),
            project("D", group: "work", groupId: "g-1"), project("E", group: "beta", groupId: "g-3"),
        ])
        #expect(list == [ProjectGroup(id: "g-2", name: "Alpha"), ProjectGroup(id: "g-3", name: "beta"), ProjectGroup(id: "g-1", name: "work")])
    }

    @Test func aRenamedGroupIsStillOneGroupUnderItsNewName() {
        let list = ProjectGroups.list([project("A", group: "Clients", groupId: "g-1"), project("B", group: "Clients", groupId: "g-1")])
        #expect(list == [ProjectGroup(id: "g-1", name: "Clients")])
    }

    @Test func aSavedNameResolvesToTheGroupsIdAndAnIdIsItself() {
        let groups = [ProjectGroup(id: "g-1", name: "Work"), ProjectGroup(id: "g-2", name: "Play")]
        #expect(ProjectGroups.resolve("g-2", in: groups) == "g-2")
        #expect(ProjectGroups.resolve("work", in: groups) == "g-1")
        #expect(ProjectGroups.resolve("Nope", in: groups) == nil)
        #expect(ProjectGroups.resolve("g-1", in: groups + [ProjectGroup(id: "g-3", name: "g-1")]) == "g-1")
    }

    @Test func aBoardFilterSavedWithTheGroupsNameShowsItsBoardByIdAndAGoneGroupReadsAsAllProjects() {
        let s = state(project("A", group: "Work", groupId: "g-1"))
        #expect(s.boardFilter(Paging.groupScope("g-1")) == Paging.groupScope("g-1"))
        #expect(s.boardFilter("group:work") == Paging.groupScope("g-1"))
        #expect(s.boardFilter(Paging.groupScope("gone")) == nil)
        #expect(s.boardFilter("p-A") == "p-A")
    }

    @Test func groupBoardsFilterAndQueryByIdWhateverTheGroupIsCalled() {
        #expect(Paging.scopeQuery(Paging.groupScope("g-1")) == (nil, "g-1"))
        #expect(Paging.scopeQuery("p-A") == ("p-A", nil))
        #expect(Paging.scopeQuery(Paging.allScope) == (nil, nil))
        let s = state(project("A", group: "Renamed", groupId: "g-1"), project("B", group: "Work", groupId: "g-2"))
        #expect(s.composerCandidates(Paging.groupScope("g-1"), last: "p-B") == [nil, "p-A", "p-B"])
    }

    @Test func movingAProjectBetweenGroupsDropsDonePagingOfBothAndARenameDropsNone() {
        var s = state(project("A", group: "One", groupId: "g-1"))
        let paging = DonePaging(total: 1, nextCursor: nil, loading: false, frontier: nil, newest: nil, error: nil)
        s.donePaging = [Paging.groupScope("g-1"): paging, Paging.groupScope("g-2"): paging, Paging.groupScope("g-3"): paging]
        s.apply(.projectUpserted(project: project("A", group: "Renamed", groupId: "g-1")))
        #expect(Set(s.donePaging.keys) == [Paging.groupScope("g-1"), Paging.groupScope("g-2"), Paging.groupScope("g-3")])
        s.apply(.projectUpserted(project: project("A", group: "Two", groupId: "g-2")))
        #expect(Set(s.donePaging.keys) == [Paging.groupScope("g-3")])
    }

    @Test func openCountsAddUpPerGroupId() {
        let projects = [project("A", groupId: "g-1"), project("B", groupId: "g-1"), project("C")]
        #expect(BoardScreenRules.groupOpenCounts(["p-A": 2, "p-B": 3, "p-C": 9], projects: projects) == ["g-1": 5])
    }

    @Test func aSidebarRowSavesItsGroupsScopeById() {
        #expect(SidebarRow.group("g-1").board == "group:g-1")
        #expect(SidebarRow.current(tab: .board, board: "group:g-1") == .group("g-1"))
    }

    @Test func pickingARowReportsAnIdForAnExistingGroupAndANameForANewOne() {
        let groups = [ProjectGroup(id: "g-1", name: "Client Work")]
        #expect(ProjectGroups.rows(groups, query: "").map(\.pick) == [.clear, .group("g-1")])
        #expect(ProjectGroups.rows(groups, query: "client work").map(\.pick) == [.group("g-1")])
        #expect(ProjectGroups.rows(groups, query: "Ideas").last?.pick == .named("Ideas"))
        #expect(ProjectGroups.rows(groups, query: String(repeating: "x", count: 61)).last?.pick == nil)
    }

    @Test func aNewGroupNameCantBeTakenForAGroupId() {
        let rows = ProjectGroups.rows([ProjectGroup(id: "Ideas", name: "Other")], query: "Ideas")
        #expect(rows.compactMap(\.id) == ["new:Ideas"])
    }
}
