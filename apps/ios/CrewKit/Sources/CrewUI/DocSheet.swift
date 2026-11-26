import SwiftUI
import WebKit
#if canImport(UIKit)
import UIKit
#else
import AppKit
#endif
import CrewKit

/// A draft an agent showed: by its doc id (loaded), or with its content right here (older previews).
struct DocRef: Identifiable, Hashable {
  var id: String
  var title: String
  var format: DocFormat
  var content: String?
}

struct DocSheet: View {
  @Environment(AppModel.self) private var model
  @Environment(\.dismiss) private var dismiss
  var ref: DocRef
  @State private var content: String?
  @State private var format: DocFormat
  @State private var error: String?

  init(ref: DocRef) {
    self.ref = ref
    _content = State(initialValue: ref.content)
    _format = State(initialValue: ref.format)
  }

  var body: some View {
    NavigationStack {
      Group {
        if let content {
          switch format {
          case .html:
            HTMLView(html: content)
          case .concepts:
            ConceptsView(json: content)
          default:
            ScrollView {
              MarkdownView(text: content).padding(20)
            }
          }
        } else if let error {
          ContentUnavailableView("Could not open this draft", systemImage: "doc.questionmark", description: Text(error))
        } else {
          ProgressView()
        }
      }
      .navigationTitle(ref.title)
      .inlineTitle()
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done", systemImage: "checkmark") { dismiss() }
        }
        if let content, format == .markdown {
          ToolbarItem(placement: .primaryAction) {
            ShareLink(item: content, preview: SharePreview(ref.title))
          }
        }
      }
    }
    .task {
      guard content == nil else { return }
      do {
        let doc = try await model.loadDoc(ref.id)
        content = doc.content
        format = doc.format
      } catch {
        self.error = error.localizedDescription
      }
    }
  }
}

/// An HTML draft (a landing page, an email), sandboxed as in the Mac app: no
/// scripts, and links open in Safari instead of inside the draft.
private struct HTMLView: View {
  var html: String
  @State private var page: WebPage = {
    var config = WebPage.Configuration()
    config.defaultNavigationPreferences.allowsContentJavaScript = false
    config.websiteDataStore = .nonPersistent()
    return WebPage(configuration: config, navigationDecider: LinksOutside())
  }()

  var body: some View {
    WebView(page)
      .onAppear { page.load(html: html, baseURL: URL(string: "about:blank")!) }
  }
}

/// Ad concepts, as a simple list: the Mac app draws them as ad mockups.
private struct ConceptsView: View {
  var json: String

  private struct Board: Decodable {
    struct Concept: Decodable {
      struct Headline: Decodable {
        var text: String
        init(from decoder: Decoder) throws {
          if let s = try? decoder.singleValueContainer().decode(String.self) { text = s; return }
          text = try decoder.container(keyedBy: K.self).decode(String.self, forKey: .text)
        }
        enum K: String, CodingKey { case text }
      }
      var name: String
      var angle: String
      var headlines: [Headline]
      var primaryText: String?
      var notes: String?
    }
    var intro: String?
    var concepts: [Concept]
  }

  var body: some View {
    if let board = try? JSONDecoder().decode(Board.self, from: Data(json.utf8)) {
      List {
        if let intro = board.intro { Text(inline(intro)).foregroundStyle(.secondary) }
        ForEach(Array(board.concepts.enumerated()), id: \.offset) { i, c in
          Section("\(i + 1). \(c.name)") {
            Text(inline(c.angle))
            ForEach(Array(c.headlines.enumerated()), id: \.offset) { _, h in
              Text(inline(h.text)).font(.headline)
            }
            if let p = c.primaryText { Text(inline(p)).font(.subheadline).foregroundStyle(.secondary) }
            if let n = c.notes { Label(n, systemImage: "exclamationmark.bubble").font(.footnote).foregroundStyle(.orange) }
          }
        }
      }
    } else {
      ScrollView { Text(json).font(.system(.footnote, design: .monospaced)).padding() }
    }
  }
}

private struct LinksOutside: WebPage.NavigationDeciding {
  @MainActor
  func decidePolicy(for action: WebPage.NavigationAction, preferences: inout WebPage.NavigationPreferences) async -> WKNavigationActionPolicy {
    guard let url = action.request.url, url.scheme == "http" || url.scheme == "https" else { return .allow }
    if action.navigationType == .linkActivated { openOutside(url) }
    return .cancel
  }
}

@MainActor
private func openOutside(_ url: URL) {
  #if canImport(UIKit)
  UIApplication.shared.open(url)
  #else
  NSWorkspace.shared.open(url)
  #endif
}
