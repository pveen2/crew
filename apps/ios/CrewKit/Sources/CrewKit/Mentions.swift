import Foundation

// @-mentions in the composer, ported from apps/mac/src/store.ts and ThreadView.tsx
// (mentionedPeople, leadingPerson, mentionedRole, resolveMention, mentionsAny,
// mentionsSpecialist). Keep the two in step.

public enum Mentions {
  private static func escape(_ s: String) -> String { NSRegularExpression.escapedPattern(for: s) }

  /// "@<name>" as a word of its own.
  private static func wordRegex(_ name: String) -> NSRegularExpression? {
    try? NSRegularExpression(pattern: "(^|[^\\w@])@\(escape(name))(?![\\w])", options: [.caseInsensitive])
  }

  private static func matches(_ re: NSRegularExpression, _ text: String) -> Bool {
    re.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
  }

  /// The people a message tags, by email. Longest names first; a name two people share tags nobody.
  public static func mentionedPeople(_ text: String, people: [Person], me: String?) -> [String] {
    var byName: [String: [Person]] = [:]
    for p in people where p.email != me { byName[p.name.lowercased(), default: []].append(p) }
    var out: [String] = []
    var rest = text
    for name in byName.keys.sorted(by: { $0.count > $1.count }) {
      guard let re = wordRegex(name), matches(re, rest) else { continue }
      if let who = byName[name], who.count == 1 { out.append(who[0].email) }
      rest = re.stringByReplacingMatches(in: rest, range: NSRange(rest.startIndex..., in: rest), withTemplate: "$1")
    }
    return out
  }

  /// The colleague a message starts with ("@Paul Veen, …"), if any.
  public static func leadingPerson(_ text: String, people: [Person], me: String?) -> Person? {
    let lower = text.lowercased()
    return people
      .filter { $0.email != me }
      .sorted { $0.name.count > $1.name.count }
      .first { p in
        let key = "@" + p.name.lowercased()
        guard lower.hasPrefix(key) else { return false }
        guard let next = lower.dropFirst(key.count).first else { return true }
        return !(next.isLetter || next.isNumber || next == "_")
      }
  }

  public static func mentionsAny(_ body: String, names: [String]) -> Bool {
    names.contains { !$0.isEmpty && wordRegex($0).map { matches($0, body) } == true }
  }

  /// An "@specialist" anywhere, as a word of its own, by name or dashed label.
  public static func mentionsSpecialist(_ body: String, roles: [RoleSummary]) -> Bool {
    let keys = Set(roles.filter { !$0.isLead }.flatMap { [$0.name.lowercased(), $0.label.lowercased().replacingOccurrences(of: " ", with: "-")] })
    guard let re = try? NSRegularExpression(pattern: "(?:^|\\s)@([\\w-]+)(?=$|[\\s.,;:!?)])") else { return false }
    let lower = body.lowercased()
    return re.matches(in: lower, range: NSRange(lower.startIndex..., in: lower)).contains { m in
      Range(m.range(at: 1), in: lower).map { keys.contains(String(lower[$0])) } ?? false
    }
  }

  private static func startsWithKey(_ lower: String, _ key: String) -> Bool {
    guard lower.hasPrefix("@" + key) else { return false }
    guard let next = lower.dropFirst(1 + key.count).first else { return true }
    return next.isWhitespace
  }

  private static func rest(_ body: String, after key: String) -> String {
    String(body.dropFirst(1 + key.count)).trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private static func firstWord(_ body: String) -> String {
    String(body.dropFirst().prefix { !$0.isWhitespace })
  }

  public enum Routed: Equatable {
    case to(String, rest: String)
    case error(String)
  }

  /// "@developer …" in a thread the lead owns: which agent it names. Names first, labels only when no name fits.
  public static func mentionedRole(_ body: String, roles: [RoleSummary]) -> Routed {
    let lower = body.lowercased()
    var best: (key: String, role: String)?
    for byName in [true, false] {
      for r in roles {
        let keys = byName ? [r.name.lowercased()] : [r.label.lowercased(), r.label.lowercased().replacingOccurrences(of: " ", with: "-")]
        for key in keys where startsWithKey(lower, key) {
          if best == nil || key.count > best!.key.count { best = (key, r.name) }
        }
      }
      if best != nil { break }
    }
    guard let best else { return .error("No agent called @\(firstWord(body)) on this thread's team.") }
    let text = rest(body, after: best.key)
    return text.isEmpty ? .error("Write a message after the @ name.") : .to(best.role, rest: text)
  }

  public struct SessionOption: Sendable, Hashable, Identifiable {
    /// The session id.
    public var value: String
    public var role: String
    public var label: String
    public var id: String { value }
    public init(value: String, role: String, label: String) {
      self.value = value
      self.role = role
      self.label = label
    }
  }

  /// "@store-manager …" or "@Store manager …": that agent's session in this thread.
  public static func resolveMention(_ body: String, options: [SessionOption], currentSessionId: String) -> Routed {
    let lower = body.lowercased()
    var best: (key: String, matches: [SessionOption])?
    for o in options {
      let keys = Set([o.role, o.label.lowercased(), o.label.lowercased().replacingOccurrences(of: " ", with: "-")])
      for key in keys where startsWithKey(lower, key) {
        if best == nil || key.count > best!.key.count { best = (key, [o]) }
        else if key == best!.key && !best!.matches.contains(o) { best!.matches.append(o) }
      }
    }
    guard let best else { return .error("No agent called @\(firstWord(body)) in this thread. Pick one with the Talk to menu.") }
    let text = rest(body, after: best.key)
    if text.isEmpty { return .error("Write a message after the @ name.") }
    let byLabel = best.matches.filter { [$0.label.lowercased(), $0.label.lowercased().replacingOccurrences(of: " ", with: "-")].contains(best.key) }
    let pick = best.matches.count == 1 ? best.matches[0] : byLabel.count == 1 ? byLabel[0] : best.matches.first { $0.value == currentSessionId }
    guard let pick else { return .error("There are several \(best.matches[0].label) sessions here. Pick one with the Talk to menu.") }
    return .to(pick.value, rest: text)
  }

  /// The sessions you can talk to in a thread, lead first, numbered when a role has several ("Developer 2").
  public static func sessionOptions(sessions: [Session], labels: [String: String]) -> [SessionOption] {
    let list = sessions.sorted { $0.depth != $1.depth ? $0.depth < $1.depth : $0.createdAt < $1.createdAt }
    var total: [String: Int] = [:]
    for s in list { total[s.role, default: 0] += 1 }
    var seen: [String: Int] = [:]
    return list.map { s in
      seen[s.role, default: 0] += 1
      let base = labels[s.role] ?? s.role
      let label = (total[s.role] ?? 0) > 1 && seen[s.role]! > 1 ? "\(base) \(seen[s.role]!)" : base
      return SessionOption(value: s.id, role: s.role, label: label)
    }
  }
}

public enum Names {
  private static func capital(_ s: Substring) -> String { s.prefix(1).uppercased() + s.dropFirst() }

  /// Names for everyone on a team server: "juliette@…" is Juliette; two Pauls get their last names.
  public static func namePeople(_ emails: [String]) -> [String: String] {
    var list: [String] = []
    for e in emails.map({ $0.lowercased() }) where !list.contains(e) { list.append(e) }
    func parts(_ email: String) -> [Substring] {
      (email.split(separator: "@").first ?? Substring(email)).split(whereSeparator: { ".-_+".contains($0) })
    }
    func first(_ email: String) -> String { parts(email).first.map(capital) ?? email }
    func full(_ email: String) -> String {
      let p = parts(email).map(capital).joined(separator: " ")
      return p.isEmpty ? email : p
    }
    let firsts = list.map(first)
    var out: [String: String] = [:]
    for (i, email) in list.enumerated() {
      out[email] = firsts.filter { $0 == firsts[i] }.count > 1 ? full(email) : firsts[i]
    }
    let names = list.map { out[$0]! }
    for (i, email) in list.enumerated() where names.filter({ $0 == names[i] }).count > 1 {
      out[email] = "\(names[i]) (\(email.split(separator: "@").dropFirst().first.map(String.init) ?? email))"
    }
    return out
  }
}
