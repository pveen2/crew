import Foundation

/// Everything that happens in a thread is an event; the app draws the thread from its events alone.
public struct CrewEvent: Decodable, Sendable, Hashable, Identifiable {
  public var id: Int
  public var threadId: String
  public var sessionId: String
  public var turnId: String?
  public var ts: Millis
  public var body: Body

  public enum Delivery: String, LenientEnum {
    case steer, queue, held, unknown
  }

  public enum DeliveryState: String, LenientEnum {
    case read, requeued, edited, removed, released, rehold, unknown
  }

  public struct Message: Sendable, Hashable {
    public var role: String
    public var text: String
    public var from: String?
    public var by: String?
    public var mentions: [String]?
    public var attachments: [Attachment]?
    public var delivery: Delivery?
    public var replyTo: String?
    public var isUser: Bool { role == "user" }
  }

  public enum Body: Sendable, Hashable {
    case message(Message)
    case messageDelivery(messageId: Int, state: DeliveryState, nextTurnId: String?, text: String?)
    case thinking(text: String)
    case toolCall(callId: String, name: String, input: JSONValue)
    case toolResult(callId: String, output: String, isError: Bool)
    case subagentStarted(childSessionId: String, childTurnId: String, role: String, engine: String, model: String, brief: String)
    case subagentDone(childSessionId: String, childTurnId: String, role: String, status: TurnStatus, result: String, durationMs: Double)
    case needsYou(question: String, inboxId: String, options: [QuestionOption]?, recommended: Int?, multiSelect: Bool?)
    case approval(inboxId: String, toolName: String, input: JSONValue)
    case approvalDone(inboxId: String, toolName: String, approved: Bool, stopped: Bool)
    case preview(previewId: String, title: String, format: DocFormat, content: String, artifactId: String?)
    case turnStarted(prompt: String, resumed: Bool, callerRole: String?)
    case turnDone(status: TurnStatus, durationMs: Double, error: String?, usage: Usage?)
    case status(text: String)
    /// A kind of event this version of the app does not know: skipped when drawing.
    case unknown(type: String)
  }

  private enum K: String, CodingKey {
    case id, threadId, sessionId, turnId, ts, type
    case role, text, from, by, mentions, attachments, delivery, replyTo
    case messageId, state, nextTurnId
    case callId, name, input, output, isError
    case childSessionId, childTurnId, engine, model, brief, status, result, durationMs
    case question, inboxId, options, recommended, multiSelect
    case toolName, approved, stopped
    case previewId, title, format, content, artifactId
    case prompt, resumed, callerRole, error, usage
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: K.self)
    id = try c.decode(Int.self, forKey: .id)
    threadId = try c.decode(String.self, forKey: .threadId)
    sessionId = try c.decode(String.self, forKey: .sessionId)
    turnId = try c.decodeIfPresent(String.self, forKey: .turnId)
    ts = try c.decode(Millis.self, forKey: .ts)
    let type = try c.decode(String.self, forKey: .type)
    func s(_ k: K) throws -> String { try c.decode(String.self, forKey: k) }
    func os(_ k: K) throws -> String? { try c.decodeIfPresent(String.self, forKey: k) }
    func json(_ k: K) -> JSONValue { (try? c.decodeIfPresent(JSONValue.self, forKey: k)) ?? .null }
    switch type {
    case "message":
      body = .message(Message(
        role: try s(.role), text: try os(.text) ?? "", from: try os(.from), by: try os(.by),
        mentions: try c.decodeIfPresent([String].self, forKey: .mentions),
        attachments: try c.decodeIfPresent([Attachment].self, forKey: .attachments),
        delivery: try c.decodeIfPresent(Delivery.self, forKey: .delivery),
        replyTo: try os(.replyTo)))
    case "message_delivery":
      body = .messageDelivery(messageId: try c.decode(Int.self, forKey: .messageId), state: try c.decode(DeliveryState.self, forKey: .state), nextTurnId: try os(.nextTurnId), text: try os(.text))
    case "thinking":
      body = .thinking(text: try os(.text) ?? "")
    case "tool_call":
      body = .toolCall(callId: try s(.callId), name: try s(.name), input: json(.input))
    case "tool_result":
      body = .toolResult(callId: try s(.callId), output: try os(.output) ?? "", isError: try c.decodeIfPresent(Bool.self, forKey: .isError) ?? false)
    case "subagent_started":
      body = .subagentStarted(childSessionId: try s(.childSessionId), childTurnId: try s(.childTurnId), role: try s(.role), engine: try os(.engine) ?? "", model: try os(.model) ?? "", brief: try os(.brief) ?? "")
    case "subagent_done":
      body = .subagentDone(childSessionId: try s(.childSessionId), childTurnId: try s(.childTurnId), role: try s(.role), status: try c.decode(TurnStatus.self, forKey: .status), result: try os(.result) ?? "", durationMs: try c.decodeIfPresent(Double.self, forKey: .durationMs) ?? 0)
    case "needs_you":
      body = .needsYou(question: try s(.question), inboxId: try s(.inboxId), options: try c.decodeIfPresent([QuestionOption].self, forKey: .options), recommended: try c.decodeIfPresent(Int.self, forKey: .recommended), multiSelect: try c.decodeIfPresent(Bool.self, forKey: .multiSelect))
    case "approval":
      body = .approval(inboxId: try s(.inboxId), toolName: try s(.toolName), input: json(.input))
    case "approval_done":
      body = .approvalDone(inboxId: try s(.inboxId), toolName: try s(.toolName), approved: try c.decode(Bool.self, forKey: .approved), stopped: try c.decodeIfPresent(Bool.self, forKey: .stopped) ?? false)
    case "preview":
      body = .preview(previewId: try s(.previewId), title: try s(.title), format: try c.decodeIfPresent(DocFormat.self, forKey: .format) ?? .markdown, content: try os(.content) ?? "", artifactId: try os(.artifactId))
    case "turn_started":
      body = .turnStarted(prompt: try os(.prompt) ?? "", resumed: try c.decodeIfPresent(Bool.self, forKey: .resumed) ?? false, callerRole: try os(.callerRole))
    case "turn_done":
      body = .turnDone(status: try c.decode(TurnStatus.self, forKey: .status), durationMs: try c.decodeIfPresent(Double.self, forKey: .durationMs) ?? 0, error: try os(.error), usage: try c.decodeIfPresent(Usage.self, forKey: .usage))
    case "status":
      body = .status(text: try os(.text) ?? "")
    default:
      body = .unknown(type: type)
    }
  }

  public init(id: Int, threadId: String, sessionId: String, turnId: String?, ts: Millis, body: Body) {
    self.id = id
    self.threadId = threadId
    self.sessionId = sessionId
    self.turnId = turnId
    self.ts = ts
    self.body = body
  }

  public var message: Message? {
    if case .message(let m) = body { return m }
    return nil
  }
}

// MARK: - The socket

/// What the conductor sends over the WebSocket.
public enum ServerMessage: Decodable, Sendable {
  case hello
  case event(CrewEvent)
  case thread(CrewThread)
  case session(Session)
  case turn(Turn)
  case inbox(InboxItem)
  case doc(DocSummary)
  case presence(threadId: String, viewing: [String], typing: [String])
  /// The agent message being written right now: the whole text so far. Not stored; the
  /// finished text comes as a message event, which replaces it. Empty: the draft is gone.
  case draft(threadId: String, sessionId: String, text: String)
  case dm(Dm)
  case dmMessage(DmMessage)
  case online([String])
  case unknown(String)

  private enum K: String, CodingKey {
    case kind, event, thread, session, turn, item, doc, threadId, viewing, typing, dm, message, people, sessionId, text
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: K.self)
    let kind = try c.decode(String.self, forKey: .kind)
    switch kind {
    case "hello": self = .hello
    case "event": self = .event(try c.decode(CrewEvent.self, forKey: .event))
    case "thread": self = .thread(try c.decode(CrewThread.self, forKey: .thread))
    case "session": self = .session(try c.decode(Session.self, forKey: .session))
    case "turn": self = .turn(try c.decode(Turn.self, forKey: .turn))
    case "inbox": self = .inbox(try c.decode(InboxItem.self, forKey: .item))
    case "doc": self = .doc(try c.decode(DocSummary.self, forKey: .doc))
    case "presence":
      self = .presence(threadId: try c.decode(String.self, forKey: .threadId), viewing: try c.list(.viewing), typing: try c.list(.typing))
    case "draft":
      self = .draft(threadId: try c.decode(String.self, forKey: .threadId), sessionId: try c.decode(String.self, forKey: .sessionId), text: try c.decodeIfPresent(String.self, forKey: .text) ?? "")
    case "dm": self = .dm(try c.decode(Dm.self, forKey: .dm))
    case "dm_message": self = .dmMessage(try c.decode(DmMessage.self, forKey: .message))
    case "online": self = .online(try c.list(.people))
    default: self = .unknown(kind)
    }
  }
}

/// From the app to the conductor: the thread or DM I have open (nil: none, or the app is in the background).
public struct PresenceMessage: Encodable, Sendable {
  public let kind = "presence"
  public var threadId: String?
  public var typing: Bool
  public init(threadId: String?, typing: Bool = false) {
    self.threadId = threadId
    self.typing = typing
  }
  enum CodingKeys: String, CodingKey { case kind, threadId, typing }
  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(kind, forKey: .kind)
    try c.encode(threadId, forKey: .threadId)
    try c.encode(typing, forKey: .typing)
  }
}
