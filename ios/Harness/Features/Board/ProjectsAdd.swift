import HarnessKit
import SwiftUI

extension BoardStore {
    /// Adds a project by its folder's path on the Mac (Projects sheet and Settings → Projects): the
    /// path trimmed, nothing for a blank one, "Project added" on success. Returns the new project,
    /// or nil after a blank path or a failure (already reported).
    func addProject(path: String, actions: Actions) async -> Project? {
        let path = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !path.isEmpty, let api = client as? HarnessClient else { return nil }
        return await actions.run("Project added") { try await api.createProject(CreateProjectBody(path: path)) }
    }
}
