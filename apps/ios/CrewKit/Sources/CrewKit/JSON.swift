import Foundation

/// Any JSON value: a tool call's input, which the conductor passes on as is.
public enum JSONValue: Codable, Sendable, Hashable {
  case null
  case bool(Bool)
  case number(Double)
  case string(String)
  case array([JSONValue])
  case object([String: JSONValue])

  public init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    if c.decodeNil() { self = .null }
    else if let b = try? c.decode(Bool.self) { self = .bool(b) }
    else if let n = try? c.decode(Double.self) { self = .number(n) }
    else if let s = try? c.decode(String.self) { self = .string(s) }
    else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
    else { self = .object(try c.decode([String: JSONValue].self)) }
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.singleValueContainer()
    switch self {
    case .null: try c.encodeNil()
    case .bool(let b): try c.encode(b)
    case .number(let n): try c.encode(n)
    case .string(let s): try c.encode(s)
    case .array(let a): try c.encode(a)
    case .object(let o): try c.encode(o)
    }
  }

  public subscript(key: String) -> JSONValue? {
    if case .object(let o) = self { return o[key] }
    return nil
  }

  /// Strings as they are, anything else as compact JSON.
  public var text: String {
    switch self {
    case .null: return ""
    case .string(let s): return s
    case .bool(let b): return String(b)
    case .number(let n): return n.rounded() == n && abs(n) < 1e15 ? String(Int64(n)) : String(n)
    default:
      let enc = JSONEncoder()
      enc.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
      return (try? enc.encode(self)).flatMap { String(data: $0, encoding: .utf8) } ?? ""
    }
  }
}

/// A string enum that keeps working when the conductor adds a value the app does not know yet.
public protocol LenientEnum: RawRepresentable, Codable, Sendable, Hashable where RawValue == String {
  static var unknown: Self { get }
}

extension LenientEnum {
  public init(from decoder: Decoder) throws {
    let raw = try decoder.singleValueContainer().decode(String.self)
    self = Self(rawValue: raw) ?? .unknown
  }
  public func encode(to encoder: Encoder) throws {
    var c = encoder.singleValueContainer()
    try c.encode(rawValue)
  }
}

extension KeyedDecodingContainer {
  /// A list that may be missing (older conductors): empty then.
  func list<T: Decodable>(_ key: Key) throws -> [T] {
    try decodeIfPresent([T].self, forKey: key) ?? []
  }
}

public enum CrewJSON {
  public static let decoder = JSONDecoder()
  public static let encoder: JSONEncoder = {
    let e = JSONEncoder()
    e.outputFormatting = [.withoutEscapingSlashes]
    return e
  }()
}
