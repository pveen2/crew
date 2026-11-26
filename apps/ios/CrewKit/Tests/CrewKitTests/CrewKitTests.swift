import Foundation
import Testing
@testable import CrewKit

private func decode<T: Decodable>(_ json: String, as: T.Type = T.self) throws -> T {
  try CrewJSON.decoder.decode(T.self, from: Data(json.utf8))
}

private func ev(_ id: Int, session: String = "s1", turn: String? = "t1", _ body: String) throws -> CrewEvent {
  try decode(#"{"id":\#(id),"threadId":"th","sessionId":"\#(session)","turnId":\#(turn.map { "\"\($0)\"" } ?? "null"),"ts":\#(id * 1000),\#(body)}"#)
}

private let session = try! decode(#"{"id":"s1","threadId":"th","role":"gm","engine":"claude-code","model":"opus","status":"idle","engineSessionId":null,"parentSessionId":null,"depth":0,"workdir":"/x","createdAt":1,"updatedAt":1}"#, as: Session.self)

@Suite struct Decoding {
  @Test func stateResponse() throws {
    let s = try decode(#"""
    {"team":{"name":"Wakey","suggestions":["Check the store"]},
     "threads":[{"id":"a","title":"Prices","status":"needs_you","rootSessionId":"s1","createdAt":1,"updatedAt":2,"archived":false,
       "roles":["gm"],"statusText":"Needs you","benched":[],"usage":{"costUsd":null,"inputTokens":5,"outputTokens":6},"createdBy":null}],
     "done":[],"inbox":[{"id":"i","threadId":"a","sessionId":"s1","kind":"brand_new_kind","role":"gm","title":"T","body":"B","status":"open","createdAt":3}],
     "roles":[{"name":"gm","label":"GM","description":"Lead","engine":"claude-code","model":"opus","permissions":"read-only","isLead":true}],
     "activity":[],"sharing":true,"me":"paul@x.com","people":[{"email":"paul@x.com","name":"Paul"}],"dms":[]}
    """#, as: StateResponse.self)
    #expect(s.threads[0].status == .needsYou)
    #expect(s.inbox[0].kind == .unknown)
    #expect(s.roles[0].isLead)
    #expect(s.me == "paul@x.com")
  }

  @Test func everyEventType() throws {
    let bodies = [
      #""type":"message","role":"user","text":"hi","delivery":"steer","mentions":["a@x"]"#,
      #""type":"message_delivery","messageId":1,"state":"read""#,
      #""type":"thinking","text":"hmm""#,
      #""type":"tool_call","callId":"c","name":"Bash","input":{"command":"ls","n":[1,2]}"#,
      #""type":"tool_result","callId":"c","output":"ok","isError":false"#,
      #""type":"subagent_started","childSessionId":"s2","childTurnId":"t2","role":"developer","engine":"codex","model":"gpt","brief":"Do it""#,
      #""type":"subagent_done","childSessionId":"s2","childTurnId":"t2","role":"developer","status":"done","result":"Done","durationMs":5"#,
      #""type":"needs_you","question":"Which?","inboxId":"i","options":[{"label":"A"}],"recommended":0"#,
      #""type":"approval","inboxId":"i2","toolName":"shopify_update","input":null"#,
      #""type":"approval_done","inboxId":"i2","toolName":"shopify_update","approved":true"#,
      ##""type":"preview","previewId":"p","title":"Draft","format":"markdown","content":"# Hi""##,
      #""type":"turn_started","prompt":"Go","resumed":false"#,
      #""type":"turn_done","status":"error","durationMs":3,"error":"boom""#,
      #""type":"status","text":"Queued""#,
      #""type":"something_new","whatever":1"#,
    ]
    let events = try bodies.enumerated().map { try ev($0.offset + 1, $0.element) }
    #expect(events.count == bodies.count)
    if case .unknown(let t) = events.last!.body { #expect(t == "something_new") } else { Issue.record("expected unknown") }
    if case .toolCall(_, _, let input) = events[3].body { #expect(input["command"]?.text == "ls") }
  }

  @Test func socketMessages() throws {
    let m = try decode(#"{"kind":"presence","threadId":"a","viewing":["x"],"typing":[]}"#, as: ServerMessage.self)
    guard case .presence(let id, let viewing, _) = m else { Issue.record("expected presence"); return }
    #expect(id == "a" && viewing == ["x"])
    guard case .unknown = try decode(#"{"kind":"future"}"#, as: ServerMessage.self) else { Issue.record("expected unknown"); return }
  }

  @Test func presenceSendsNull() throws {
    let json = String(data: try CrewJSON.encoder.encode(PresenceMessage(threadId: nil)), encoding: .utf8)!
    #expect(json.contains(#""threadId":null"#))
  }
}

@Suite struct Delivery {
  @Test func steeredThenRead() throws {
    let events = [
      try ev(1, #""type":"turn_started","prompt":"go","resumed":false"#),
      try ev(2, #""type":"message","role":"user","text":"also this","delivery":"steer""#),
      try ev(3, #""type":"message_delivery","messageId":2,"state":"read""#),
    ]
    let info = ThreadLogic.deliveryOf(events[1], events: events, session: session)
    #expect(info.state == nil && info.landedAt == 3)
  }

  @Test func steeredStillWaiting() throws {
    let events = [try ev(2, #""type":"message","role":"user","text":"x","delivery":"steer""#)]
    #expect(ThreadLogic.deliveryOf(events[0], events: events, session: session).state == .steering)
  }

  @Test func queuedLandsWhenItsTurnStarts() throws {
    let events = [
      try ev(2, turn: "t2", #""type":"message","role":"user","text":"next","delivery":"queue""#),
      try ev(3, turn: "t2", #""type":"turn_started","prompt":"next","resumed":false"#),
    ]
    #expect(ThreadLogic.deliveryOf(events[0], events: events, session: session).landedAt == 3)
    // In the chat it sits just before where the agent picked it up.
    let chat = ThreadLogic.chatEvents(events: events, session: session)
    #expect(chat.map(\.id) == [2, 3])
  }

  @Test func editedTextIsWhatTheAgentGets() throws {
    var running = session
    running.status = .running
    let events = [
      try ev(2, turn: "t2", #""type":"message","role":"user","text":"old","delivery":"queue""#),
      try ev(3, #""type":"message_delivery","messageId":2,"state":"edited","text":"new""#),
    ]
    let info = ThreadLogic.deliveryOf(events[0], events: events, session: running)
    #expect(info.state == .queued && info.text == "new")
    #expect(ThreadLogic.waitingMessages(events: events, session: running).count == 1)
  }

  @Test func stoppedBeforeReading() throws {
    let events = [
      try ev(2, #""type":"message","role":"user","text":"x","delivery":"steer""#),
      try ev(3, #""type":"turn_done","status":"cancelled","durationMs":1"#),
    ]
    #expect(ThreadLogic.deliveryOf(events[0], events: events, session: session).state == .dropped)
  }
}

@Suite struct ChatItems {
  @Test func groupsWorkAndHidesCrewTools() throws {
    let events = [
      try ev(1, #""type":"message","role":"user","text":"hi""#),
      try ev(2, #""type":"thinking","text":"hmm""#),
      try ev(3, #""type":"tool_call","callId":"a","name":"Bash","input":{}"#),
      try ev(4, #""type":"tool_result","callId":"a","output":"ok","isError":false"#),
      try ev(5, #""type":"tool_call","callId":"b","name":"mcp__crew__show_preview","input":{}"#),
      try ev(6, #""type":"tool_call","callId":"c","name":"mcp__crew__developer","input":{}"#),
      try ev(7, #""type":"message","role":"assistant","text":"done""#),
      try ev(8, #""type":"turn_done","status":"done","durationMs":1"#),
    ]
    let items = ThreadLogic.buildItems(events: events, session: session, agents: ["gm", "developer"])
    #expect(items.map(\.id) == ["e1", "work-2", "e7"])
    if case .work(_, let list) = items[1] { #expect(list.map(\.id) == [2, 3]) }
  }

  @Test func answerShowsInItsQuestionCard() throws {
    let events = [
      try ev(1, #""type":"needs_you","question":"Which?","inboxId":"q""#),
      try ev(2, #""type":"message","role":"assistant","text":"Which one do you want?""#),
      try ev(3, turn: "t2", #""type":"message","role":"user","text":"A","replyTo":"q""#),
    ]
    let items = ThreadLogic.buildItems(events: events, session: session, agents: [])
    // The restated question and the answer bubble both fold into the card.
    #expect(items.count == 1)
    if case .event(_, let answer) = items[0] { #expect(answer == "A") }
  }

  @Test func otherSessionsStayOut() throws {
    let events = [try ev(1, session: "s2", #""type":"message","role":"assistant","text":"x""#)]
    #expect(ThreadLogic.buildItems(events: events, session: session, agents: []).isEmpty)
  }

  @Test func toolLabel() {
    #expect(ThreadLogic.toolLabel(name: "mcp__shopify__query", input: .object(["query": .string("products")])) == "shopify.query products")
    #expect(ThreadLogic.toolLabel(name: "Bash", input: .object(["command": .string("/bin/zsh -lc ls")])) == "Bash ls")
  }

  @Test func duration() {
    #expect(ThreadLogic.duration(ms: 45_000) == "45s")
    #expect(ThreadLogic.duration(ms: 80 * 60_000) == "1h 20m")
  }
}

@Suite struct MentionTests {
  let people = [Person(email: "paul.veen@x", name: "Paul Veen"), Person(email: "paul.b@x", name: "Paul B"), Person(email: "jo@x", name: "Jo"), Person(email: "me@x", name: "Me")]
  let roles = try! decode(#"[{"name":"gm","label":"GM","description":"","engine":"claude-code","model":"m","permissions":"draft","isLead":true},{"name":"store-manager","label":"Store manager","description":"","engine":"codex","model":"m","permissions":"draft","isLead":false}]"#, as: [RoleSummary].self)

  @Test func peopleLongestNameFirst() {
    #expect(Mentions.mentionedPeople("@Paul Veen and @jo, look", people: people, me: "me@x") == ["paul.veen@x", "jo@x"])
    #expect(Mentions.mentionedPeople("mail jo@x", people: people, me: "me@x").isEmpty)
  }

  @Test func leadingPerson() {
    #expect(Mentions.leadingPerson("@Jo, can you", people: people, me: "me@x")?.email == "jo@x")
    #expect(Mentions.leadingPerson("@Joanna hi", people: people, me: "me@x") == nil)
  }

  @Test func roleRouting() {
    #expect(Mentions.mentionedRole("@store-manager check stock", roles: roles) == .to("store-manager", rest: "check stock"))
    #expect(Mentions.mentionedRole("@Store manager check", roles: roles) == .to("store-manager", rest: "check"))
    #expect(Mentions.mentionedRole("@store-manager", roles: roles) == .error("Write a message after the @ name."))
    #expect(Mentions.mentionsSpecialist("please ask @store-manager.", roles: roles))
    #expect(!Mentions.mentionsSpecialist("see @store-manager/tools", roles: roles))
  }

  @Test func sessionRouting() {
    let options = [Mentions.SessionOption(value: "s1", role: "gm", label: "GM"), Mentions.SessionOption(value: "s2", role: "developer", label: "Developer")]
    #expect(Mentions.resolveMention("@developer fix it", options: options, currentSessionId: "s1") == .to("s2", rest: "fix it"))
    if case .error = Mentions.resolveMention("@nobody hi", options: options, currentSessionId: "s1") {} else { Issue.record("expected error") }
  }

  @Test func names() {
    let n = Names.namePeople(["juliette@a.com", "paul.veen@a.com", "paul.b@a.com", "sam@a.com", "sam@b.com"])
    #expect(n["juliette@a.com"] == "Juliette")
    #expect(n["paul.veen@a.com"] == "Paul Veen")
    #expect(n["sam@b.com"] == "Sam (b.com)")
  }
}

@Suite struct MarkdownTests {
  @Test func blocks() {
    let b = Markdown.blocks("""
    # Title

    Some **bold** text
    on two lines.

    - one
    - [x] two
      - nested
    1. first
    2. second

    ```swift
    let x = 1
    ```

    > quoted

    | a | b |
    |---|---|
    | 1 | 2 |

    ---
    """)
    #expect(b.count == 8)
    #expect(b[0] == .heading(level: 1, text: "Title"))
    #expect(b[1] == .paragraph("Some **bold** text\non two lines."))
    if case .list(false, _, let items) = b[2] {
      #expect(items.map(\.depth) == [0, 0, 1])
      #expect(items[1].checked == true)
    } else { Issue.record("expected list") }
    if case .list(true, 1, let items) = b[3] { #expect(items.count == 2) } else { Issue.record("expected ordered list") }
    #expect(b[4] == .code(language: "swift", text: "let x = 1"))
    #expect(b[5] == .quote("quoted"))
    #expect(b[6] == .table(header: ["a", "b"], rows: [["1", "2"]]))
    #expect(b[7] == .rule)
  }
}

@Suite struct EndpointTests {
  @Test func parse() {
    #expect(Endpoint.parse("crew.example.com/")?.absoluteString == "https://crew.example.com")
    #expect(Endpoint.parse("127.0.0.1:4317")?.absoluteString == "http://127.0.0.1:4317")
    #expect(Endpoint.parse("") == nil)
    #expect(Endpoint.isTeamServer(URL(string: "https://crew.example.com")!))
    #expect(!Endpoint.isTeamServer(URL(string: "http://127.0.0.1:4317")!))
  }

  @Test func accessExpiry() {
    // {"exp":2000000000}
    let jwt = "eyJhbGciOiJSUzI1NiJ9.eyJleHAiOjIwMDAwMDAwMDB9.sig"
    #expect(Endpoint.expiry(of: jwt) == Date(timeIntervalSince1970: 2_000_000_000))
  }
}

@Suite struct StreamingTests {
  @Test func closesHalfWrittenMarkdown() {
    #expect(Markdown.closeOpen("Use **DPD") == "Use **DPD**")
    #expect(Markdown.closeOpen("Run `ls") == "Run `ls`")
    #expect(Markdown.closeOpen("```swift\nlet x") == "```swift\nlet x\n```")
    #expect(Markdown.closeOpen("Bold coming **") == "Bold coming ")
    #expect(Markdown.closeOpen("All **done** here") == "All **done** here")
  }

  @Test func draftMessage() throws {
    let m = try decode(#"{"kind":"draft","threadId":"t","sessionId":"s","text":"Hel"}"#, as: ServerMessage.self)
    guard case .draft(_, let session, let text) = m else { Issue.record("expected draft"); return }
    #expect(session == "s" && text == "Hel")
  }
}
