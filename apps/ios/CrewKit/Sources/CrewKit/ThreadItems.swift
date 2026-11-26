import Foundation

// How a thread's events become the chat, ported from apps/mac/src/components/ThreadView.tsx
// (buildItems, deliveryOf, chatEvents, waitingMessages). Keep the two in step.

/// One thread, as loaded: the detail snapshot plus what the socket added since.
public struct ThreadData: Sendable {
  public var thread: CrewThread
  public var sessions: [String: Session]
  public var turns: [String: Turn]
  public var events: [CrewEvent]
  public var share: ThreadShare?

  public init(_ d: ThreadDetailResponse) {
    thread = d.thread
    sessions = Dictionary(d.sessions.map { ($0.id, $0) }, uniquingKeysWith: { _, b in b })
    turns = Dictionary(d.turns.map { ($0.id, $0) }, uniquingKeysWith: { _, b in b })
    events = d.events
    share = d.share
  }
}

public enum ChatItem: Sendable, Identifiable {
  /// answer: for a question card, the owner's reply to it (shown in the card, not as a bubble).
  case event(CrewEvent, answer: String?)
  /// The agent's own tool calls and thinking, collapsed: "Worked 6s · 3 steps".
  case work(id: String, events: [CrewEvent])
  /// Specialists the lead called, in a row.
  case subagents(id: String, starts: [CrewEvent])

  public var id: String {
    switch self {
    case .event(let e, _): return "e\(e.id)"
    case .work(let id, _), .subagents(let id, _): return id
    }
  }
}

/// Where an owner message sent while the agent was working stands.
public enum DeliveryState: Sendable, Equatable {
  /// Written into the running turn; the agent reads it at its next step.
  case steering
  /// Waits for the current turn to end.
  case queued
  /// Waits for Resume.
  case onResume
  /// The work was stopped before the agent had it.
  case dropped
  case removed
}

public struct DeliveryInfo: Sendable, Equatable {
  /// Nil once the agent has it.
  public var state: DeliveryState?
  /// The text as the agent gets it (the owner may have edited it while it waited).
  public var text: String
  /// Where the agent picked it up: the event id it lands after.
  public var landedAt: Int?
}

public enum ThreadLogic {
  /// Crew's own tools show up as cards, not as tool calls.
  public static func isHiddenTool(_ name: String) -> Bool {
    for t in ["show_preview", "ask_owner", "save_artifact"] where name == t || name.hasSuffix("__" + t) { return true }
    return false
  }

  /// The lead calls a specialist through a tool named after it (store-manager → store_manager).
  public static func isSubagentTool(_ name: String, agents: [String]) -> Bool {
    let tool = name.hasPrefix("mcp__crew__") ? String(name.dropFirst("mcp__crew__".count)) : name
    return agents.contains { $0.replacingOccurrences(of: "-", with: "_") == tool }
  }

  public static func deliveryOf(_ event: CrewEvent, events: [CrewEvent], session: Session?) -> DeliveryInfo {
    guard let m = event.message else { return DeliveryInfo(state: nil, text: "", landedAt: nil) }
    var info = DeliveryInfo(state: nil, text: m.text, landedAt: nil)
    // Held (people tagged each other): part of the conversation, never a waiting chip.
    guard m.delivery != .held, m.isUser, let firstTurn = event.turnId, var mode = m.delivery else { return info }
    var turnId = firstTurn
    var turnDone: TurnStatus?
    for e in events where e.id > event.id && e.sessionId == event.sessionId {
      if case .messageDelivery(let messageId, let state, let next, let text) = e.body, messageId == event.id {
        switch state {
        case .read: info.landedAt = e.id; return info
        case .removed: info.state = .removed; return info
        case .edited: info.text = text ?? info.text
        case .requeued:
          mode = .queue
          turnId = next ?? turnId
        default: break
        }
        continue
      }
      guard e.turnId == turnId else { continue }
      if mode == .queue, case .turnStarted = e.body { info.landedAt = e.id; return info }
      if mode == .queue, case .status = e.body { info.state = .dropped; return info }
      if case .turnDone(let status, _, _, _) = e.body { turnDone = status }
    }
    if mode == .steer {
      if turnDone == .cancelled { info.state = .dropped; return info }
      info.state = turnDone == nil ? .steering : nil
      return info
    }
    switch session?.status {
    case .interrupted: info.state = .onResume
    case .running, .queued: info.state = .queued
    default: info.state = .dropped
    }
    return info
  }

  /// Owner messages the agent does not have yet: shown above the composer.
  public static func waitingMessages(events: [CrewEvent], session: Session) -> [(event: CrewEvent, info: DeliveryInfo)] {
    events.compactMap { e in
      guard e.sessionId == session.id, let m = e.message, m.delivery != nil else { return nil }
      let info = deliveryOf(e, events: events, session: session)
      return [.steering, .queued, .onResume].contains(info.state) ? (e, info) : nil
    }
  }

  /// The chat's events in display order: a message sent while the agent worked shows where the agent picked it up.
  public static func chatEvents(events: [CrewEvent], session: Session) -> [CrewEvent] {
    var placed: [(key: Double, event: CrewEvent)] = []
    for e in events where e.sessionId == session.id {
      if var m = e.message, m.delivery != nil {
        let info = deliveryOf(e, events: events, session: session)
        m.text = info.text
        var shown = e
        shown.body = .message(m)
        if info.state == .dropped { placed.append((Double(e.id), shown)) }
        else if info.state == nil { placed.append((Double(info.landedAt ?? e.id) - 0.5, shown)) }
        continue
      }
      placed.append((Double(e.id), e))
    }
    return placed.enumerated().sorted { a, b in
      a.element.key != b.element.key ? a.element.key < b.element.key : a.offset < b.offset
    }.map(\.element.event)
  }

  public static func buildItems(events: [CrewEvent], session: Session, agents: [String]) -> [ChatItem] {
    let chat = chatEvents(events: events, session: session)
    // A reply to a question card shows inside that card, unless it carries images or was never delivered.
    var asked = Set<String>()
    for e in chat { if case .needsYou(_, let inboxId, _, _, _) = e.body { asked.insert(inboxId) } }
    var answers: [String: (eventId: Int, text: String)] = [:]
    for e in chat {
      guard let m = e.message, let reply = m.replyTo, asked.contains(reply), answers[reply] == nil, (m.attachments ?? []).isEmpty else { continue }
      if deliveryOf(e, events: events, session: session).state == .dropped { continue }
      answers[reply] = (e.id, m.text)
    }
    let inCard = Set(answers.values.map(\.eventId))
    let steered = Set(events.compactMap { e -> String? in
      guard let m = e.message, m.isUser, m.delivery == .steer else { return nil }
      return e.turnId
    })

    var items: [ChatItem] = []
    var askedIn: String?
    for e in chat {
      // After asking, the agent's text in the same turn only restates the question.
      var restates = false
      if let m = e.message, !m.isUser, let a = askedIn, e.turnId == a, !steered.contains(a) { restates = true }
      switch e.body {
      case .needsYou: askedIn = e.turnId
      case .toolCall: askedIn = nil
      case .message(let m) where m.isUser: askedIn = nil
      default: break
      }
      if restates { continue }
      if e.message != nil, inCard.contains(e.id) { continue }

      switch e.body {
      case .needsYou(_, let inboxId, _, _, _):
        items.append(.event(e, answer: answers[inboxId]?.text))
        continue
      case .toolResult, .subagentDone, .messageDelivery, .unknown:
        continue
      case .toolCall(_, let name, _) where isHiddenTool(name) || isSubagentTool(name, agents: agents):
        continue
      case .turnDone(let status, _, _, _) where status == .done:
        continue
      case .turnStarted(_, let resumed, let caller) where caller == nil && !resumed:
        continue
      case .toolCall, .thinking:
        if case .work(let id, var list) = items.last {
          list.append(e)
          items[items.count - 1] = .work(id: id, events: list)
        } else {
          items.append(.work(id: "work-\(e.id)", events: [e]))
        }
        continue
      case .subagentStarted:
        if case .subagents(let id, var list) = items.last {
          list.append(e)
          items[items.count - 1] = .subagents(id: id, starts: list)
        } else {
          items.append(.subagents(id: "sub-\(e.id)", starts: [e]))
        }
        continue
      default:
        items.append(.event(e, answer: nil))
      }
    }
    return items
  }

  /// "Bash ls -la", "shopify.query products": one line for a tool call.
  public static func toolLabel(name: String, input: JSONValue) -> String {
    var short = name.hasPrefix("mcp__") ? String(name.dropFirst(5)) : name
    short = short.replacingOccurrences(of: "__", with: ".")
    let arg = ["file_path", "pattern", "query", "command", "url", "skill", "description"].lazy.compactMap { input[$0] }.first
    guard let arg else { return short }
    var text = arg.text.replacingOccurrences(of: "/bin/zsh -lc ", with: "")
    text = text.split(whereSeparator: \.isNewline).joined(separator: " ")
    return "\(short) \(text.count > 80 ? String(text.prefix(79)) + "…" : text)"
  }

  public enum SubagentStatus: Sendable { case running, queued, done, interrupted, error, cancelled }

  public static func subagentState(_ start: CrewEvent, data: ThreadData) -> (status: SubagentStatus, result: String?, durationMs: Double?) {
    guard case .subagentStarted(let child, let childTurn, _, _, _, _) = start.body else { return (.running, nil, nil) }
    for e in data.events {
      if case .subagentDone(_, let turn, _, let status, let result, let ms) = e.body, turn == childTurn {
        let s: SubagentStatus = switch status {
        case .done: .done
        case .interrupted: .interrupted
        case .error: .error
        case .cancelled: .cancelled
        default: .running
        }
        return (s, result, ms)
      }
    }
    switch data.sessions[child]?.status {
    case .interrupted: return (.interrupted, nil, nil)
    case .error: return (.error, nil, nil)
    case .queued: return (.queued, nil, nil)
    default: return (.running, nil, nil)
    }
  }

  /// "45s", "3m", "1h 20m".
  public static func duration(ms: Double) -> String {
    let s = max(0, Int((ms / 1000).rounded()))
    if s < 60 { return "\(s)s" }
    let m = s / 60
    if m < 60 { return "\(m)m" }
    return m % 60 == 0 ? "\(m / 60)h" : "\(m / 60)h \(m % 60)m"
  }
}
