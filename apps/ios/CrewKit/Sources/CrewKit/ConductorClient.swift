import Foundation

/// Where the conductor is and how to get in.
///
/// A team server sits behind Cloudflare Access: the person's Access login (a JWT
/// from the sign-in) goes along as the `cf-access-token` header and is the only
/// credential. A conductor on a Mac (development, the Simulator) takes the app
/// token from ~/.crew/conductor.json instead.
public struct Endpoint: Codable, Sendable, Hashable {
  public var url: URL
  /// The conductor's app token (a conductor on a Mac). Empty behind Cloudflare Access.
  public var appToken: String
  /// The Cloudflare Access login. Nil for a conductor on a Mac.
  public var accessToken: String?

  public init(url: URL, appToken: String = "", accessToken: String? = nil) {
    self.url = url
    self.appToken = appToken
    self.accessToken = accessToken
  }

  /// https on a real host: a team server behind Cloudflare Access.
  public var isTeamServer: Bool { Endpoint.isTeamServer(url) }

  public static func isTeamServer(_ url: URL) -> Bool {
    url.scheme == "https" && !["127.0.0.1", "localhost", "::1"].contains(url.host() ?? "")
  }

  /// When the Access login runs out (its `exp`), or nil when there is none or it cannot be read.
  public var accessExpiresAt: Date? {
    guard let token = accessToken else { return nil }
    return Endpoint.expiry(of: token)
  }

  public static func expiry(of jwt: String) -> Date? {
    let parts = jwt.split(separator: ".")
    guard parts.count == 3 else { return nil }
    var b64 = parts[1].replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    b64 += String(repeating: "=", count: (4 - b64.count % 4) % 4)
    guard let data = Data(base64Encoded: b64),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let exp = obj["exp"] as? Double else { return nil }
    return Date(timeIntervalSince1970: exp)
  }

  /// Normalizes what someone types: "crew.example.com" is https://crew.example.com, no trailing slash.
  public static func parse(_ text: String) -> URL? {
    var s = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !s.isEmpty else { return nil }
    if !s.contains("://") {
      let local = s.hasPrefix("127.0.0.1") || s.hasPrefix("localhost")
      s = (local ? "http://" : "https://") + s
    }
    while s.hasSuffix("/") { s.removeLast() }
    guard let url = URL(string: s), let scheme = url.scheme, ["http", "https"].contains(scheme), url.host() != nil else { return nil }
    return url
  }
}

public enum ConductorError: LocalizedError, Equatable {
  /// The Access login is missing or ran out: sign in again.
  case signInRequired
  case server(status: Int, message: String)
  case offline(String)

  public var errorDescription: String? {
    switch self {
    case .signInRequired: return "Sign in again to continue."
    case .server(_, let message): return message
    case .offline(let message): return message
    }
  }
}

/// The conductor's HTTP API and WebSocket.
public final class ConductorClient: Sendable {
  public let endpoint: Endpoint
  private let session: URLSession

  public init(endpoint: Endpoint) {
    self.endpoint = endpoint
    let config = URLSessionConfiguration.default
    config.httpCookieStorage = nil
    config.httpShouldSetCookies = false
    config.requestCachePolicy = .reloadIgnoringLocalCacheData
    config.timeoutIntervalForRequest = 60
    session = URLSession(configuration: config, delegate: NoRedirects(), delegateQueue: nil)
  }

  private func authorize(_ req: inout URLRequest) {
    if !endpoint.appToken.isEmpty { req.setValue("Bearer \(endpoint.appToken)", forHTTPHeaderField: "authorization") }
    if let token = endpoint.accessToken { req.setValue(token, forHTTPHeaderField: "cf-access-token") }
  }

  private func url(_ path: String) -> URL {
    URL(string: endpoint.url.absoluteString + path)!
  }

  /// Raw bytes (attachments, fonts).
  public func data(_ path: String) async throws -> Data {
    var req = URLRequest(url: url(path))
    authorize(&req)
    return try await send(req)
  }

  public func get<T: Decodable>(_ path: String, as: T.Type = T.self) async throws -> T {
    try await call("GET", path, body: Optional<Empty>.none)
  }

  @discardableResult
  public func post<T: Decodable>(_ path: String, _ body: some Encodable, as: T.Type = T.self) async throws -> T {
    try await call("POST", path, body: body)
  }

  /// A POST whose answer the app does not need.
  public func post(_ path: String, _ body: some Encodable = Empty()) async throws {
    let _: JSONValue = try await call("POST", path, body: body)
  }

  private func call<T: Decodable, B: Encodable>(_ method: String, _ path: String, body: B?) async throws -> T {
    var req = URLRequest(url: url(path))
    req.httpMethod = method
    authorize(&req)
    if let body {
      req.setValue("application/json", forHTTPHeaderField: "content-type")
      req.httpBody = try CrewJSON.encoder.encode(body)
    }
    let data = try await send(req)
    // { error } with a 200 (resolve, merge): the conductor's way of saying no.
    if let err = try? CrewJSON.decoder.decode(ErrorBody.self, from: data), err.id == nil, let message = err.error, !message.isEmpty {
      throw ConductorError.server(status: 200, message: message)
    }
    do {
      return try CrewJSON.decoder.decode(T.self, from: data)
    } catch {
      throw ConductorError.server(status: 200, message: "The server sent something this version of the app cannot read (\(path)). Update the app. \(error)")
    }
  }

  private func send(_ req: URLRequest) async throws -> Data {
    let (data, response): (Data, URLResponse)
    do {
      (data, response) = try await session.data(for: req)
    } catch {
      throw ConductorError.offline((error as NSError).localizedDescription)
    }
    guard let http = response as? HTTPURLResponse else { throw ConductorError.offline("No answer from the server.") }
    // Access answers a missing or expired login with a redirect to its sign-in page, or 401/403.
    if (300..<400).contains(http.statusCode) || http.statusCode == 401 || (http.statusCode == 403 && endpoint.isTeamServer) {
      throw ConductorError.signInRequired
    }
    guard (200..<300).contains(http.statusCode) else {
      let message = (try? CrewJSON.decoder.decode(ErrorBody.self, from: data))?.error ?? HTTPURLResponse.localizedString(forStatusCode: http.statusCode)
      throw ConductorError.server(status: http.statusCode, message: message)
    }
    return data
  }

  // MARK: Socket

  /// Opens the WebSocket. Read messages with `receive()`; it throws when the socket closes.
  public func openSocket() -> ConductorSocket {
    var comps = URLComponents(url: url("/ws"), resolvingAgainstBaseURL: false)!
    comps.scheme = endpoint.url.scheme == "https" ? "wss" : "ws"
    if !endpoint.appToken.isEmpty { comps.queryItems = [URLQueryItem(name: "token", value: endpoint.appToken)] }
    var req = URLRequest(url: comps.url!)
    if let token = endpoint.accessToken { req.setValue(token, forHTTPHeaderField: "cf-access-token") }
    let task = session.webSocketTask(with: req)
    task.maximumMessageSize = 64 * 1024 * 1024
    task.resume()
    return ConductorSocket(task: task)
  }
}

public struct Empty: Codable, Sendable { public init() {} }
private struct ErrorBody: Decodable {
  var error: String?
  /// Set on records (a turn has an error field of its own): those are never an error answer.
  var id: JSONValue?
}

/// Redirects are never followed: from Cloudflare Access one means "sign in".
private final class NoRedirects: NSObject, URLSessionTaskDelegate, Sendable {
  func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest) async -> URLRequest? {
    nil
  }
}

public final class ConductorSocket: Sendable {
  private let task: URLSessionWebSocketTask

  init(task: URLSessionWebSocketTask) {
    self.task = task
  }

  /// The next message, skipping ones this version cannot read. Throws when the socket closes.
  public func receive() async throws -> ServerMessage {
    while true {
      let msg = try await task.receive()
      let data: Data
      switch msg {
      case .string(let s): data = Data(s.utf8)
      case .data(let d): data = d
      @unknown default: continue
      }
      if let decoded = try? CrewJSON.decoder.decode(ServerMessage.self, from: data) { return decoded }
    }
  }

  public func send(_ presence: PresenceMessage) {
    guard let data = try? CrewJSON.encoder.encode(presence), let text = String(data: data, encoding: .utf8) else { return }
    task.send(.string(text)) { _ in }
  }

  public func close() {
    task.cancel(with: .goingAway, reason: nil)
  }

  /// Whether the handshake was refused because the Access login is missing or ran out.
  public var refusedSignIn: Bool {
    guard let http = task.response as? HTTPURLResponse else { return false }
    return http.statusCode == 401 || http.statusCode == 403 || (300..<400).contains(http.statusCode)
  }
}
