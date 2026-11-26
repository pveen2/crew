import SwiftUI
#if canImport(UIKit)
import UIKit
#endif
import CrewKit

/// The whole app: sign-in until there is a server, then the tabs.
public struct CrewRoot: View {
  @State private var model = AppModel()
  @Environment(\.scenePhase) private var scenePhase

  public init() {}

  public var body: some View {
    Group {
      if model.phase == .signedOut {
        SignInView()
      } else if !model.loaded {
        // Until the first snapshot: the tabs depend on it (Messages is for team servers only).
        VStack(spacing: 16) {
          ProgressView().controlSize(.large)
          Text(model.phase == .offline ? "Can't reach \(model.endpoint?.url.host() ?? "the server"). Trying again…" : "Connecting…")
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
          if model.phase == .offline {
            Button("Sign out") { model.signOut() }.buttonStyle(.glass)
          }
        }
        .padding(32)
      } else {
        MainTabs()
      }
    }
    .environment(model)
    .animation(.default, value: model.phase == .signedOut)
    .onChange(of: scenePhase, initial: true) { _, phase in
      // iOS cuts the socket in the background: let go, and catch up when back.
      if phase == .active { model.start() } else if phase == .background { model.stop() }
    }
  }
}

enum Tab: Hashable {
  case inbox, threads, messages, team
}

struct MainTabs: View {
  @Environment(AppModel.self) private var model
  @State private var tab: Tab = .threads
  @State private var inboxPath: [Route] = []
  @State private var threadsPath: [Route] = []
  @State private var messagesPath: [Route] = []
  @State private var composing = false

  var body: some View {
    TabView(selection: $tab) {
      SwiftUI.Tab(value: Tab.inbox) {
        NavigationStack(path: $inboxPath) {
          InboxView().withRoutes()
        }
      } label: {
        tabLabel("Inbox", "tray", .inbox)
      }
      .badge(model.inboxItems.count)

      SwiftUI.Tab(value: Tab.threads) {
        NavigationStack(path: $threadsPath) {
          ThreadsView(path: $threadsPath, composing: $composing).withRoutes()
        }
      } label: {
        tabLabel("Threads", "bubble.left.and.text.bubble.right", .threads)
      }

      if model.isTeamServer {
        SwiftUI.Tab(value: Tab.messages) {
          NavigationStack(path: $messagesPath) {
            MessagesView(path: $messagesPath).withRoutes()
          }
        } label: {
          tabLabel("Messages", "person.2", .messages)
        }
        .badge(model.dms.values.filter(model.dmUnread).count)
      }

      SwiftUI.Tab(value: Tab.team) {
        NavigationStack {
          TeamView().withRoutes()
        }
      } label: {
        tabLabel("Team", "person.3", .team)
      }
    }
    // As in Slack and ChatGPT: black and white chrome, the selected tab filled.
    // Colour comes from the agent faces and small status dots only.
    .tint(.primary)
    .minimizingTabBar()
    .overlay(alignment: .top) { OfflineBanner().animation(.default, value: model.phase) }
    .onOpenURL(perform: open)
    #if DEBUG
    // Development: CREW_OPEN=crew://thread/<id> opens a screen at launch (screenshots, UI checks).
    .task {
      if let link = ProcessInfo.processInfo.environment["CREW_OPEN"].flatMap(URL.init(string:)) { open(link) }
    }
    #endif
  }

  /// Outlined, filled when selected, as in Slack. Drawn into a plain image first:
  /// the tab bar fills any symbol it is given, even outlined ones.
  private func tabLabel(_ title: String, _ symbol: String, _ value: Tab) -> some View {
    let name = tab == value ? symbol + ".fill" : symbol
    return Label {
      Text(title)
    } icon: {
      #if canImport(UIKit)
      if let image = flatSymbol(name) { Image(uiImage: image) } else { Image(systemName: name) }
      #else
      Image(systemName: name)
      #endif
    }
  }

  /// crew://inbox, crew://new, crew://threads, crew://thread/<id>, crew://messages, crew://dm/<id>,
  /// crew://team: for links, and later for notifications.
  private func open(_ url: URL) {
    guard url.scheme == "crew" else { return }
    let id = url.pathComponents.dropFirst().first
    switch url.host() {
    case "inbox": tab = .inbox; inboxPath = []
    case "threads": tab = .threads; threadsPath = []
    case "new": tab = .threads; threadsPath = []; composing = true
    case "thread": if let id { tab = .threads; threadsPath = [.thread(id)] }
    case "messages": tab = .messages; messagesPath = []
    case "dm": if let id { tab = .messages; messagesPath = [.dm(id)] }
    case "team": tab = .team
    default: break
    }
  }
}

extension View {
  func withRoutes() -> some View {
    navigationDestination(for: Route.self) { route in
      switch route {
      case .thread(let id, let session): ThreadView(threadId: id, sessionId: session)
      case .dm(let id): DmView(dmId: id)
      }
    }
  }
}

#if canImport(UIKit)
/// A symbol drawn into a plain template image, so nothing can change its variant.
@MainActor private func flatSymbol(_ name: String) -> UIImage? {
  let config = UIImage.SymbolConfiguration(pointSize: 19, weight: .medium)
  guard let symbol = UIImage(systemName: name, withConfiguration: config) else { return nil }
  let format = UIGraphicsImageRendererFormat()
  format.scale = 3
  return UIGraphicsImageRenderer(size: symbol.size, format: format)
    .image { _ in symbol.draw(at: .zero) }
    .withRenderingMode(.alwaysTemplate)
}
#endif
