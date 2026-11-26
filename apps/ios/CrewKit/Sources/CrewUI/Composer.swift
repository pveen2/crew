import SwiftUI
import PhotosUI
import CrewKit

/// Everything under a thread's conversation: who is typing, messages waiting for
/// the agent, approvals from other agents, @ suggestions, and the composer itself.
struct ComposerDock: View {
  @Environment(AppModel.self) private var model
  var threadId: String
  var data: ThreadData
  var session: Session
  var rootId: String
  @Binding var sessionId: String?
  @State private var text = ""
  @State private var images = PickedImages()
  @State private var error: String?
  @State private var busy = false
  @State private var action = Action()
  @FocusState private var focused: Bool

  private var working: Bool { session.status == .running || session.status == .queued }
  private var root: Session? { data.sessions[rootId] }
  private var leadOwns: Bool { root.map { r in model.roles.contains { $0.isLead && $0.name == r.role } } ?? false }
  private var options: [Mentions.SessionOption] { Mentions.sessionOptions(sessions: Array(data.sessions.values), labels: model.labels) }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      TypingLine(threadId: threadId)
      ForEach(otherApprovals) { ApprovalCard(item: $0) }
      ForEach(ThreadLogic.waitingMessages(events: data.events, session: session), id: \.event.id) { w in
        WaitingChip(event: w.event, info: w.info, label: model.label(session.role))
      }
      if session.status == .interrupted || session.status == .error {
        HStack {
          Label(session.status == .error ? "\(model.label(session.role)) stopped with an error" : "\(model.label(session.role)) was interrupted",
                systemImage: "exclamationmark.triangle")
            .font(.footnote)
            .foregroundStyle(.secondary)
          Spacer()
          Button("Resume") { action.run { try await model.resumeSession(session.id) } }
            .buttonStyle(.glass)
            .controlSize(.small)
        }
      }
      if let error {
        Label(error, systemImage: "exclamationmark.circle").font(.footnote).foregroundStyle(.red)
      }
      MentionSuggestions(text: $text, suggestions: suggestions)
      PickedImagesTray(images: images)
      bar
    }
    .padding(.horizontal, 12)
    .padding(.top, 6)
    .padding(.bottom, 10)
    .animation(.snappy, value: text.isEmpty)
    .errorAlert(action)
  }

  private var bar: some View {
    GlassEffectContainer(spacing: 8) {
      HStack(alignment: .bottom, spacing: 8) {
        PhotosPicker(selection: $images.selection, maxSelectionCount: 6, matching: .images) {
          Image(systemName: "plus")
            .font(.title3.weight(.medium))
            .frame(width: 44, height: 44)
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.interactive(), in: .circle)
        .accessibilityLabel("Add images")

        TextField(placeholder, text: $text, axis: .vertical)
          .lineLimit(1...6)
          .focused($focused)
          .padding(.horizontal, 16)
          .padding(.vertical, 11)
          .frame(minHeight: 44)
          .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 22))
          .onChange(of: text) { _, t in if !t.isEmpty { model.typing() } }

        if working && text.isEmpty && images.items.isEmpty {
          Button {
            action.run { try await model.stopSession(session.id) }
          } label: {
            Image(systemName: "stop.fill").font(.body.weight(.semibold)).frame(width: 44, height: 44)
          }
          .buttonStyle(.plain)
          .glassEffect(.regular.tint(.primary.opacity(0.15)).interactive(), in: .circle)
          .accessibilityLabel("Stop \(model.label(session.role))")
        } else {
          Button(action: submit) {
            Image(systemName: "arrow.up").font(.body.weight(.bold)).frame(width: 44, height: 44)
          }
          .buttonStyle(.plain)
          .foregroundStyle(canSend ? Color.crewBackground : .secondary)
          .glassEffect(canSend ? .regular.tint(.primary).interactive() : .regular, in: .circle)
          .disabled(!canSend)
          .accessibilityLabel("Send")
        }
      }
    }
    .disabled(model.phase != .online)
    .sensoryFeedback(.impact(weight: .light), trigger: busy) { was, now in !was && now }
  }

  private var canSend: Bool { (!text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !images.items.isEmpty) && !busy }

  private var placeholder: String {
    let label = model.label(session.role)
    if session.depth > 0 { return "Message \(label) directly" }
    return model.isTeamServer && model.people.count > 1 ? "Reply, or @ someone" : "Reply, or @ an agent"
  }

  /// Approvals other agents in this thread wait on (a specialist the GM asked), so you see them without stepping in.
  private var otherApprovals: [InboxItem] {
    model.inboxItems.filter { $0.threadId == threadId && $0.kind == .approval && $0.sessionId != session.id }
  }

  private var suggestions: [MentionSuggestion] {
    var out: [MentionSuggestion] = []
    if leadOwns {
      let benched = data.thread.benched
      for r in model.roles.filter({ $0.isLead || !benched.contains($0.name) }).sorted(by: { $0.isLead && !$1.isLead }) {
        out.append(MentionSuggestion(value: r.name, label: r.label, role: r.name, email: nil))
      }
    } else {
      for o in options {
        out.append(MentionSuggestion(value: o.label.lowercased().replacingOccurrences(of: " ", with: "-"), label: o.label, role: o.role, email: nil))
      }
    }
    if let me = model.me {
      for p in model.people where p.email != me {
        out.append(MentionSuggestion(value: p.name, label: p.name, role: nil, email: p.email))
      }
    }
    return out
  }

  /// Ported from ThreadComposer.submit in the Mac app: who a message goes to, and who it tags.
  private func submit() {
    var body = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard canSend else { return }
    var target = session
    let me = model.me
    let tagged = me != nil ? Mentions.mentionedPeople(body, people: model.people, me: me) : []
    let toPerson = me != nil && Mentions.leadingPerson(body, people: model.people, me: me) != nil
    let leadNames = model.roles.filter(\.isLead).flatMap { [$0.name, $0.label] }
    var toAgent = Mentions.mentionsSpecialist(body, roles: model.roles) || Mentions.mentionsAny(body, names: leadNames + options.map(\.label))
    if body.hasPrefix("@"), !toPerson, leadOwns, let root {
      switch Mentions.mentionedRole(body, roles: model.roles) {
      case .error(let m): error = m; return
      case .to(let role, let rest):
        target = root
        toAgent = true
        if model.roles.first(where: { $0.name == role })?.isLead == true { body = rest }
      }
    } else if leadOwns, session.id != rootId, Mentions.mentionsSpecialist(body, roles: model.roles), let root {
      target = root
    } else if body.hasPrefix("@"), !toPerson {
      switch Mentions.resolveMention(body, options: options, currentSessionId: session.id) {
      case .error(let m): error = m; return
      case .to(let id, let rest):
        guard let s = data.sessions[id] else { return }
        target = s
        body = rest
        toAgent = true
      }
    }
    let request = SendMessageRequest(
      text: body,
      attachments: images.uploads.isEmpty ? nil : images.uploads,
      sessionId: target.depth == 0 ? nil : target.id,
      mentions: tagged.isEmpty ? nil : tagged,
      toAgent: toAgent ? true : nil)
    busy = true
    error = nil
    focused = false
    dismissKeyboard()
    Task {
      defer { busy = false }
      do {
        try await model.sendMessage(threadId: threadId, request)
        text = ""
        images.clear()
        if target.id != session.id { sessionId = target.id == rootId ? nil : target.id }
      } catch {
        self.error = error.localizedDescription
      }
    }
  }
}

struct MentionSuggestion: Identifiable, Hashable {
  var value: String
  var label: String
  var role: String?
  var email: String?
  var id: String { (role ?? email ?? "") + value }
}

/// While you type "@…", the agents and people that fit, to tap.
private struct MentionSuggestions: View {
  @Binding var text: String
  var suggestions: [MentionSuggestion]

  var body: some View {
    let query = currentMention
    let matches = query.map { q in suggestions.filter { q.isEmpty || $0.label.lowercased().hasPrefix(q) || $0.value.lowercased().hasPrefix(q) } } ?? []
    if !matches.isEmpty {
      ScrollView(.horizontal, showsIndicators: false) {
        GlassEffectContainer(spacing: 6) {
          HStack(spacing: 6) {
            ForEach(matches.prefix(8)) { s in
              Button {
                insert(s.value)
              } label: {
                HStack(spacing: 6) {
                  if let role = s.role { RoleFace(role: role, size: 20) }
                  if let email = s.email { PersonFace(email: email, size: 20) }
                  Text(s.label).font(.subheadline.weight(.medium))
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 7)
              }
              .buttonStyle(.plain)
              .glassEffect(.regular.interactive(), in: .capsule)
            }
          }
          .padding(.vertical, 2)
        }
      }
      .transition(.move(edge: .bottom).combined(with: .opacity))
    }
  }

  /// The "@partial" being typed at the end, without the @; nil when there is none.
  private var currentMention: String? {
    guard let at = text.lastIndex(of: "@") else { return nil }
    if at != text.startIndex, let before = text[..<at].last, !before.isWhitespace { return nil }
    let after = text[text.index(after: at)...]
    guard !after.contains(where: \.isNewline), after.count <= 30, !after.hasSuffix(" ") else { return nil }
    return after.lowercased()
  }

  private func insert(_ value: String) {
    guard let at = text.lastIndex(of: "@") else { return }
    text = String(text[..<at]) + "@\(value) "
  }
}

/// "Juliette is typing…"
private struct TypingLine: View {
  @Environment(AppModel.self) private var model
  var threadId: String

  var body: some View {
    let typing = (model.presence[threadId]?.typing ?? []).filter { $0 != model.me }
    if !typing.isEmpty {
      HStack(spacing: 6) {
        ForEach(typing, id: \.self) { PersonFace(email: $0, size: 16) }
        Text(typing.count == 1 ? "\(model.personName(typing[0])) is typing…" : "\(typing.count) people are typing…")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      .padding(.horizontal, 6)
    }
  }
}

/// A message the agent does not have yet. Queued ones can still be changed or taken back.
private struct WaitingChip: View {
  @Environment(AppModel.self) private var model
  var event: CrewEvent
  var info: DeliveryInfo
  var label: String
  @State private var editing = false
  @State private var draft = ""
  @State private var action = Action()

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: "clock").foregroundStyle(.secondary)
      VStack(alignment: .leading, spacing: 2) {
        Text(info.text).font(.subheadline).lineLimit(2)
        Text(status).font(.caption).foregroundStyle(.secondary)
      }
      Spacer(minLength: 0)
      if info.state == .queued {
        Menu("Change", systemImage: "ellipsis.circle") {
          Button("Edit", systemImage: "pencil") {
            draft = info.text
            editing = true
          }
          Button("Remove", systemImage: "trash", role: .destructive) { action.run { try await model.removeQueuedMessage(event.id) } }
        }
        .labelStyle(.iconOnly)
      }
    }
    .padding(12)
    .glassEffect(.regular, in: .rect(cornerRadius: 18))
    .alert("Edit message", isPresented: $editing) {
      TextField("Message", text: $draft)
      Button("Cancel", role: .cancel) {}
      Button("Save") {
        let t = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        if !t.isEmpty { action.run { try await model.editQueuedMessage(event.id, text: t) } }
      }
    }
    .errorAlert(action)
  }

  private var status: String {
    switch info.state {
    case .steering: "Sending · \(label) reads this at the next step"
    case .queued: "Queued · \(label) gets this when the current turn ends"
    default: "Waiting · \(label) gets this on Resume"
    }
  }
}
