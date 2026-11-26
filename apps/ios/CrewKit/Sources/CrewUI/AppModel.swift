import Foundation
import Observation
import SwiftUI
import CrewKit

/// Everything the app shows, kept in step with the conductor: a snapshot from
/// GET /api/state, then the socket's messages on top. Mirrors apps/mac/src/store.ts.
@Observable
public final class AppModel {
  public enum Phase: Equatable {
    /// No server yet, or its sign-in ran out.
    case signedOut
    case connecting
    case online
    /// Lost the connection; trying again.
    case offline
  }

  public struct Presence: Equatable {
    var viewing: [String] = []
    var typing: [String] = []
  }

  public private(set) var phase: Phase = .signedOut
  /// Why the last sign-in or connection failed, for the sign-in screen.
  var signInMessage: String?
  /// The server last used, to fill in the sign-in screen.
  var lastServer: String = UserDefaults.standard.string(forKey: "crew.lastServer") ?? ""

  private(set) var endpoint: Endpoint?
  private var client: ConductorClient?
  private var socket: ConductorSocket?
  private var connection: Task<Void, Never>?

  /// The first snapshot from the server is in.
  var loaded = false
  var teamName = "Crew"
  var suggestions: [String] = []
  var roles: [RoleSummary] = []
  var threads: [String: CrewThread] = [:]
  var done: [String: CrewThread] = [:]
  var inbox: [String: InboxItem] = [:]
  var activity: [AgentActivity] = []
  var sharing = false
  /// Team server: who is signed in. Nil for a conductor on a Mac (one person).
  var me: String?
  var people: [Person] = []
  var dms: [String: Dm] = [:]
  var online: [String] = []
  var presence: [String: Presence] = [:]
  var details: [String: ThreadData] = [:]
  /// The agent message being written right now, by session: the text so far.
  var drafts: [String: String] = [:]
  /// How far each session's streamed message is shown, so the finished message goes
  /// on from there instead of jumping to its full text.
  @ObservationIgnored var revealed: [String: (text: String, shown: Int, at: Date)] = [:]
  var loadErrors: [String: String] = [:]
  var dmMessages: [String: [DmMessage]] = [:]
  /// When I last read each DM (its updatedAt then).
  var dmSeen: [String: Double] = (UserDefaults.standard.dictionary(forKey: "crew.dm.seen") as? [String: Double]) ?? [:]

  /// The thread or DM on screen, for presence ("Juliette is looking at this").
  private var openId: String?
  private var typingSentAt = Date.distantPast
  private var refreshTask: Task<Void, Never>?

  public init() {
    #if DEBUG
    // Development: CREW_SERVER and CREW_TOKEN in the scheme (or SIMCTL_CHILD_*) sign
    // in without the sign-in screen, e.g. to the demo conductor (pnpm ios:demo).
    let env = ProcessInfo.processInfo.environment
    if let server = env["CREW_SERVER"].flatMap(Endpoint.parse) {
      let endpoint = Endpoint(url: server, appToken: env["CREW_TOKEN"] ?? "")
      self.endpoint = endpoint
      client = ConductorClient(endpoint: endpoint)
      phase = .connecting
      return
    }
    #endif
    if let saved = CredentialStore.load() {
      endpoint = saved
      client = ConductorClient(endpoint: saved)
      phase = .connecting
    }
  }

  var isTeamServer: Bool { me != nil }

  // MARK: - Sign-in

  public func signIn(_ endpoint: Endpoint) async throws {
    let client = ConductorClient(endpoint: endpoint)
    // Check it works before keeping it.
    _ = try await client.get("/api/state", as: StateResponse.self)
    CredentialStore.save(endpoint)
    lastServer = endpoint.url.absoluteString
    UserDefaults.standard.set(lastServer, forKey: "crew.lastServer")
    self.endpoint = endpoint
    self.client = client
    signInMessage = nil
    phase = .connecting
    start()
  }

  public func signOut() {
    stop()
    CredentialStore.clear()
    endpoint = nil
    client = nil
    phase = .signedOut
    loaded = false
    threads = [:]; done = [:]; inbox = [:]; details = [:]; dms = [:]; dmMessages = [:]
    me = nil; people = []; roles = []; activity = []
  }

  private func signInRanOut() {
    stop()
    CredentialStore.clear()
    client = nil
    endpoint = nil
    signInMessage = "Your sign-in ran out. Sign in again to continue."
    phase = .signedOut
  }

  // MARK: - Connection

  /// Connects and stays connected (retrying) until `stop()`. Call when the app comes to the front.
  public func start() {
    guard client != nil, connection == nil else { return }
    connection = Task { await run() }
  }

  /// Disconnects: the app went to the background. iOS would cut the socket anyway.
  public func stop() {
    connection?.cancel()
    connection = nil
    socket?.close()
    socket = nil
    if phase == .online { phase = .connecting }
  }

  private func run() async {
    var delay: Double = 1
    while !Task.isCancelled, let client {
      if let exp = client.endpoint.accessExpiresAt, exp < Date().addingTimeInterval(60) {
        signInRanOut()
        return
      }
      let socket = client.openSocket()
      self.socket = socket
      do {
        // The socket first, then the snapshot. Messages that arrive meanwhile wait
        // in the socket and are applied on top of it, so nothing falls in between.
        _ = try await socket.receive()
        try await refreshState()
        let open = Array(details.keys)
        details = details.filter { $0.key == openId }
        for id in open where id == openId { await loadThread(id) }
        dmMessages = [:]
        if let openId, dms[openId] != nil { await loadDm(openId) }
        phase = .online
        delay = 1
        sendPresence()
        while !Task.isCancelled {
          apply(try await socket.receive())
        }
      } catch ConductorError.signInRequired {
        signInRanOut()
        return
      } catch {
        if socket.refusedSignIn && client.endpoint.isTeamServer {
          signInRanOut()
          return
        }
      }
      socket.close()
      if Task.isCancelled { return }
      phase = .offline
      try? await Task.sleep(for: .seconds(delay))
      delay = min(delay * 2, 15)
    }
  }

  func refreshState() async throws {
    guard let client else { return }
    let s = try await client.get("/api/state", as: StateResponse.self)
    teamName = s.team.name
    suggestions = s.team.suggestions
    threads = Dictionary(s.threads.map { ($0.id, $0) }, uniquingKeysWith: { _, b in b })
    done = Dictionary(s.done.map { ($0.id, $0) }, uniquingKeysWith: { _, b in b })
    inbox = Dictionary(s.inbox.map { ($0.id, $0) }, uniquingKeysWith: { _, b in b })
    roles = s.roles
    activity = s.activity
    sharing = s.sharing ?? false
    me = s.me
    people = s.people ?? []
    // A snapshot taken before a DM's latest message must not undo it.
    for d in s.dms ?? [] { dms[d.id] = newer(dms[d.id], d) }
    loaded = true
  }

  private func scheduleRefresh() {
    refreshTask?.cancel()
    refreshTask = Task {
      try? await Task.sleep(for: .milliseconds(400))
      guard !Task.isCancelled else { return }
      try? await refreshState()
    }
  }

  private func newer(_ a: Dm?, _ b: Dm) -> Dm {
    guard let a else { return b }
    return a.updatedAt > b.updatedAt ? a : b
  }

  private func apply(_ msg: ServerMessage) {
    switch msg {
    case .hello, .turn, .doc, .unknown:
      break
    case .thread(let t):
      if t.archived {
        threads[t.id] = nil
        done[t.id] = t
      } else {
        threads[t.id] = t
        done[t.id] = nil
      }
      details[t.id]?.thread = t
      scheduleRefresh()
    case .inbox(let item):
      inbox[item.id] = item.isOpen ? item : nil
    case .session(let s):
      details[s.threadId]?.sessions[s.id] = s
      scheduleRefresh()
    case .presence(let threadId, let viewing, let typing):
      presence[threadId] = Presence(viewing: viewing, typing: typing)
    case .draft(_, let sessionId, let text):
      drafts[sessionId] = text.isEmpty ? nil : text
    case .dm(let dm):
      dms[dm.id] = newer(dms[dm.id], dm)
    case .online(let people):
      online = people
    case .dmMessage(let m):
      guard var list = dmMessages[m.dmId] else { break }
      if !list.contains(where: { $0.id == m.id }) {
        list.append(m)
        list.sort { $0.id < $1.id }
        dmMessages[m.dmId] = list
      }
      if m.dmId == openId { markDmSeen(m.dmId) }
    case .event(let e):
      // The finished message (or the end of the turn) replaces the draft.
      if drafts[e.sessionId] != nil {
        switch e.body {
        case .message(let m) where !m.isUser: drafts[e.sessionId] = nil
        case .turnDone: drafts[e.sessionId] = nil
        default: break
        }
      }
      guard var d = details[e.threadId], !d.events.contains(where: { $0.id == e.id }) else { break }
      d.events.append(e)
      details[e.threadId] = d
      // A session we have not seen yet (a new specialist): load it.
      var unknownSession = d.sessions[e.sessionId] == nil
      if case .subagentStarted(let child, _, _, _, _, _) = e.body, d.sessions[child] == nil { unknownSession = true }
      if unknownSession { Task { await loadThread(e.threadId) } }
      switch e.body {
      case .toolCall, .subagentStarted, .turnDone: scheduleRefresh()
      default: break
      }
    }
  }

  // MARK: - Presence

  /// The thread or DM on screen (nil: none). Others see you looking at it.
  func setOpen(_ id: String?) {
    openId = id
    sendPresence()
  }

  /// Typing in the open thread: said at most every 2 seconds; it stops by itself.
  func typing() {
    guard isTeamServer, Date().timeIntervalSince(typingSentAt) > 2 else { return }
    typingSentAt = Date()
    sendPresence(typing: true)
  }

  private func sendPresence(typing: Bool = false) {
    guard isTeamServer else { return }
    socket?.send(PresenceMessage(threadId: openId, typing: typing))
  }

  // MARK: - Threads

  func loadThread(_ id: String) async {
    guard let client else { return }
    do {
      let d = try await client.get("/api/threads/\(id)", as: ThreadDetailResponse.self)
      var data = ThreadData(d)
      // Events the socket delivered after this snapshot was taken stay.
      let lastId = d.events.last?.id ?? 0
      data.events += (details[id]?.events ?? []).filter { $0.id > lastId }
      // Keep a few threads only: the rest load again when opened.
      if details.count >= 8, details[id] == nil, let drop = details.keys.first(where: { $0 != openId }) { details[drop] = nil }
      details[id] = data
      loadErrors[id] = nil
      if !d.thread.archived { threads[id] = d.thread }
    } catch {
      loadErrors[id] = error.localizedDescription
    }
  }

  @discardableResult
  func createThread(text: String, role: String?, attachments: [AttachmentUpload]) async throws -> CrewThread {
    guard let client else { throw ConductorError.offline("Not connected.") }
    let t = try await client.post("/api/threads", CreateThreadRequest(text: text, attachments: attachments.isEmpty ? nil : attachments, role: role), as: CrewThread.self)
    threads[t.id] = t
    return t
  }

  func sendMessage(threadId: String, _ request: SendMessageRequest) async throws {
    try await client?.post("/api/threads/\(threadId)/messages", request)
  }

  func archiveThread(_ id: String) async throws {
    try await client?.post("/api/threads/\(id)/archive")
    if let t = threads[id] {
      threads[id] = nil
      var closed = t
      closed.archived = true
      done[id] = closed
    }
  }

  func renameThread(_ id: String, title: String) async throws {
    nonisolated struct Body: Encodable { var title: String }
    try await client?.post("/api/threads/\(id)/title", Body(title: title))
    threads[id]?.title = title
    details[id]?.thread.title = title
  }

  func resumeThread(_ id: String) async throws { try await client?.post("/api/threads/\(id)/resume") }
  func releaseThread(_ id: String) async throws { try await client?.post("/api/threads/\(id)/release") }
  func stopSession(_ id: String) async throws { try await client?.post("/api/sessions/\(id)/stop") }
  func resumeSession(_ id: String) async throws { try await client?.post("/api/sessions/\(id)/resume") }

  func editQueuedMessage(_ eventId: Int, text: String) async throws {
    nonisolated struct Body: Encodable { var text: String }
    try await client?.post("/api/messages/\(eventId)/edit", Body(text: text))
  }

  func removeQueuedMessage(_ eventId: Int) async throws { try await client?.post("/api/messages/\(eventId)/remove") }

  func shareThread(_ id: String) async throws -> ThreadShare? {
    nonisolated struct Answer: Decodable { var share: ThreadShare? }
    let a = try await client?.post("/api/threads/\(id)/share", Empty(), as: Answer.self)
    details[id]?.share = a?.share
    return a?.share
  }

  func unshareThread(_ id: String) async throws {
    try await client?.post("/api/threads/\(id)/unshare")
    details[id]?.share = nil
  }

  // MARK: - Inbox

  func decideApproval(_ id: String, approved: Bool, always: String? = nil) async throws {
    let action = !approved ? "deny" : always == "tool" ? "allow" : always == "all" ? "allow-all" : "approve"
    try await client?.post("/api/inbox/\(id)/\(action)")
    inbox[id] = nil
  }

  func resolveInbox(_ id: String) async throws {
    try await client?.post("/api/inbox/\(id)/resolve")
    inbox[id] = nil
  }

  func mergePullRequest(_ id: String) async throws {
    try await client?.post("/api/inbox/\(id)/merge")
  }

  /// Open items for me, newest first. Tags are only for the person tagged.
  var inboxItems: [InboxItem] {
    inbox.values
      .filter { $0.isOpen && ($0.kind != .mention || me == nil || $0.for == me) }
      .sorted { $0.createdAt > $1.createdAt }
  }

  // MARK: - Docs

  func loadDoc(_ id: String) async throws -> DocResponse {
    guard let client else { throw ConductorError.offline("Not connected.") }
    return try await client.get("/api/docs/\(id)", as: DocResponse.self)
  }

  // MARK: - Direct messages

  func loadDm(_ id: String) async {
    guard let client else { return }
    if let list = try? await client.get("/api/dms/\(id)/messages", as: [DmMessage].self) {
      let early = dmMessages[id] ?? []
      dmMessages[id] = (list + early.filter { m in !list.contains { $0.id == m.id } }).sorted { $0.id < $1.id }
    }
  }

  func sendDm(_ id: String, text: String, attachments: [AttachmentUpload]) async throws {
    guard let client else { return }
    let sent = try await client.post("/api/dms/\(id)/messages", SendDmRequest(text: text, attachments: attachments.isEmpty ? nil : attachments, clientId: UUID().uuidString), as: SentDm.self)
    gotDm(sent)
  }

  func sendDm(to emails: [String], text: String) async throws -> Dm {
    guard let client else { throw ConductorError.offline("Not connected.") }
    let sent = try await client.post("/api/dms", SendDmRequest(with: emails, text: text, clientId: UUID().uuidString), as: SentDm.self)
    gotDm(sent)
    return sent.dm
  }

  private func gotDm(_ sent: SentDm) {
    dms[sent.dm.id] = newer(dms[sent.dm.id], sent.dm)
    var list = dmMessages[sent.dm.id] ?? []
    if !list.contains(where: { $0.id == sent.message.id }) { list.append(sent.message) }
    dmMessages[sent.dm.id] = list.sorted { $0.id < $1.id }
    markDmSeen(sent.dm.id)
  }

  func markDmSeen(_ id: String) {
    guard let dm = dms[id] else { return }
    dmSeen[id] = dm.updatedAt
    UserDefaults.standard.set(dmSeen, forKey: "crew.dm.seen")
  }

  func dmUnread(_ dm: Dm) -> Bool {
    guard let last = dm.last, last.by != me else { return false }
    return dm.updatedAt > (dmSeen[dm.id] ?? 0)
  }

  func dmName(_ dm: Dm) -> String {
    let others = dm.people.filter { $0 != me }
    return others.isEmpty ? "Notes to self" : others.map(personName).joined(separator: ", ")
  }

  var sortedDms: [Dm] { dms.values.sorted { $0.updatedAt > $1.updatedAt } }

  // MARK: - Attachments

  private var images: [String: PlatformImage] = [:]

  /// An attached image. DMs' images are kept in memory only, never on disk.
  func image(threadId: String, file: String) async -> PlatformImage? {
    let key = "\(threadId)/\(file)"
    if let cached = images[key] { return cached }
    guard let client, let data = try? await client.data("/api/attachments/\(threadId)/\(file)"), let image = PlatformImage(data: data) else { return nil }
    if images.count > 60 { images.removeAll() }
    images[key] = image
    return image
  }

  // MARK: - Names

  func label(_ role: String) -> String {
    roles.first { $0.name == role }?.label ?? role.replacingOccurrences(of: "-", with: " ").capitalized
  }

  var labels: [String: String] { Dictionary(roles.map { ($0.name, $0.label) }, uniquingKeysWith: { a, _ in a }) }

  func personName(_ email: String) -> String {
    people.first { $0.email == email }?.name ?? email.split(separator: "@").first.map { String($0).capitalized } ?? email
  }

  var lead: RoleSummary? { roles.first { $0.isLead } }

  /// Open threads, the ones that need you first, then the most recent.
  var sortedThreads: [CrewThread] {
    threads.values.sorted { a, b in
      let an = a.status == .needsYou, bn = b.status == .needsYou
      return an != bn ? an : a.updatedAt > b.updatedAt
    }
  }

  var sortedDone: [CrewThread] { done.values.sorted { $0.updatedAt > $1.updatedAt } }

  var working: [AgentActivity] { activity.filter { $0.status == .running } }
}
