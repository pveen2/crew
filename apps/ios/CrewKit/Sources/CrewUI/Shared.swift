import SwiftUI
import CrewKit

/// Where a tab's navigation can go.
enum Route: Hashable {
  case thread(String, session: String? = nil)
  case dm(String)
}

// MARK: - Markdown

/// An agent's Markdown, drawn with native text: headings, lists, code, quotes, tables.
struct MarkdownView: View {
  var text: String
  var font: Font = .body
  /// While an answer is being written: blocks from this index on fade in as they appear.
  var fadeFrom: Int?
  /// An answer being written: how many of its newest words are still fading in.
  var fadingWords = 0
  /// Take the full width (agent answers). False: as wide as the text (your bubbles).
  var fill = true

  var body: some View {
    let blocks = Markdown.blocks(text)
    VStack(alignment: .leading, spacing: 10) {
      ForEach(Array(blocks.enumerated()), id: \.offset) { i, block in
        BlockView(block: block, font: font, fadingWords: i == blocks.count - 1 ? fadingWords : 0)
          .modifier(FadeIn(active: fadeFrom.map { i >= $0 } ?? false))
      }
    }
    .textSelection(.enabled)
    .frame(maxWidth: fill ? .infinity : nil, alignment: .leading)
  }
}

/// Text whose newest words fade in: the end of an answer being written. The last
/// `words` words are fainter the newer they are; as the next words come in (or the
/// answer pauses) they fill in, so the text washes in word by word.
private struct FadingText: View {
  var text: String
  var font: Font
  var words: Int

  var body: some View {
    Text(faded).font(font).fixedSize(horizontal: false, vertical: true)
  }

  private var faded: AttributedString {
    var a = inline(text)
    guard words > 0 else { return a }
    // Where the last few words start, walking back over the text.
    var starts: [AttributedString.Index] = []
    var i = a.endIndex
    var inWord = false
    while i > a.startIndex, starts.count < words {
      let prev = a.characters.index(before: i)
      let space = a.characters[prev].isWhitespace
      if inWord && space { starts.append(i) }
      inWord = !space
      i = prev
    }
    if inWord && starts.count < words { starts.append(a.startIndex) }
    // Newest word faintest: with 3 words, 0.25, 0.5, 0.75.
    var end = a.endIndex
    for (k, start) in starts.enumerated() {
      a[start..<end].foregroundColor = Color.primary.opacity(Double(k + 1) / Double(words + 1))
      end = start
    }
    return a
  }
}

/// A new block of an answer being written fades in once, as in the Mac app.
private struct FadeIn: ViewModifier {
  var active: Bool
  @State private var shown = false

  func body(content: Content) -> some View {
    content
      .opacity(!active || shown ? 1 : 0)
      .onAppear { withAnimation(.easeOut(duration: 0.6)) { shown = true } }
  }
}

/// An agent's answer as it is being written (`streaming`), or just after. It comes out
/// word by word at an even pace that speeds up when more is waiting, so it never lags far
/// behind, and each new word fades in. Ported from useReveal / StreamingMarkdown /
/// AgentMarkdown in apps/mac, with words instead of characters.
struct RevealingMarkdown: View {
  @Environment(AppModel.self) private var model
  var sessionId: String
  var text: String
  var streaming: Bool
  @State private var exact: Double
  @State private var start: Int
  /// How many of the newest words are still fading in.
  @State private var fading = 0

  /// Characters a second at the least; a backlog is shown within about this long.
  private static let minRate = 90.0
  private static let catchUp = 0.3
  /// Words that are fading in at once, and how fast they fill in when the text pauses.
  private static let fadeWords = 3
  private static let fillStep = Duration.milliseconds(110)

  init(sessionId: String, text: String, streaming: Bool, start: Int) {
    self.sessionId = sessionId
    self.text = text
    self.streaming = streaming
    _exact = State(initialValue: Double(min(start, text.count)))
    _start = State(initialValue: min(start, text.count))
  }

  /// How much shows: up to the end of the last whole word within `exact`.
  private var shown: Int {
    let n = min(Int(exact), text.count)
    if n >= text.count { return text.count }
    let prefix = text.prefix(n)
    guard let space = prefix.lastIndex(where: \.isWhitespace) else { return 0 }
    return prefix.distance(from: prefix.startIndex, to: space)
  }

  var body: some View {
    let done = !streaming && shown >= text.count && fading == 0
    let visible = done ? text : Markdown.closeOpen(String(text.prefix(shown)))
    MarkdownView(text: visible, fadeFrom: done ? nil : (start > 0 ? Markdown.blocks(String(text.prefix(start))).count : 0), fadingWords: done ? 0 : fading)
      .task(id: text) {
        var last = Date()
        while !Task.isCancelled, Int(exact) < text.count {
          try? await Task.sleep(for: .milliseconds(32))
          let now = Date()
          let dt = min(now.timeIntervalSince(last), 0.1)
          last = now
          let before = shown
          let backlog = Double(text.count) - exact
          exact = min(Double(text.count), exact + max(backlog * dt / Self.catchUp, Self.minRate * dt))
          if shown != before { fading = Self.fadeWords }
          model.revealed[sessionId] = (text, shown, now)
        }
        // Caught up (or the agent paused): the last words fill in.
        while !Task.isCancelled, fading > 0 {
          try? await Task.sleep(for: Self.fillStep)
          fading -= 1
        }
      }
  }
}

/// A finished agent message. Just after it was streamed it goes on from where the
/// stream had got to; otherwise it shows at once.
struct AgentMessage: View {
  @Environment(AppModel.self) private var model
  var sessionId: String
  var text: String
  var ts: Millis

  var body: some View {
    RevealingMarkdown(sessionId: sessionId, text: text, streaming: false, start: start)
  }

  private var start: Int {
    guard let r = model.revealed[sessionId], Date().timeIntervalSince(ts.date) < 15,
          text.hasPrefix(String(r.text.prefix(r.shown))) else { return text.count }
    return r.shown
  }
}

/// Inline Markdown (bold, italics, `code`, links) as an AttributedString.
func inline(_ s: String) -> AttributedString {
  (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(s)
}

private struct BlockView: View {
  var block: MarkdownBlock
  var font: Font
  var fadingWords = 0

  var body: some View {
    switch block {
    case .paragraph(let s):
      if fadingWords > 0 {
        FadingText(text: s, font: font, words: fadingWords)
      } else {
        Text(inline(s)).font(font).fixedSize(horizontal: false, vertical: true)
      }
    case .heading(let level, let s):
      Text(inline(s))
        .font(level == 1 ? .title3.bold() : level == 2 ? .headline : .subheadline.bold())
        .padding(.top, 4)
    case .list(let ordered, let start, let items):
      VStack(alignment: .leading, spacing: 6) {
        ForEach(Array(items.enumerated()), id: \.offset) { i, item in
          HStack(alignment: .firstTextBaseline, spacing: 8) {
            Group {
              if let checked = item.checked {
                Image(systemName: checked ? "checkmark.square.fill" : "square")
              } else if ordered {
                Text("\(start + i).").monospacedDigit()
              } else {
                Text(item.depth == 0 ? "•" : "◦")
              }
            }
            .foregroundStyle(.secondary)
            .frame(minWidth: 14, alignment: .trailing)
            if fadingWords > 0 && i == items.count - 1 {
              FadingText(text: item.text, font: font, words: fadingWords)
            } else {
              Text(inline(item.text)).font(font).fixedSize(horizontal: false, vertical: true)
            }
          }
          .padding(.leading, CGFloat(item.depth) * 18)
        }
      }
    case .code(_, let code):
      ScrollView(.horizontal, showsIndicators: false) {
        Text(code)
          .font(.system(.footnote, design: .monospaced))
          .padding(12)
      }
      .background(.quaternary.opacity(0.6), in: .rect(cornerRadius: 12))
    case .quote(let s):
      HStack(spacing: 10) {
        Capsule().fill(.tertiary).frame(width: 3)
        Text(inline(s)).font(font).foregroundStyle(.secondary)
      }
    case .table(let header, let rows):
      ScrollView(.horizontal, showsIndicators: false) {
        Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 8) {
          GridRow { ForEach(Array(header.enumerated()), id: \.offset) { _, h in Text(inline(h)).bold() } }
          Divider()
          ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
            GridRow { ForEach(Array(row.enumerated()), id: \.offset) { _, c in Text(inline(c)) } }
          }
        }
        .font(.subheadline)
        .padding(12)
      }
      .background(.quaternary.opacity(0.4), in: .rect(cornerRadius: 12))
    case .rule:
      Divider()
    }
  }
}

// MARK: - Images

/// An image attached in a thread or DM, loaded with the sign-in.
struct AttachmentImage: View {
  @Environment(AppModel.self) private var model
  var threadId: String
  var attachment: Attachment
  @State private var image: PlatformImage?
  @State private var showFull = false

  var body: some View {
    Group {
      if let image {
        Image(platformImage: image)
          .resizable()
          .scaledToFill()
      } else {
        Rectangle().fill(.quaternary).overlay(ProgressView())
      }
    }
    .frame(width: 180, height: 180)
    .clipShape(.rect(cornerRadius: 14))
    .contentShape(.rect)
    .onTapGesture { if image != nil { showFull = true } }
    .task(id: attachment.file) { image = await model.image(threadId: threadId, file: attachment.file) }
    .sheet(isPresented: $showFull) {
      if let image {
        NavigationStack {
          ScrollView([.horizontal, .vertical]) {
            Image(platformImage: image).resizable().scaledToFit()
          }
          .navigationTitle(attachment.name)
          .inlineTitle()
          .toolbar {
            ToolbarItem(placement: .confirmationAction) { Button("Done", systemImage: "checkmark") { showFull = false } }
          }
        }
      }
    }
    .accessibilityLabel(attachment.name)
  }
}

// MARK: - Time

enum Ago {
  /// "now", "6m", "1h", "Yesterday", "12 Nov": list times, as in Messages.
  static func short(_ ms: Millis, now: Date = .now) -> String {
    let date = ms.date
    let s = now.timeIntervalSince(date)
    if s < 60 { return "now" }
    if s < 3600 { return "\(Int(s / 60))m" }
    if Calendar.current.isDateInToday(date) { return date.formatted(date: .omitted, time: .shortened) }
    if Calendar.current.isDateInYesterday(date) { return "Yesterday" }
    if s < 6 * 86400 { return date.formatted(.dateTime.weekday(.wide)) }
    return date.formatted(.dateTime.day().month(.abbreviated))
  }

  static func clock(_ ms: Millis) -> String { ms.date.formatted(date: .omitted, time: .shortened) }
}

// MARK: - Bits

/// The coloured dot for a thread's state.
struct StatusDot: View {
  var status: ThreadStatus

  var body: some View {
    Circle()
      .fill(color)
      .frame(width: 8, height: 8)
      .opacity(status == .idle ? 0 : 1)
      .symbolEffect(.pulse, isActive: status == .running)
  }

  private var color: Color {
    switch status {
    case .needsYou: .orange
    case .running: .blue
    case .error: .red
    case .interrupted: .yellow
    default: .clear
    }
  }
}

/// A line of state in the chat: "Approved: shopify_update", "Stopped".
struct StatusLine: View {
  enum Tone { case secondary, caution, critical }
  var tone: Tone = .secondary
  var icon: String = "info.circle"
  var text: String

  var body: some View {
    Label(text, systemImage: icon)
      .font(.footnote)
      .foregroundStyle(tone == .critical ? Color.red : tone == .caution ? Color.orange : Color.secondary)
      .frame(maxWidth: .infinity, alignment: .leading)
  }
}

/// Runs an action and keeps its error for an alert.
@MainActor @Observable
final class Action {
  var busy = false
  var error: String?

  func run(_ work: @escaping () async throws -> Void) {
    guard !busy else { return }
    busy = true
    error = nil
    Task {
      do { try await work() } catch { self.error = error.localizedDescription }
      busy = false
    }
  }
}

extension View {
  /// Shows an Action's error as an alert.
  func errorAlert(_ action: Action) -> some View {
    alert("Something went wrong", isPresented: Binding(get: { action.error != nil }, set: { if !$0 { action.error = nil } })) {
      Button("OK", role: .cancel) {}
    } message: {
      Text(action.error ?? "")
    }
  }
}

/// A banner when the connection is gone.
struct OfflineBanner: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    if model.phase == .offline {
      Label("Reconnecting…", systemImage: "wifi.exclamationmark")
        .font(.footnote.weight(.medium))
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .glassEffect(.regular, in: .capsule)
        .transition(.move(edge: .top).combined(with: .opacity))
    }
  }
}
