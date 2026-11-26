import Foundation

/// Agent messages are Markdown. SwiftUI's Text does inline Markdown (bold, links,
/// code) but not blocks, so this splits a message into blocks the app draws natively.
public enum MarkdownBlock: Sendable, Hashable {
  case paragraph(String)
  case heading(level: Int, text: String)
  /// Items of one list; `ordered` lists keep their first number.
  case list(ordered: Bool, start: Int, items: [ListItem])
  case code(language: String?, text: String)
  case quote(String)
  case table(header: [String], rows: [[String]])
  case rule

  public struct ListItem: Sendable, Hashable {
    public var text: String
    /// Nesting depth, 0 at the left.
    public var depth: Int
    /// A task list item: [ ] or [x].
    public var checked: Bool?
  }
}

public enum Markdown {
  /// Markdown cut off mid-way (an answer being written), made to render as it will once
  /// finished: an open code fence, bold or inline code is closed for now, and a lone
  /// marker at the very end is left out, so the formatting does not flicker as it grows.
  /// Ported from closeOpenMarkdown in apps/mac.
  public static func closeOpen(_ text: String) -> String {
    let fences = text.split(separator: "\n", omittingEmptySubsequences: false)
      .filter { let t = $0.drop { $0 == " " || $0 == "\t" }; return t.hasPrefix("```") || t.hasPrefix("~~~") }.count
    if fences % 2 == 1 { return text + (text.hasSuffix("\n") ? "" : "\n") + "```" }
    var t = text
    while let last = t.last, "*_`~".contains(last) { t.removeLast() }
    let line = t.split(separator: "\n", omittingEmptySubsequences: false).last.map(String.init) ?? ""
    if line.filter({ $0 == "`" }).count % 2 == 1 { return t + "`" }
    if line.components(separatedBy: "**").count % 2 == 0 { t += "**" }
    if line.components(separatedBy: "~~").count % 2 == 0 { t += "~~" }
    return t
  }

  public static func blocks(_ text: String) -> [MarkdownBlock] {
    var out: [MarkdownBlock] = []
    let lines = text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
    var i = 0
    var paragraph: [String] = []

    func flush() {
      let p = paragraph.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
      if !p.isEmpty { out.append(.paragraph(p)) }
      paragraph = []
    }

    while i < lines.count {
      let line = lines[i]
      let trimmed = line.trimmingCharacters(in: .whitespaces)

      // Fenced code.
      if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
        flush()
        let fence = String(trimmed.prefix(3))
        let lang = trimmed.dropFirst(3).trimmingCharacters(in: .whitespaces)
        var code: [String] = []
        i += 1
        while i < lines.count, !lines[i].trimmingCharacters(in: .whitespaces).hasPrefix(fence) {
          code.append(lines[i])
          i += 1
        }
        out.append(.code(language: lang.isEmpty ? nil : lang, text: code.joined(separator: "\n")))
        i += 1
        continue
      }

      if trimmed.isEmpty {
        flush()
        i += 1
        continue
      }

      // Heading.
      if let level = headingLevel(trimmed) {
        flush()
        out.append(.heading(level: level, text: trimmed.dropFirst(level).trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "#")).trimmingCharacters(in: .whitespaces)))
        i += 1
        continue
      }

      // Rule.
      if paragraph.isEmpty, isRule(trimmed) {
        out.append(.rule)
        i += 1
        continue
      }

      // Table: a header row, then a |---| row.
      if trimmed.hasPrefix("|"), i + 1 < lines.count, isTableDivider(lines[i + 1]) {
        flush()
        let header = cells(trimmed)
        var rows: [[String]] = []
        i += 2
        while i < lines.count, lines[i].trimmingCharacters(in: .whitespaces).hasPrefix("|") {
          rows.append(cells(lines[i].trimmingCharacters(in: .whitespaces)))
          i += 1
        }
        out.append(.table(header: header, rows: rows))
        continue
      }

      // Quote.
      if trimmed.hasPrefix(">") {
        flush()
        var quoted: [String] = []
        while i < lines.count, lines[i].trimmingCharacters(in: .whitespaces).hasPrefix(">") {
          quoted.append(String(lines[i].trimmingCharacters(in: .whitespaces).dropFirst()).trimmingCharacters(in: .whitespaces))
          i += 1
        }
        out.append(.quote(quoted.joined(separator: "\n")))
        continue
      }

      // List.
      if let first = listMarker(line) {
        flush()
        var items: [MarkdownBlock.ListItem] = []
        let ordered = first.ordered
        while i < lines.count {
          if let m = listMarker(lines[i]) {
            if m.depth == 0 && m.ordered != ordered { break }
            var text = m.text
            var checked: Bool?
            if text.hasPrefix("[ ] ") { checked = false; text = String(text.dropFirst(4)) }
            else if text.lowercased().hasPrefix("[x] ") { checked = true; text = String(text.dropFirst(4)) }
            items.append(.init(text: text, depth: m.depth, checked: checked))
            i += 1
          } else if !lines[i].trimmingCharacters(in: .whitespaces).isEmpty, lines[i].hasPrefix("  "), !items.isEmpty {
            // A continuation line of the item above.
            items[items.count - 1].text += " " + lines[i].trimmingCharacters(in: .whitespaces)
            i += 1
          } else {
            break
          }
        }
        out.append(.list(ordered: ordered, start: first.number, items: items))
        continue
      }

      paragraph.append(line)
      i += 1
    }
    flush()
    return out
  }

  private static func headingLevel(_ s: String) -> Int? {
    let hashes = s.prefix { $0 == "#" }.count
    guard (1...6).contains(hashes), s.count == hashes || s.dropFirst(hashes).first == " " else { return nil }
    return hashes
  }

  private static func isRule(_ s: String) -> Bool {
    let chars = s.filter { !$0.isWhitespace }
    guard chars.count >= 3, let c = chars.first, "-*_".contains(c) else { return false }
    return chars.allSatisfy { $0 == c }
  }

  private static func isTableDivider(_ line: String) -> Bool {
    let t = line.trimmingCharacters(in: .whitespaces)
    return t.hasPrefix("|") && t.contains("-") && t.allSatisfy { "|-: ".contains($0) }
  }

  private static func cells(_ row: String) -> [String] {
    var r = row
    if r.hasPrefix("|") { r.removeFirst() }
    if r.hasSuffix("|") { r.removeLast() }
    return r.split(separator: "|", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }
  }

  private static func listMarker(_ line: String) -> (ordered: Bool, number: Int, depth: Int, text: String)? {
    let indent = line.prefix { $0 == " " || $0 == "\t" }.reduce(0) { $0 + ($1 == "\t" ? 4 : 1) }
    let rest = line.drop { $0 == " " || $0 == "\t" }
    let depth = min(indent / 2, 4)
    if let c = rest.first, "-*+".contains(c), rest.dropFirst().first == " " {
      return (false, 1, depth, String(rest.dropFirst(2)))
    }
    let digits = rest.prefix { $0.isNumber }
    if !digits.isEmpty, digits.count <= 3 {
      let after = rest.dropFirst(digits.count)
      if let d = after.first, d == "." || d == ")", after.dropFirst().first == " " {
        return (true, Int(digits) ?? 1, depth, String(after.dropFirst(2)))
      }
    }
    return nil
  }
}
