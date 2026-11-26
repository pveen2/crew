import SwiftUI
import PhotosUI
import CrewKit

/// One thread: the conversation with the lead (or a specialist you stepped in with), and the composer.
struct ThreadView: View {
  @Environment(AppModel.self) private var model
  let threadId: String
  @State private var sessionId: String?
  @State private var renaming = false
  @State private var newTitle = ""
  @State private var action = Action()
  @State private var doc: DocRef?

  init(threadId: String, sessionId: String? = nil) {
    self.threadId = threadId
    _sessionId = State(initialValue: sessionId)
  }

  private var thread: CrewThread? { model.threads[threadId] ?? model.done[threadId] ?? model.details[threadId]?.thread }

  var body: some View {
    Group {
      if let thread, let data = model.details[threadId], let session = data.sessions[sessionId ?? thread.rootSessionId] {
        content(thread: thread, data: data, session: session)
      } else if let error = model.loadErrors[threadId] {
        ContentUnavailableView("This thread could not be opened", systemImage: "exclamationmark.bubble", description: Text(error))
      } else if model.details[threadId] != nil {
        ContentUnavailableView("That agent is not part of this thread", systemImage: "person.crop.circle.badge.questionmark")
      } else {
        ProgressView()
      }
    }
    .task(id: threadId) {
      if model.details[threadId] == nil { await model.loadThread(threadId) }
    }
    .onAppear { model.setOpen(threadId) }
    .onDisappear { model.setOpen(nil) }
    .sheet(item: $doc) { DocSheet(ref: $0) }
    .errorAlert(action)
  }

  @ViewBuilder
  private func content(thread: CrewThread, data: ThreadData, session: Session) -> some View {
    let items = ThreadLogic.buildItems(events: data.events, session: session, agents: model.roles.map(\.name))
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 18) {
        if items.isEmpty {
          Text(session.depth > 0 ? "Nothing from \(model.label(session.role)) yet." : "Nothing here yet.")
            .foregroundStyle(.secondary)
        }
        ForEach(items) { item in
          ChatItemView(item: item, threadId: threadId, data: data, session: session, isLast: item.id == items.last?.id, openDoc: { doc = $0 }, stepIn: { sessionId = $0 })
        }
        if let draft = model.drafts[session.id] {
          RevealingMarkdown(sessionId: session.id, text: draft, streaming: true, start: model.revealed[session.id].flatMap { draft.hasPrefix(String($0.text.prefix($0.shown))) ? $0.shown : nil } ?? 0)
            .id("draft-\(session.id)")
        } else {
          WorkingLine(thread: thread, session: session)
        }
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 12)
    }
    .defaultScrollAnchor(.bottom)
    .defaultScrollAnchor(.bottom, for: .sizeChanges)
    .dismissesKeyboardOnScroll()
    .safeAreaBar(edge: .bottom) {
      ComposerDock(threadId: threadId, data: data, session: session, rootId: thread.rootSessionId, sessionId: $sessionId)
    }
    .navigationTitle(session.depth > 0 ? model.label(session.role) : thread.title)
    .navigationSubtitle(subtitle(thread: thread, session: session))
    .inlineTitle()
    .toolbar { toolbar(thread: thread, data: data, session: session) }
    .alert("Rename thread", isPresented: $renaming) {
      TextField("Title", text: $newTitle)
      Button("Cancel", role: .cancel) {}
      Button("Rename") {
        let t = newTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        if !t.isEmpty { action.run { try await model.renameThread(threadId, title: t) } }
      }
    }
  }

  private func subtitle(thread: CrewThread, session: Session) -> String {
    if session.depth > 0 { return "Stepped in · \(session.model)" }
    var parts = [thread.roles.map(model.label).joined(separator: ", ")]
    if let by = thread.createdBy, let me = model.me, by != me { parts.insert("Started by \(model.personName(by))", at: 0) }
    return parts.joined(separator: " · ")
  }

  @ToolbarContentBuilder
  private func toolbar(thread: CrewThread, data: ThreadData, session: Session) -> some ToolbarContent {
    let options = Mentions.sessionOptions(sessions: Array(data.sessions.values), labels: model.labels)
    if options.count > 1 {
      ToolbarItem(placement: .primaryAction) {
        Menu {
          Picker("Talk to", selection: Binding(get: { session.id }, set: { sessionId = $0 == thread.rootSessionId ? nil : $0 })) {
            ForEach(options) { o in Text(o.label).tag(o.value) }
          }
        } label: {
          RoleFaces(roles: thread.roles, size: 22)
        }
      }
    }
    ToolbarItem(placement: .primaryAction) {
      Menu("More", systemImage: "ellipsis") {
        if session.depth == 0 {
          Button("Rename", systemImage: "pencil") {
            newTitle = thread.title
            renaming = true
          }
          if model.sharing {
            if let share = data.share, let url = URL(string: share.url) {
              ShareLink("Share link", item: url)
              Button("Update shared link", systemImage: "arrow.clockwise") { action.run { _ = try await model.shareThread(threadId) } }
              Button("Stop sharing", systemImage: "link.badge.plus", role: .destructive) { action.run { try await model.unshareThread(threadId) } }
            } else {
              Button("Create share link", systemImage: "link") {
                action.run {
                  if let share = try await model.shareThread(threadId) { Clipboard.copy(share.url) }
                }
              }
            }
          }
        }
        if session.status == .running || session.status == .queued {
          Button("Stop \(model.label(session.role))", systemImage: "stop.circle") { action.run { try await model.stopSession(session.id) } }
        }
        if !thread.archived {
          Button("Close thread", systemImage: "checkmark.circle") { action.run { try await model.archiveThread(threadId) } }
        }
      }
    }
  }
}

// MARK: - Items

private struct ChatItemView: View {
  @Environment(AppModel.self) private var model
  var item: ChatItem
  var threadId: String
  var data: ThreadData
  var session: Session
  var isLast: Bool
  var openDoc: (DocRef) -> Void
  var stepIn: (String) -> Void

  var body: some View {
    switch item {
    case .work(_, let events):
      WorkGroup(events: events, data: data, running: session.status == .running && isLast)
    case .subagents(_, let starts):
      SubagentGroup(starts: starts, data: data, stepIn: stepIn)
    case .event(let e, let answer):
      EventView(event: e, answer: answer, threadId: threadId, data: data, session: session, openDoc: openDoc)
    }
  }
}

private struct EventView: View {
  @Environment(AppModel.self) private var model
  var event: CrewEvent
  var answer: String?
  var threadId: String
  var data: ThreadData
  var session: Session
  var openDoc: (DocRef) -> Void

  var body: some View {
    switch event.body {
    case .message(let m):
      if m.isUser {
        UserMessage(event: event, message: m, threadId: threadId, dropped: ThreadLogic.deliveryOf(event, events: data.events, session: session).state == .dropped)
      } else {
        AgentMessage(sessionId: event.sessionId, text: m.text, ts: event.ts)
      }
    case .needsYou(let question, let inboxId, let options, let recommended, let multi):
      QuestionCard(threadId: threadId, sessionId: event.sessionId, role: session.role, question: question, inboxId: inboxId, options: options ?? [], recommended: recommended, multiSelect: multi ?? false, answer: answer)
    case .approval(let inboxId, _, _):
      if let item = model.inbox[inboxId], item.kind == .approval { ApprovalCard(item: item) }
    case .approvalDone(_, let tool, let approved, let stopped):
      StatusLine(tone: approved ? .secondary : .caution, icon: approved ? "checkmark" : "exclamationmark.triangle",
                 text: "\(approved ? "Approved" : stopped ? "Not decided, the work was stopped" : "Denied"): \(tool.replacingOccurrences(of: "mcp__crew__", with: ""))")
    case .preview(let previewId, let title, let format, let content, let artifactId):
      Button {
        openDoc(DocRef(id: artifactId ?? previewId, title: title, format: format, content: artifactId == nil ? content : nil))
      } label: {
        HStack(spacing: 12) {
          Image(systemName: "doc.text").font(.title3).foregroundStyle(.secondary)
            .frame(width: 40, height: 40)
            .background(Color.raised, in: .rect(cornerRadius: 10))
          VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.body.weight(.medium)).lineLimit(2).multilineTextAlignment(.leading)
            Text("Draft · not published").font(.footnote).foregroundStyle(.secondary)
          }
          Spacer()
          Image(systemName: "chevron.right").foregroundStyle(.tertiary)
        }
        .padding(12)
        .background(Color.surface, in: .rect(cornerRadius: 20))
      }
      .buttonStyle(.plain)
    case .turnStarted(let prompt, _, let caller):
      if let caller {
        HStack(alignment: .top, spacing: 10) {
          RoleFace(role: caller, size: 28)
          VStack(alignment: .leading, spacing: 4) {
            Text("Brief from \(model.label(caller)) · \(Ago.clock(event.ts))").font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
            MarkdownView(text: cleanBrief(prompt), font: .subheadline)
          }
        }
      } else {
        StatusLine(icon: "play.circle", text: "Resumed after a restart")
      }
    case .turnDone(let status, _, let error, _):
      StatusLine(tone: status == .interrupted || status == .cancelled ? .caution : .critical, icon: "exclamationmark.triangle",
                 text: (status == .interrupted ? "Interrupted" : status == .cancelled ? "Stopped" : "Failed") + (error.map { ": \($0.prefix(300))" } ?? ""))
    case .status(let text):
      StatusLine(text: text)
    default:
      EmptyView()
    }
  }

  private func cleanBrief(_ p: String) -> String {
    var s = p
    for pattern in [#"^\(.*?\)\n\n"#, #"^Brief from [^\n]*\n\n"#, #"\n\nYour final message is returned[^\n]*$"#] {
      s = s.replacingOccurrences(of: pattern, with: "", options: .regularExpression)
    }
    return s
  }
}

private struct UserMessage: View {
  @Environment(AppModel.self) private var model
  var event: CrewEvent
  var message: CrewEvent.Message
  var threadId: String
  var dropped: Bool

  var body: some View {
    let colleague = model.me != nil && message.by != nil && message.by != model.me ? message.by : nil
    VStack(alignment: colleague == nil ? .trailing : .leading, spacing: 6) {
      if let colleague {
        HStack(spacing: 6) {
          PersonFace(email: colleague, size: 18)
          Text("\(model.personName(colleague)) · \(Ago.clock(event.ts))").font(.caption.weight(.medium)).foregroundStyle(.secondary)
        }
      }
      if let attachments = message.attachments, !attachments.isEmpty {
        ScrollView(.horizontal, showsIndicators: false) {
          HStack { ForEach(attachments, id: \.file) { AttachmentImage(threadId: threadId, attachment: $0) } }
        }
        .defaultScrollAnchor(colleague == nil ? .trailing : .leading)
      }
      if !message.text.isEmpty {
        MarkdownView(text: message.text)
          .fixedSize(horizontal: false, vertical: true)
          // As in ChatGPT: yours in a grey bubble on the right; a colleague's as plain
          // text under their name, like the agents'.
          .padding(.horizontal, colleague == nil ? 16 : 0)
          .padding(.vertical, colleague == nil ? 10 : 0)
          .background(colleague == nil ? Color.surface : .clear, in: .rect(cornerRadius: 22))
          .frame(maxWidth: colleague == nil ? 320 : .infinity, alignment: colleague == nil ? .trailing : .leading)
      }
      if dropped {
        Label("Not delivered · the work was stopped", systemImage: "exclamationmark.circle").font(.caption).foregroundStyle(.secondary)
      }
    }
    .frame(maxWidth: .infinity, alignment: colleague == nil ? .trailing : .leading)
  }
}

/// "Worked 6s · 3 steps": the agent's own tool calls and thinking, collapsed.
private struct WorkGroup: View {
  var events: [CrewEvent]
  var data: ThreadData
  var running: Bool
  @State private var open = false

  private var results: [String: (output: String, isError: Bool, ts: Millis)] {
    var out: [String: (output: String, isError: Bool, ts: Millis)] = [:]
    for e in data.events {
      if case .toolResult(let id, let output, let err) = e.body { out[id] = (output, err, e.ts) }
    }
    return out
  }

  var body: some View {
    let results = self.results
    let calls = events.compactMap { e -> (CrewEvent, String, String, JSONValue)? in
      if case .toolCall(let id, let name, let input) = e.body { return (e, id, name, input) }
      return nil
    }
    let pending = calls.contains { results[$0.1] == nil }
    let isRunning = running && pending
    let end = max(events.map(\.ts).max() ?? 0, calls.compactMap { results[$0.1]?.ts }.max() ?? 0)
    let failed = calls.filter { results[$0.1]?.isError == true }.count
    let steps = calls.isEmpty ? "" : " · \(calls.count) \(calls.count == 1 ? "step" : "steps")"
    let summary = isRunning ? "Working\(steps)" : "Worked \(ThreadLogic.duration(ms: max(1000, end - (events.first?.ts ?? end))))\(steps)"

    DisclosureGroup(isExpanded: $open) {
      VStack(alignment: .leading, spacing: 10) {
        ForEach(events) { e in
          switch e.body {
          case .thinking(let text):
            MarkdownView(text: text, font: .footnote).foregroundStyle(.secondary)
          case .toolCall(let id, let name, let input):
            VStack(alignment: .leading, spacing: 4) {
              Text(ThreadLogic.toolLabel(name: name, input: input))
                .font(.system(.caption, design: .monospaced).weight(.medium))
                .lineLimit(2)
              if let r = results[id], !r.output.isEmpty {
                Text(String(r.output.prefix(1200)))
                  .font(.system(.caption2, design: .monospaced))
                  .foregroundStyle(r.isError ? Color.red : .secondary)
                  .lineLimit(12)
                  .padding(8)
                  .frame(maxWidth: .infinity, alignment: .leading)
                  .background(.quaternary.opacity(0.5), in: .rect(cornerRadius: 8))
              }
            }
          default:
            EmptyView()
          }
        }
      }
      .padding(.top, 8)
    } label: {
      HStack(spacing: 6) {
        if isRunning { ProgressView().controlSize(.mini) }
        Text(summary)
        if failed > 0 { Text("· \(failed) failed").foregroundStyle(.red) }
      }
      .font(.subheadline)
      .foregroundStyle(.secondary)
    }
    .tint(.secondary)
  }
}

/// Specialists the lead called: one row each, tap to step in.
private struct SubagentGroup: View {
  @Environment(AppModel.self) private var model
  var starts: [CrewEvent]
  var data: ThreadData
  var stepIn: (String) -> Void

  var body: some View {
    VStack(spacing: 0) {
      ForEach(starts) { start in
        if case .subagentStarted(let child, _, let role, _, _, let brief) = start.body {
          let state = ThreadLogic.subagentState(start, data: data)
          Button { stepIn(child) } label: {
            HStack(alignment: .top, spacing: 12) {
              RoleFace(role: role, size: 32)
              VStack(alignment: .leading, spacing: 2) {
                HStack {
                  Text(model.label(role)).font(.subheadline.weight(.semibold))
                  Spacer()
                  badge(state.status, ms: state.durationMs)
                }
                Text(inline(oneLine(state.result ?? brief)))
                  .font(.footnote)
                  .foregroundStyle(.secondary)
                  .lineLimit(2)
                  .multilineTextAlignment(.leading)
              }
            }
            .padding(12)
            .contentShape(.rect)
          }
          .buttonStyle(.plain)
          if start.id != starts.last?.id { Divider().padding(.leading, 56) }
        }
      }
    }
    .background(Color.surface, in: .rect(cornerRadius: 20))
  }

  private func oneLine(_ s: String) -> String {
    s.split(whereSeparator: \.isNewline).first.map(String.init) ?? s
  }

  @ViewBuilder
  private func badge(_ s: ThreadLogic.SubagentStatus, ms: Double?) -> some View {
    switch s {
    case .running: HStack(spacing: 4) { ProgressView().controlSize(.mini); Text("Working") }.font(.caption).foregroundStyle(.blue)
    case .queued: Text("Queued").font(.caption).foregroundStyle(.secondary)
    case .done: Text(ms.map { "Done · \(ThreadLogic.duration(ms: $0))" } ?? "Done").font(.caption).foregroundStyle(.secondary)
    case .interrupted: Text("Interrupted").font(.caption).foregroundStyle(.orange)
    case .error: Text("Failed").font(.caption).foregroundStyle(.red)
    case .cancelled: Text("Stopped").font(.caption).foregroundStyle(.secondary)
    }
  }
}

/// "GM is working": while the session runs.
private struct WorkingLine: View {
  @Environment(AppModel.self) private var model
  var thread: CrewThread
  var session: Session

  var body: some View {
    if session.status == .running || session.status == .queued {
      HStack(spacing: 8) {
        RoleFace(role: session.role, size: 18)
          .phaseAnimator([1.0, 0.82]) { v, scale in v.scaleEffect(scale) } animation: { _ in .easeInOut(duration: 0.7) }
        Text(session.status == .queued ? "Queued" : thread.statusText.isEmpty ? "\(model.label(session.role)) is working" : thread.statusText)
          .font(.footnote)
          .foregroundStyle(.secondary)
          .lineLimit(1)
      }
      .transition(.opacity)
    }
  }
}

// MARK: - Cards

/// A tool call waiting for you. The same item as in the Inbox: deciding in either place settles both.
struct ApprovalCard: View {
  @Environment(AppModel.self) private var model
  var item: InboxItem
  @State private var action = Action()
  @State private var showDetails = false

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 6) {
        RoleFace(role: item.role, size: 18)
        Text("\(model.label(item.role)) needs your approval").font(.footnote.weight(.medium)).foregroundStyle(.secondary)
      }
      Text(item.title).font(.body.weight(.semibold))
      DisclosureGroup("What it wants to run", isExpanded: $showDetails) {
        MarkdownView(text: item.body, font: .footnote).padding(.top, 6)
      }
      .font(.subheadline)
      .tint(.secondary)
      HStack(spacing: 10) {
        Menu {
          if item.askEveryTime != true {
            Button("Always allow this tool", systemImage: "checkmark.seal") { action.run { try await model.decideApproval(item.id, approved: true, always: "tool") } }
            Button("Approve all in this thread", systemImage: "checkmark.circle") { action.run { try await model.decideApproval(item.id, approved: true, always: "all") } }
          }
          Button("Deny", systemImage: "xmark", role: .destructive) { action.run { try await model.decideApproval(item.id, approved: false) } }
        } label: {
          Text("Deny").frame(maxWidth: .infinity)
        } primaryAction: {
          action.run { try await model.decideApproval(item.id, approved: false) }
        }
        .buttonStyle(.glass)
        Button {
          action.run { try await model.decideApproval(item.id, approved: true) }
        } label: {
          Text("Approve").bold().frame(maxWidth: .infinity)
        }
        .buttonStyle(.glassProminent)
        .tint(.primary)
        .foregroundStyle(Color.crewBackground)
      }
      .controlSize(.large)
      .disabled(action.busy)
    }
    .padding(16)
    .background(Color.surface, in: .rect(cornerRadius: 22))
    .sensoryFeedback(.success, trigger: action.busy) { was, now in was && !now && action.error == nil }
    .errorAlert(action)
  }
}

/// An agent's question: the options to tap, or your own answer.
private struct QuestionCard: View {
  @Environment(AppModel.self) private var model
  var threadId: String
  var sessionId: String
  var role: String
  var question: String
  var inboxId: String
  var options: [QuestionOption]
  var recommended: Int?
  var multiSelect: Bool
  var answer: String?
  @State private var text = ""
  @State private var picked: [Int] = []
  @State private var action = Action()

  var body: some View {
    let open = model.inbox[inboxId] != nil
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 6) {
        RoleFace(role: role, size: 18)
        Text(open ? "\(model.label(role)) asks" : "\(model.label(role)) asked")
          .font(.footnote.weight(.medium))
          .foregroundStyle(.secondary)
      }
      MarkdownView(text: question)
      if !open, let answer {
        Label { MarkdownView(text: answer, font: .subheadline) } icon: { Image(systemName: "checkmark").foregroundStyle(.green) }
      }
      if open {
        if multiSelect && !options.isEmpty {
          Text("Pick one or more").font(.caption).foregroundStyle(.secondary)
        }
        ForEach(Array(options.enumerated()), id: \.offset) { i, o in
          Button {
            if multiSelect {
              if let at = picked.firstIndex(of: i) { picked.remove(at: at) } else { picked.append(i); picked.sort() }
            } else {
              send(o.label)
            }
          } label: {
            HStack(alignment: .top) {
              if multiSelect {
                Image(systemName: picked.contains(i) ? "checkmark.circle.fill" : "circle").foregroundStyle(.primary)
              }
              VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                  Text(o.label).font(.body.weight(.medium))
                  if recommended == i { Text("Recommended").font(.caption2.weight(.medium)).foregroundStyle(.secondary) }
                }
                if let detail = o.detail { Text(detail).font(.footnote).foregroundStyle(.secondary) }
              }
              Spacer(minLength: 0)
            }
            .multilineTextAlignment(.leading)
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.raised, in: .rect(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(recommended == i ? AnyShapeStyle(.primary) : AnyShapeStyle(.clear), lineWidth: 1.5))
          }
          .buttonStyle(.plain)
          .disabled(action.busy)
        }
        HStack(spacing: 8) {
          TextField(options.isEmpty ? "Your answer" : "Something else", text: $text, axis: .vertical)
            .lineLimit(1...5)
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .background(Color.raised, in: .rect(cornerRadius: 18))
          Button("Send", systemImage: "arrow.up") { send(composed) }
            .labelStyle(.iconOnly)
            .buttonStyle(.glassProminent)
            .buttonBorderShape(.circle)
            .tint(.primary)
            .foregroundStyle(Color.crewBackground)
            .disabled(composed.isEmpty || action.busy)
        }
        Button("Dismiss") { action.run { try await model.resolveInbox(inboxId) } }
          .font(.footnote)
          .foregroundStyle(.secondary)
      }
    }
    .padding(16)
    .background(Color.surface, in: .rect(cornerRadius: 22))
    .errorAlert(action)
  }

  /// Each picked option on its own line, then anything typed (as the Mac app's composeAnswer).
  private var composed: String {
    let typed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard multiSelect, !picked.isEmpty else { return typed }
    let labels = picked.map { options[$0].label }
    if labels.count == 1 && typed.isEmpty { return labels[0] }
    return (labels + (typed.isEmpty ? [] : [typed])).map { "- \($0)" }.joined(separator: "\n")
  }

  private func send(_ answer: String) {
    let a = answer.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !a.isEmpty else { return }
    action.run {
      try await model.sendMessage(threadId: threadId, SendMessageRequest(text: a, sessionId: sessionId, replyTo: inboxId))
      text = ""
      picked = []
    }
  }
}
