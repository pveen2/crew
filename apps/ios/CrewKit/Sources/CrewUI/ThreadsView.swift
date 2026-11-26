import SwiftUI
import PhotosUI
import CrewKit

/// Every question is its own thread. Swipe to close one.
struct ThreadsView: View {
  @Environment(AppModel.self) private var model
  @Binding var path: [Route]
  @Binding var composing: Bool
  @State private var showClosed = false
  @State private var mineOnly = UserDefaults.standard.bool(forKey: "crew.mineOnly")
  @State private var action = Action()

  private var open: [CrewThread] {
    model.sortedThreads.filter { !mineOnly || model.me == nil || $0.createdBy == model.me || ($0.people ?? []).contains(model.me!) }
  }

  var body: some View {
    List {
      Section {
        ForEach(open) { t in
          NavigationLink(value: Route.thread(t.id)) { ThreadRow(thread: t) }
            .swipeActions(edge: .trailing) {
              Button("Close", systemImage: "checkmark.circle") {
                action.run { try await model.archiveThread(t.id) }
              }
              .tint(.green)
            }
        }
      }
      if !model.done.isEmpty {
        Section(isExpanded: $showClosed) {
          ForEach(model.sortedDone.prefix(50)) { t in
            NavigationLink(value: Route.thread(t.id)) { ThreadRow(thread: t) }
          }
        } header: {
          Text("Closed")
        }
      }
    }
    .listStyle(.sidebar)
    .overlay {
      if open.isEmpty && model.phase == .online {
        ContentUnavailableView {
          Label("No open threads", systemImage: "bubble.left.and.bubble.right")
        } description: {
          Text("Ask your team something. Every question gets its own thread.")
        } actions: {
          Button("New thread") { composing = true }.buttonStyle(.glassProminent).tint(.primary).foregroundStyle(Color.crewBackground)
        }
      } else if model.phase == .connecting && model.threads.isEmpty {
        ProgressView()
      }
    }
    .navigationTitle(model.teamName)
    .toolbar {
      if model.isTeamServer {
        ToolbarItem(placement: .topBarLeadingCompat) {
          Menu {
            Picker("Show", selection: $mineOnly) {
              Text("All threads").tag(false)
              Text("Mine").tag(true)
            }
          } label: {
            Label("Filter", systemImage: mineOnly ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle")
          }
        }
      }
      ToolbarItem(placement: .primaryAction) {
        Button("New thread", systemImage: "square.and.pencil") { composing = true }
      }
    }
    .onChange(of: mineOnly) { _, v in UserDefaults.standard.set(v, forKey: "crew.mineOnly") }
    .refreshable { try? await model.refreshState() }
    .sheet(isPresented: $composing) {
      NewThreadSheet { thread in path.append(.thread(thread.id)) }
    }
    .errorAlert(action)
  }
}

extension ToolbarItemPlacement {
  static var topBarLeadingCompat: ToolbarItemPlacement {
    #if os(iOS)
    .topBarLeading
    #else
    .navigation
    #endif
  }
}

struct ThreadRow: View {
  @Environment(AppModel.self) private var model
  var thread: CrewThread

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      RoleFace(role: thread.roles.first ?? model.lead?.name ?? "gm", size: 36)
        .overlay(alignment: .topTrailing) {
          StatusDot(status: thread.status)
            .overlay(Circle().stroke(Color.crewBackground, lineWidth: 2).opacity(thread.status == .idle ? 0 : 1))
            .offset(x: 2, y: -2)
        }
      VStack(alignment: .leading, spacing: 3) {
        HStack(alignment: .firstTextBaseline) {
          Text(thread.title).font(.body.weight(thread.status == .needsYou ? .semibold : .medium)).lineLimit(1)
          Spacer(minLength: 8)
          Text(Ago.short(thread.updatedAt)).font(.footnote).foregroundStyle(.secondary)
        }
        HStack(spacing: 6) {
          Text(subtitle)
            .font(.subheadline)
            .foregroundStyle(thread.status == .needsYou ? Color.primary : .secondary)
            .lineLimit(2)
          Spacer(minLength: 0)
          if thread.roles.count > 1 { RoleFaces(roles: Array(thread.roles.dropFirst()), size: 16) }
        }
      }
    }
    .padding(.vertical, 2)
  }

  private var subtitle: String {
    if !thread.statusText.isEmpty { return thread.statusText }
    if let by = thread.createdBy, by != model.me, model.me != nil { return "Started by \(model.personName(by))" }
    return thread.roles.map(model.label).joined(separator: ", ")
  }
}

// MARK: - New thread

struct NewThreadSheet: View {
  @Environment(AppModel.self) private var model
  @Environment(\.dismiss) private var dismiss
  var opened: (CrewThread) -> Void
  @State private var text = ""
  @State private var role: String?
  @State private var images = PickedImages()
  @State private var busy = false
  @State private var error: String?
  @FocusState private var focused: Bool

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          TextField("What should the team work on?", text: $text, axis: .vertical)
            .font(.title3)
            .lineLimit(4...)
            .focused($focused)
          PickedImagesTray(images: images)
          if text.isEmpty && !model.suggestions.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
              Text("Try").font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
              ForEach(model.suggestions.prefix(4), id: \.self) { s in
                Button { text = s } label: {
                  Text(s).font(.subheadline).multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
                    .background(.quaternary.opacity(0.5), in: .rect(cornerRadius: 14))
                }
                .buttonStyle(.plain)
              }
            }
          }
          if let error {
            Label(error, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.red).font(.footnote)
          }
        }
        .padding(20)
      }
      .navigationTitle("New thread")
      .inlineTitle()
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel", systemImage: "xmark") { dismiss() }
        }
        ToolbarItem(placement: .principal) {
          Menu {
            Picker("Agent", selection: $role) {
              ForEach(model.roles) { r in
                Label(r.label, systemImage: r.isLead ? "star" : "person").tag(r.isLead ? String?.none : String?.some(r.name))
              }
            }
          } label: {
            HStack(spacing: 6) {
              RoleFace(role: role ?? model.lead?.name ?? "gm", size: 20)
              Text(role.map(model.label) ?? model.lead?.label ?? "Lead").font(.headline)
              Image(systemName: "chevron.down").font(.caption.bold()).foregroundStyle(.secondary)
            }
          }
          .buttonStyle(.plain)
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Send", systemImage: "arrow.up") { send() }
            .buttonStyle(.glassProminent)
            .tint(.primary)
            .foregroundStyle(Color.crewBackground)
            .disabled((text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && images.items.isEmpty) || busy)
        }
        ToolbarItem(placement: .bottomBarCompat) {
          PhotosPicker(selection: $images.selection, maxSelectionCount: 6, matching: .images) {
            Label("Add images", systemImage: "photo.on.rectangle.angled")
          }
        }
      }
      .onAppear { focused = true }
    }
    .presentationDetents([.large])
  }

  private func send() {
    busy = true
    error = nil
    Task {
      defer { busy = false }
      do {
        let t = try await model.createThread(text: text.trimmingCharacters(in: .whitespacesAndNewlines), role: role, attachments: images.uploads)
        dismiss()
        opened(t)
      } catch {
        self.error = error.localizedDescription
      }
    }
  }
}

extension ToolbarItemPlacement {
  static var bottomBarCompat: ToolbarItemPlacement {
    #if os(iOS)
    .bottomBar
    #else
    .automatic
    #endif
  }
}

// MARK: - Picked images

/// Photos picked to send along, as uploads.
@MainActor @Observable
final class PickedImages {
  struct Item: Identifiable {
    let id = UUID()
    let image: PlatformImage
    let upload: AttachmentUpload
  }

  var items: [Item] = []
  var selection: [PhotosPickerItem] = [] {
    didSet { load(selection) }
  }

  var uploads: [AttachmentUpload] { items.map(\.upload) }

  func clear() {
    items = []
    selection = []
  }

  func remove(_ id: UUID) { items.removeAll { $0.id == id } }

  private func load(_ picked: [PhotosPickerItem]) {
    guard !picked.isEmpty else { return }
    Task {
      for p in picked {
        guard let data = try? await p.loadTransferable(type: Data.self),
              let jpeg = ImageData.jpeg(data), let image = PlatformImage(data: jpeg) else { continue }
        items.append(Item(image: image, upload: AttachmentUpload(name: "photo-\(items.count + 1).jpg", mime: "image/jpeg", data: jpeg)))
      }
      if !selection.isEmpty { selection = [] }
    }
  }
}

struct PickedImagesTray: View {
  var images: PickedImages

  var body: some View {
    if !images.items.isEmpty {
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 8) {
          ForEach(images.items) { item in
            Image(platformImage: item.image)
              .resizable()
              .scaledToFill()
              .frame(width: 64, height: 64)
              .clipShape(.rect(cornerRadius: 12))
              .overlay(alignment: .topTrailing) {
                Button("Remove", systemImage: "xmark.circle.fill") { images.remove(item.id) }
                  .labelStyle(.iconOnly)
                  .foregroundStyle(.white, .black.opacity(0.6))
                  .padding(3)
              }
          }
        }
      }
    }
  }
}
