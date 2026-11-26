import SwiftUI
import PhotosUI
import CrewKit

/// Direct messages (team server): plain chats between people, no agent in them.
struct MessagesView: View {
  @Environment(AppModel.self) private var model
  @Binding var path: [Route]
  @State private var picking = false

  var body: some View {
    let dms = model.sortedDms
    List(dms) { dm in
      NavigationLink(value: Route.dm(dm.id)) { DmRow(dm: dm) }
    }
    .listStyle(.plain)
    .overlay {
      if dms.isEmpty {
        ContentUnavailableView {
          Label("No messages yet", systemImage: "person.2")
        } description: {
          Text("Chat with your colleagues here. Agents don't read these.")
        } actions: {
          Button("New message") { picking = true }.buttonStyle(.glassProminent).tint(.primary).foregroundStyle(Color.crewBackground)
        }
      }
    }
    .navigationTitle("Messages")
    .toolbar {
      ToolbarItem(placement: .primaryAction) {
        Button("New message", systemImage: "square.and.pencil") { picking = true }
      }
    }
    .sheet(isPresented: $picking) {
      NewDmSheet { dm in path.append(.dm(dm.id)) }
    }
  }
}

private struct DmRow: View {
  @Environment(AppModel.self) private var model
  var dm: Dm

  var body: some View {
    let others = dm.people.filter { $0 != model.me }
    let unread = model.dmUnread(dm)
    HStack(spacing: 12) {
      PersonFace(email: others.first ?? model.me ?? "", size: 40, showOnline: true)
      VStack(alignment: .leading, spacing: 3) {
        HStack(alignment: .firstTextBaseline) {
          Text(model.dmName(dm)).font(.body.weight(unread ? .semibold : .medium)).lineLimit(1)
          Spacer()
          Text(Ago.short(dm.updatedAt)).font(.footnote).foregroundStyle(.secondary)
        }
        if let last = dm.last {
          Text((last.by == model.me ? "You: " : "") + last.text)
            .font(.subheadline)
            .foregroundStyle(unread ? .primary : .secondary)
            .lineLimit(2)
        }
      }
      if unread { Circle().fill(.blue).frame(width: 9, height: 9) }
    }
    .padding(.vertical, 2)
  }
}

/// Pick the people to message; the chat opens with them (it is made on the first message).
private struct NewDmSheet: View {
  @Environment(AppModel.self) private var model
  @Environment(\.dismiss) private var dismiss
  var opened: (Dm) -> Void
  @State private var picked: Set<String> = []
  @State private var text = ""
  /// Made once for this message: sending it again after a lost answer does not post it twice.
  @State private var clientId = UUID().uuidString
  @State private var action = Action()

  var body: some View {
    NavigationStack {
      List {
        Section("To") {
          ForEach(model.people.filter { $0.email != model.me }) { p in
            Button {
              if picked.contains(p.email) { picked.remove(p.email) } else { picked.insert(p.email) }
            } label: {
              HStack {
                PersonFace(email: p.email, size: 32, showOnline: true)
                VStack(alignment: .leading) {
                  Text(p.name).foregroundStyle(.primary)
                  Text(p.email).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                if picked.contains(p.email) { Image(systemName: "checkmark").foregroundStyle(.primary).bold() }
              }
            }
          }
        }
      }
      .safeAreaBar(edge: .bottom) {
        HStack(spacing: 8) {
          TextField("Message", text: $text, axis: .vertical)
            .lineLimit(1...5)
            .padding(.horizontal, 16)
            .padding(.vertical, 11)
            .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 22))
          Button("Send", systemImage: "arrow.up") {
            let others = Array(picked)
            if let existing = model.sortedDms.first(where: { Set($0.people.filter { $0 != model.me }) == picked }) {
              action.run {
                try await model.sendDm(existing.id, text: text, attachments: [], clientId: clientId)
                dismiss()
                opened(existing)
              }
            } else {
              action.run {
                let dm = try await model.sendDm(to: others, text: text, clientId: clientId)
                dismiss()
                opened(dm)
              }
            }
          }
          .labelStyle(.iconOnly)
          .buttonStyle(.glassProminent)
          .tint(.primary)
          .foregroundStyle(Color.crewBackground)
          .buttonBorderShape(.circle)
          .controlSize(.large)
          .disabled(picked.isEmpty || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || action.busy)
        }
        .padding(12)
      }
      .navigationTitle("New message")
      .inlineTitle()
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel", systemImage: "xmark") { dismiss() } }
      }
    }
    .errorAlert(action)
  }
}

/// One DM: messages, newest at the bottom, and the composer.
struct DmView: View {
  @Environment(AppModel.self) private var model
  var dmId: String
  @State private var text = ""
  @State private var images = PickedImages()
  /// Made once per message: sending it again after a lost answer does not post it twice.
  @State private var clientId = UUID().uuidString
  @State private var action = Action()

  private var canSend: Bool {
    (!text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !images.items.isEmpty) && !action.busy
  }

  var body: some View {
    let messages = model.dmMessages[dmId] ?? []
    ScrollView {
      LazyVStack(spacing: 4) {
        ForEach(Array(messages.enumerated()), id: \.element.id) { i, m in
          DmBubble(message: m, showName: i == 0 || messages[i - 1].by != m.by || m.ts - messages[i - 1].ts > 5 * 60_000)
        }
      }
      .padding(.horizontal, 16)
      .padding(.top, 12)
      .padding(.bottom, 24)
    }
    .defaultScrollAnchor(.bottom)
    .defaultScrollAnchor(.bottom, for: .sizeChanges)
    .dismissesKeyboardOnScroll()
    .overlay { if model.dmMessages[dmId] == nil { ProgressView() } }
    .safeAreaBar(edge: .bottom) {
      VStack(spacing: 8) {
        PickedImagesTray(images: images)
        GlassEffectContainer(spacing: 8) {
          HStack(alignment: .bottom, spacing: 8) {
            PhotosPicker(selection: $images.selection, maxSelectionCount: 6, matching: .images) {
              Image(systemName: "plus").font(.title3.weight(.medium)).frame(width: 44, height: 44)
            }
            .buttonStyle(.plain)
            .glassEffect(.regular.interactive(), in: .circle)
            TextField("Message", text: $text, axis: .vertical)
              .lineLimit(1...6)
              .padding(.horizontal, 16)
              .padding(.vertical, 11)
              .frame(minHeight: 44)
              .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 22))
              .onChange(of: text) { _, t in if !t.isEmpty { model.typing() } }
            Button {
              let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
              let uploads = images.uploads
              dismissKeyboard()
              let id = clientId
              action.run {
                try await model.sendDm(dmId, text: body, attachments: uploads, clientId: id)
                text = ""
                images.clear()
                clientId = UUID().uuidString
              }
            } label: {
              Image(systemName: "arrow.up").font(.body.weight(.bold)).frame(width: 44, height: 44)
            }
            .buttonStyle(.plain)
            .foregroundStyle(canSend ? Color.crewBackground : .secondary)
            .glassEffect(canSend ? .regular.tint(.primary).interactive() : .regular, in: .circle)
            .disabled(!canSend)
          }
        }
      }
      .padding(.horizontal, 12)
      .padding(.top, 6)
      .padding(.bottom, 10)
    }
    .navigationTitle(model.dms[dmId].map(model.dmName) ?? "Message")
    .inlineTitle()
    .task(id: dmId) {
      if model.dmMessages[dmId] == nil { await model.loadDm(dmId) }
      model.markDmSeen(dmId)
    }
    .onAppear { model.setOpen(dmId) }
    .onDisappear { model.setOpen(nil) }
    .onChange(of: model.dms[dmId]?.updatedAt) { model.markDmSeen(dmId) }
    .errorAlert(action)
  }
}

private struct DmBubble: View {
  @Environment(AppModel.self) private var model
  var message: DmMessage
  var showName: Bool

  var body: some View {
    let mine = message.by == model.me
    VStack(alignment: mine ? .trailing : .leading, spacing: 4) {
      if showName {
        Text(mine ? Ago.clock(message.ts) : "\(model.personName(message.by)) · \(Ago.clock(message.ts))")
          .font(.caption)
          .foregroundStyle(.secondary)
          .padding(.top, 8)
      }
      if let attachments = message.attachments, !attachments.isEmpty {
        HStack { ForEach(attachments, id: \.file) { AttachmentImage(threadId: message.dmId, attachment: $0) } }
      }
      if !message.text.isEmpty {
        Text(inline(message.text))
          .padding(.horizontal, mine ? 16 : 0)
          .padding(.vertical, mine ? 10 : 2)
          .background(mine ? Color.surface : .clear, in: .rect(cornerRadius: 22))
          .textSelection(.enabled)
      }
    }
    .frame(maxWidth: .infinity, alignment: mine ? .trailing : .leading)
    .padding(mine ? .leading : .trailing, 48)
  }
}
