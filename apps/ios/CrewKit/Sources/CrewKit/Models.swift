import Foundation

// The conductor's wire format: packages/protocol/src/index.ts in Swift. Field
// names match the JSON. Times are milliseconds since 1970, as JavaScript sends them.
// Keep this in step with the TypeScript file when that changes.

public typealias Millis = Double

extension Millis {
  public var date: Date { Date(timeIntervalSince1970: self / 1000) }
}

public enum ThreadStatus: String, LenientEnum {
  case idle, running, interrupted, error
  case needsYou = "needs_you"
  case unknown
}

public enum SessionStatus: String, LenientEnum {
  case idle, running, queued, interrupted, error, unknown
}

public enum TurnStatus: String, LenientEnum {
  case running, done, interrupted, error, cancelled, unknown
}

public struct Usage: Codable, Sendable, Hashable {
  public var costUsd: Double?
  public var inputTokens: Int
  public var outputTokens: Int
  public var unpricedTokens: Int?
}

public struct CrewThread: Codable, Sendable, Hashable, Identifiable {
  public var id: String
  public var title: String
  public var status: ThreadStatus
  public var rootSessionId: String
  public var createdAt: Millis
  public var updatedAt: Millis
  public var archived: Bool
  public var roles: [String]
  public var statusText: String
  public var benched: [String]
  public var usage: Usage?
  public var createdBy: String?
  public var people: [String]?

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    title = try c.decode(String.self, forKey: .title)
    status = try c.decode(ThreadStatus.self, forKey: .status)
    rootSessionId = try c.decode(String.self, forKey: .rootSessionId)
    createdAt = try c.decode(Millis.self, forKey: .createdAt)
    updatedAt = try c.decode(Millis.self, forKey: .updatedAt)
    archived = try c.decodeIfPresent(Bool.self, forKey: .archived) ?? false
    roles = try c.list(.roles)
    statusText = try c.decodeIfPresent(String.self, forKey: .statusText) ?? ""
    benched = try c.list(.benched)
    usage = try c.decodeIfPresent(Usage.self, forKey: .usage)
    createdBy = try c.decodeIfPresent(String.self, forKey: .createdBy)
    people = try c.decodeIfPresent([String].self, forKey: .people)
  }
}

public struct Attachment: Codable, Sendable, Hashable {
  public var file: String
  public var name: String
  public var mime: String
  public var size: Int
}

/// An image as the app uploads it: base64 without a data: prefix.
public struct AttachmentUpload: Codable, Sendable, Hashable {
  public var name: String
  public var mime: String
  public var data: String
  public init(name: String, mime: String, data: Data) {
    self.name = name
    self.mime = mime
    self.data = data.base64EncodedString()
  }
}

public struct Dm: Codable, Sendable, Hashable, Identifiable {
  public struct Last: Codable, Sendable, Hashable {
    public var by: String
    public var text: String
    public var ts: Millis
  }
  public var id: String
  public var people: [String]
  public var createdAt: Millis
  public var updatedAt: Millis
  public var last: Last?
}

public struct DmMessage: Codable, Sendable, Hashable, Identifiable {
  public var id: Int
  public var dmId: String
  public var by: String
  public var text: String
  public var attachments: [Attachment]?
  public var ts: Millis
}

public struct Person: Codable, Sendable, Hashable, Identifiable {
  public var email: String
  public var name: String
  public var id: String { email }
  public init(email: String, name: String) {
    self.email = email
    self.name = name
  }
}

public struct Session: Codable, Sendable, Hashable, Identifiable {
  public var id: String
  public var threadId: String
  public var role: String
  public var engine: String
  public var model: String
  public var status: SessionStatus
  public var parentSessionId: String?
  /// 0: the thread's owner (the lead). 1: a specialist the lead called.
  public var depth: Int
  public var createdAt: Millis
  public var updatedAt: Millis
}

public struct Turn: Codable, Sendable, Hashable, Identifiable {
  public var id: String
  public var sessionId: String
  public var threadId: String
  public var prompt: String
  public var status: TurnStatus
  public var callerSessionId: String?
  public var result: String?
  public var error: String?
  public var startedAt: Millis
  public var endedAt: Millis?
  public var usage: Usage?
}

public struct QuestionOption: Codable, Sendable, Hashable {
  public var label: String
  public var detail: String?
}

public enum InboxKind: String, LenientEnum {
  case approval, interrupted, error, draft, mention
  case needsYou = "needs_you"
  case pullRequest = "pull_request"
  case unknown
}

public struct InboxItem: Codable, Sendable, Hashable, Identifiable {
  public var id: String
  public var threadId: String
  public var sessionId: String
  public var kind: InboxKind
  public var role: String
  public var previewId: String?
  public var title: String
  public var body: String
  public var options: [QuestionOption]?
  public var recommended: Int?
  public var multiSelect: Bool?
  public var url: String?
  public var askEveryTime: Bool?
  public var status: String
  public var createdAt: Millis
  public var `for`: String?
  public var by: String?

  public var isOpen: Bool { status == "open" }
}

public struct RoleSummary: Codable, Sendable, Hashable, Identifiable {
  public var name: String
  public var label: String
  public var description: String
  public var engine: String
  public var model: String
  public var permissions: String
  public var isLead: Bool
  public var id: String { name }
}

public struct AgentActivity: Codable, Sendable, Hashable {
  public var role: String
  public var sessionId: String
  public var threadId: String
  public var threadTitle: String
  public var status: SessionStatus
  public var doing: String
  public var since: Millis
}

public struct StateResponse: Codable, Sendable {
  public struct Team: Codable, Sendable {
    public var name: String
    public var suggestions: [String]
  }
  public var team: Team
  public var threads: [CrewThread]
  public var done: [CrewThread]
  public var inbox: [InboxItem]
  public var roles: [RoleSummary]
  public var activity: [AgentActivity]
  public var sharing: Bool?
  public var me: String?
  public var people: [Person]?
  public var dms: [Dm]?
}

public struct ThreadShare: Codable, Sendable, Hashable {
  public var url: String
  public var sharedAt: Millis
}

public struct ThreadDetailResponse: Decodable, Sendable {
  public var thread: CrewThread
  public var sessions: [Session]
  public var turns: [Turn]
  public var events: [CrewEvent]
  public var share: ThreadShare?
}

public enum DocFormat: String, LenientEnum {
  case markdown, html, concepts, unknown
}

public struct DocSummary: Codable, Sendable, Hashable, Identifiable {
  public var id: String
  public var threadId: String
  public var threadTitle: String
  public var agent: String
  public var title: String
  public var format: DocFormat
  public var status: String
  public var createdAt: Millis
  public var shownAt: Millis
  public var approvedAt: Millis?
  public var archivedAt: Millis?
}

public struct DocResponse: Codable, Sendable, Hashable, Identifiable {
  public var id: String
  public var threadId: String
  public var agent: String
  public var title: String
  public var format: DocFormat
  public var status: String
  public var content: String
}

// MARK: - Requests

public struct CreateThreadRequest: Encodable, Sendable {
  public var text: String
  public var attachments: [AttachmentUpload]?
  public var role: String?
  public var benched: [String]?
  public init(text: String, attachments: [AttachmentUpload]? = nil, role: String? = nil, benched: [String]? = nil) {
    self.text = text
    self.attachments = attachments
    self.role = role
    self.benched = benched
  }
}

public struct SendMessageRequest: Encodable, Sendable {
  public var text: String
  public var attachments: [AttachmentUpload]?
  public var sessionId: String?
  public var replyTo: String?
  public var mentions: [String]?
  public var toAgent: Bool?
  public init(text: String, attachments: [AttachmentUpload]? = nil, sessionId: String? = nil, replyTo: String? = nil, mentions: [String]? = nil, toAgent: Bool? = nil) {
    self.text = text
    self.attachments = attachments
    self.sessionId = sessionId
    self.replyTo = replyTo
    self.mentions = mentions
    self.toAgent = toAgent
  }
}

public struct SendDmRequest: Encodable, Sendable {
  public var with: [String]?
  public var text: String
  public var attachments: [AttachmentUpload]?
  public var clientId: String?
  public init(with: [String]? = nil, text: String, attachments: [AttachmentUpload]? = nil, clientId: String? = nil) {
    self.with = with
    self.text = text
    self.attachments = attachments
    self.clientId = clientId
  }
}

/// What POST /api/dms and /api/dms/<id>/messages answer.
public struct SentDm: Codable, Sendable {
  public var dm: Dm
  public var message: DmMessage
}
