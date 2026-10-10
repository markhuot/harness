import Foundation

// Per-driver maps whose values may be null (`Record<string, string | null>`) are `[String: String?]`:
// Foundation's coders keep a nil value as an explicit `null`, so `{ "claude-code": null }` round-trips.

public struct Settings: Codable, Sendable, Equatable {
    /// The app's driver and model per run phase, the last level tickets and projects inherit from.
    /// A phase left out uses the Work driver with its default model; Work left out uses claude-code.
    /// nil from an older service.
    public var phaseModels: PhaseModels?
    /// Legacy: the Work choice's driver
    public var defaultDriver: String
    public var maxConcurrentRuns: Int
    /// Where the ticket header's context gauge reads "full" (tokens, 10k–2M, default 250k). nil from an
    /// older service; `contextLimit` reads the default then.
    public var contextGaugeLimit: Int?
    /// Default permission mode (projects and tickets may override it). Default "auto".
    public var permissionMode: PermissionMode
    /// Who judges actions in auto mode for drivers without their own permission system
    public var classifier: ClassifierBackend
    /// Model per driver id used when neither the ticket nor its project picks one.
    /// Missing / null → the driver's own default. PATCH merges per driver; null clears.
    public var defaultModels: [String: String?]
    /// Model per driver id for agent review runs. Missing / null → the same model as the work runs.
    public var reviewModels: [String: String?]
    /// Driver for triage sessions of watchers that don't pick one (null → defaultDriver). Optional so
    /// clients tolerate an older service without it.
    public var watcherDriver: Patch<String>
    /// Model per driver id for triage sessions of watchers that don't pick one. Missing / null →
    /// defaultModels. PATCH merges per driver; null clears. Optional like watcherDriver.
    public var watcherModels: [String: String?]?
    /// Stored API key for the anthropic-api driver (never sent back to clients in full)
    @Nullable public var anthropicApiKey: String?
    /// Long-lived Claude token (from `claude setup-token`) the claude-code driver passes to the CLI
    /// as CLAUDE_CODE_OAUTH_TOKEN, so runs don't depend on the CLI's Keychain login. nil → the CLI's
    /// own login. Never sent to clients (PublicSettings.claudeOauthTokenSet instead); optional, so
    /// a missing key decodes as nil and nil is omitted.
    public var claudeOauthToken: String?
    /// GitHub token the github-copilot driver passes to the CLI as COPILOT_GITHUB_TOKEN. Never sent
    /// to clients (PublicSettings.copilotGithubTokenSet instead); optional like claudeOauthToken.
    public var copilotGithubToken: String?
    /// Default base branch (projects and tickets may override it): what completed tickets merge into
    /// and new ticket branches start from. A valid git branch name; default "main". The service
    /// always sends it; optional so clients tolerate an older service without it.
    public var baseBranch: String?
    /// Which addresses the service listens on (DESIGN.md "Network"). The service always sends it
    /// (default { mode: "localhost" }); optional so clients tolerate an older service without it.
    public var listen: ListenSetting?
    /// Minutes a session browser tab may go unused (no agent call, no viewer input) while nobody has
    /// it open in the app before the service suspends it (closes its page; it reloads when used). 0 = never. Integer 0–1440, default 5. The
    /// service always sends it; optional so clients tolerate an older service without it.
    public var browserIdleTabMinutes: Int?
    /// The user's prompt overrides (DESIGN.md "Prompt overrides"): prompt id → template text, or null
    /// for the built-in prompt that ships with the service. The service sends every id; unset ones
    /// are null, so they pick up the built-in text as it improves. PATCH merges per id; null or ""
    /// resets one. Unknown ids and templates that don't parse or name variables the prompt doesn't
    /// have are refused with a 400. Optional so clients tolerate an older service without it.
    /// Keyed by `PromptId.rawValue`.
    public var prompts: [String: String?]?
    /// System notifications for card activity (DESIGN.md "Notifications"): the master switch, one
    /// switch per category, and where the APNs keys are. The service always sends it; optional so
    /// clients tolerate an older service without it.
    public var notifications: NotificationSettings?

    public init(
        phaseModels: PhaseModels? = nil, defaultDriver: String, maxConcurrentRuns: Int, permissionMode: PermissionMode, classifier: ClassifierBackend,
        defaultModels: [String: String?] = [:], reviewModels: [String: String?] = [:],
        watcherDriver: Patch<String> = .absent, watcherModels: [String: String?]? = nil,
        anthropicApiKey: String? = nil, claudeOauthToken: String? = nil, copilotGithubToken: String? = nil, baseBranch: String? = nil,
        listen: ListenSetting? = nil, browserIdleTabMinutes: Int? = nil, prompts: [String: String?]? = nil,
        notifications: NotificationSettings? = nil, contextGaugeLimit: Int? = nil
    ) {
        self.contextGaugeLimit = contextGaugeLimit
        self.phaseModels = phaseModels
        self.defaultDriver = defaultDriver
        self.maxConcurrentRuns = maxConcurrentRuns
        self.permissionMode = permissionMode
        self.classifier = classifier
        self.defaultModels = defaultModels
        self.reviewModels = reviewModels
        self.watcherDriver = watcherDriver
        self.watcherModels = watcherModels
        self.anthropicApiKey = anthropicApiKey
        self.claudeOauthToken = claudeOauthToken
        self.copilotGithubToken = copilotGithubToken
        self.baseBranch = baseBranch
        self.listen = listen
        self.browserIdleTabMinutes = browserIdleTabMinutes
        self.prompts = prompts
        self.notifications = notifications
    }
}

/// `DEFAULT_BROWSER_IDLE_TAB_MINUTES` / `MAX_BROWSER_IDLE_TAB_MINUTES`: Settings.browserIdleTabMinutes
/// when unset, and its upper bound (a day).
public enum BrowserIdleTabs {
    public static let defaultMinutes = 5
    public static let maxMinutes = 1440
}

/// `Omit<Settings, "anthropicApiKey" | "claudeOauthToken" | "copilotGithubToken"> & {
/// anthropicApiKeySet: boolean; claudeOauthTokenSet?: boolean; copilotGithubTokenSet?: boolean }`: what GET /settings and the settings.updated event send.
public struct PublicSettings: Codable, Sendable, Equatable {
    /// Settings.phaseModels; nil from an older service.
    public var phaseModels: PhaseModels?
    public var defaultDriver: String
    public var maxConcurrentRuns: Int
    /// Where the ticket header's context gauge reads "full" (tokens, 10k–2M, default 250k). nil from an
    /// older service; `contextLimit` reads the default then.
    public var contextGaugeLimit: Int?
    public var permissionMode: PermissionMode
    public var classifier: ClassifierBackend
    public var defaultModels: [String: String?]
    public var reviewModels: [String: String?]
    public var watcherDriver: Patch<String>
    public var watcherModels: [String: String?]?
    public var baseBranch: String?
    public var listen: ListenSetting?
    public var browserIdleTabMinutes: Int?
    /// Keyed by `PromptId.rawValue`.
    public var prompts: [String: String?]?
    /// nil from services older than notifications (Settings hides its Notifications switches then).
    public var notifications: NotificationSettings?
    /// Whether an API key for the anthropic-api driver is stored
    public var anthropicApiKeySet: Bool
    /// Whether a long-lived Claude token for the claude-code driver is stored. Services from before
    /// it omit it (nil); `hasClaudeOauthToken` reads it as false then.
    public var claudeOauthTokenSet: Bool?
    /// Whether a GitHub token for the github-copilot driver is stored. nil from older services.
    public var copilotGithubTokenSet: Bool?

    public init(
        phaseModels: PhaseModels? = nil, defaultDriver: String, maxConcurrentRuns: Int, permissionMode: PermissionMode, classifier: ClassifierBackend,
        defaultModels: [String: String?] = [:], reviewModels: [String: String?] = [:],
        watcherDriver: Patch<String> = .absent, watcherModels: [String: String?]? = nil, baseBranch: String? = nil,
        listen: ListenSetting? = nil, browserIdleTabMinutes: Int? = nil, prompts: [String: String?]? = nil,
        notifications: NotificationSettings? = nil,
        anthropicApiKeySet: Bool, claudeOauthTokenSet: Bool? = nil, copilotGithubTokenSet: Bool? = nil, contextGaugeLimit: Int? = nil
    ) {
        self.contextGaugeLimit = contextGaugeLimit
        self.phaseModels = phaseModels
        self.defaultDriver = defaultDriver
        self.maxConcurrentRuns = maxConcurrentRuns
        self.permissionMode = permissionMode
        self.classifier = classifier
        self.defaultModels = defaultModels
        self.reviewModels = reviewModels
        self.watcherDriver = watcherDriver
        self.watcherModels = watcherModels
        self.baseBranch = baseBranch
        self.listen = listen
        self.browserIdleTabMinutes = browserIdleTabMinutes
        self.prompts = prompts
        self.notifications = notifications
        self.anthropicApiKeySet = anthropicApiKeySet
        self.claudeOauthTokenSet = claudeOauthTokenSet
        self.copilotGithubTokenSet = copilotGithubTokenSet
    }

    /// claudeOauthTokenSet, or false when an older service doesn't send it.
    public var hasClaudeOauthToken: Bool { claudeOauthTokenSet ?? false }

    /// contextGaugeLimit, or the default when an older service doesn't send it.
    public var contextLimit: Int { contextGaugeLimit ?? ContextGaugeLimits.default }

    /// copilotGithubTokenSet, or false when an older service doesn't send it.
    public var hasCopilotGithubToken: Bool { copilotGithubTokenSet ?? false }

    /// browserIdleTabMinutes, or the default when an older service doesn't send it.
    public var idleTabMinutes: Int { browserIdleTabMinutes ?? BrowserIdleTabs.defaultMinutes }

    /// The override for one prompt, or nil when the built-in is used.
    public func promptOverride(_ id: PromptId) -> String? {
        prompts?[id.rawValue] ?? nil
    }
}

public struct DriverInfo: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var name: String
    public var description: String
    public var available: Bool
    public var authenticated: Bool
    /// e.g. "mark@happycog.com · Happy Cog (team)"
    public var detail: String
    /// Whether POST /drivers/:id/login is supported
    public var supportsLogin: Bool
    /// What the driver can do with a ticket's saved session (POST /tickets/:key/session); the apps
    /// hide the rest. nil from an older service: neither.
    public var sessionActions: SessionActions?
    /// false: the driver reports no token counts, so its gauge stays empty. nil from an older service.
    public var reportsContextUsage: Bool?

    public init(
        id: String, name: String, description: String, available: Bool, authenticated: Bool, detail: String, supportsLogin: Bool,
        sessionActions: SessionActions? = nil, reportsContextUsage: Bool? = nil
    ) {
        self.sessionActions = sessionActions
        self.reportsContextUsage = reportsContextUsage
        self.id = id
        self.name = name
        self.description = description
        self.available = available
        self.authenticated = authenticated
        self.detail = detail
        self.supportsLogin = supportsLogin
    }
}

/// A model a driver can run with (GET /drivers/:id/models).
public struct ModelInfo: Codable, Sendable, Equatable, Identifiable {
    /// Value passed to the driver (claude-code: --model alias or id; anthropic-api: model id)
    public var id: String
    public var name: String
    public var description: String?
    /// The model the driver uses when no model is chosen
    public var `default`: Bool?

    public init(id: String, name: String, description: String? = nil, default isDefault: Bool? = nil) {
        self.id = id
        self.name = name
        self.description = description
        self.default = isDefault
    }
}

/// GET /drivers/:id/models. Failures give models: [] (or a fallback list) plus error.
public struct DriverModels: Codable, Sendable, Equatable {
    public var driverId: String
    public var models: [ModelInfo]
    @Nullable public var error: String?
    /// When the list was fetched (cached per driver)
    public var fetchedAt: Timestamp

    public init(driverId: String, models: [ModelInfo], error: String? = nil, fetchedAt: Timestamp) {
        self.driverId = driverId
        self.models = models
        self.error = error
        self.fetchedAt = fetchedAt
    }
}

public struct PromptVariable: Codable, Sendable, Equatable {
    public var name: String
    public var description: String

    public init(name: String, description: String) {
        self.name = name
        self.description = description
    }
}

/// GET /prompts: one entry per PromptId, in PROMPT_IDS order. Templates use `{{name}}` and
/// `{{#if name}} … {{else if other}} … {{else}} … {{/if}}` (shared/src/templates.ts); text outside
/// tags is kept exactly.
public struct PromptEntry: Codable, Sendable, Equatable, Identifiable {
    public var id: PromptId
    public var group: PromptGroup
    /// Short name for a settings list, e.g. "Work run instructions"
    public var label: String
    /// One line: where the prompt is used
    public var description: String
    /// The variables the template may use; anything else is refused on save
    public var variables: [PromptVariable]
    /// The built-in template (the starting point for an edit)
    public var builtin: String
    /// The user's template, or null when the built-in is used
    @Nullable public var override: String?
    /// Why a stored override is no longer used (it names a variable this version of the prompt
    /// doesn't have, for example), or null. Runs fall back to the built-in while it's set.
    @Nullable public var overrideError: String?

    public init(
        id: PromptId, group: PromptGroup, label: String, description: String, variables: [PromptVariable] = [],
        builtin: String, override: String? = nil, overrideError: String? = nil
    ) {
        self.id = id
        self.group = group
        self.label = label
        self.description = description
        self.variables = variables
        self.builtin = builtin
        self.override = override
        self.overrideError = overrideError
    }
}
