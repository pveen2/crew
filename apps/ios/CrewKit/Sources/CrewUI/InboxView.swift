import SwiftUI
import CrewKit

/// Things that need you: approvals, questions, tags, pull requests. Swipe to decide.
struct InboxView: View {
  @Environment(AppModel.self) private var model
  @State private var action = Action()

  var body: some View {
    let items = model.inboxItems
    List {
      ForEach(items) { item in
        NavigationLink(value: Route.thread(item.threadId)) {
          InboxRow(item: item)
        }
        .swipeActions(edge: .leading, allowsFullSwipe: true) {
          if item.kind == .approval {
            Button("Approve", systemImage: "checkmark") {
              action.run { try await model.decideApproval(item.id, approved: true) }
            }
            .tint(.green)
          }
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
          if item.kind == .approval {
            Button("Deny", systemImage: "xmark", role: .destructive) {
              action.run { try await model.decideApproval(item.id, approved: false) }
            }
          } else {
            Button("Dismiss", systemImage: "checkmark.circle") {
              action.run { try await model.resolveInbox(item.id) }
            }
            .tint(.gray)
          }
        }
        .contextMenu { InboxMenu(item: item, action: action) }
      }
    }
    .listStyle(.plain)
    .overlay {
      if items.isEmpty && model.phase == .online {
        ContentUnavailableView("Nothing needs you", systemImage: "checkmark.circle", description: Text("Approvals and questions from your team show up here."))
      } else if model.phase == .connecting && model.threads.isEmpty {
        ProgressView()
      }
    }
    .navigationTitle("Inbox")
    .refreshable { try? await model.refreshState() }
    .sensoryFeedback(.success, trigger: model.inbox.count) { old, new in new < old }
    .errorAlert(action)
  }
}

struct InboxMenu: View {
  @Environment(AppModel.self) private var model
  @Environment(\.openURL) private var openURL
  var item: InboxItem
  var action: Action

  var body: some View {
    switch item.kind {
    case .approval:
      Button("Approve", systemImage: "checkmark") { action.run { try await model.decideApproval(item.id, approved: true) } }
      if item.askEveryTime != true {
        Button("Always allow this tool", systemImage: "checkmark.seal") { action.run { try await model.decideApproval(item.id, approved: true, always: "tool") } }
        Button("Approve all in this thread", systemImage: "checkmark.circle.badge.questionmark") { action.run { try await model.decideApproval(item.id, approved: true, always: "all") } }
      }
      Button("Deny", systemImage: "xmark", role: .destructive) { action.run { try await model.decideApproval(item.id, approved: false) } }
    case .pullRequest:
      if let url = item.url.flatMap(URL.init(string:)) {
        Button("Open on GitHub", systemImage: "safari") { openURL(url) }
      }
      Button("Merge", systemImage: "arrow.triangle.merge") { action.run { try await model.mergePullRequest(item.id) } }
      Button("Dismiss", systemImage: "checkmark.circle") { action.run { try await model.resolveInbox(item.id) } }
    default:
      Button("Dismiss", systemImage: "checkmark.circle") { action.run { try await model.resolveInbox(item.id) } }
    }
  }
}

struct InboxRow: View {
  @Environment(AppModel.self) private var model
  var item: InboxItem

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      if item.kind == .mention, let by = item.by {
        PersonFace(email: by, size: 36)
      } else {
        RoleFace(role: item.role, size: 36)
      }
      VStack(alignment: .leading, spacing: 3) {
        HStack(alignment: .firstTextBaseline) {
          Text(kindLabel).font(.subheadline.weight(.medium)).foregroundStyle(kindColor)
          Spacer()
          Text(Ago.short(item.createdAt)).font(.footnote).foregroundStyle(.secondary)
        }
        Text(item.title).font(.body.weight(.medium)).lineLimit(2)
        if !item.body.isEmpty {
          Text(inline(preview(item.body)))
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .lineLimit(2)
        }
        if let threadTitle = (model.threads[item.threadId] ?? model.done[item.threadId])?.title {
          Text(threadTitle).font(.caption).foregroundStyle(.tertiary).lineLimit(1)
        }
      }
    }
    .padding(.vertical, 4)
  }

  /// The first lines of the body as plain text: no code fences or heading marks.
  private func preview(_ body: String) -> String {
    body.split(whereSeparator: \.isNewline)
      .map { $0.trimmingCharacters(in: .whitespaces) }
      .filter { !$0.hasPrefix("```") && !$0.isEmpty }
      .map { $0.replacingOccurrences(of: #"^#+\s*"#, with: "", options: .regularExpression) }
      .prefix(3)
      .joined(separator: " ")
  }

  private var kindLabel: String {
    let who = item.kind == .mention ? (item.by.map(model.personName) ?? "Someone") : model.label(item.role)
    switch item.kind {
    case .approval: return "\(who) needs your approval"
    case .needsYou: return "\(who) asks"
    case .mention: return "\(who) tagged you"
    case .pullRequest: return "Pull request"
    case .draft: return "\(who) made a draft"
    case .error: return "\(who) ran into an error"
    case .interrupted: return "\(who) was interrupted"
    case .unknown: return who
    }
  }

  private var kindColor: Color {
    switch item.kind {
    case .error: .red
    default: .secondary
    }
  }
}
