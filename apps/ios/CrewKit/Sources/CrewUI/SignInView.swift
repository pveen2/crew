import SwiftUI
import AuthenticationServices
import CrewKit

/// Sign in to the team's server (through Cloudflare Access, in a system sheet so
/// passkeys and password managers work), or to a conductor on a Mac with its token.
struct SignInView: View {
  @Environment(AppModel.self) private var model
  @Environment(\.webAuthenticationSession) private var webAuth
  @State private var server = ""
  @State private var token = ""
  @State private var busy = false
  @State private var error: String?
  @FocusState private var focused: Bool

  private var url: URL? { Endpoint.parse(server) }
  private var needsToken: Bool { url.map { !Endpoint.isTeamServer($0) } ?? false }

  var body: some View {
    NavigationStack {
      Form {
        Section {
          VStack(spacing: 14) {
            RoleFace(role: "gm", size: 72)
            Text("Crew").font(.largeTitle.bold())
            Text("Your digital team, on your phone.")
              .foregroundStyle(.secondary)
          }
          .frame(maxWidth: .infinity)
          .padding(.vertical, 12)
          .listRowBackground(Color.clear)
        }

        Section {
          TextField("crew.example.com", text: $server)
            .urlKeyboard()
            .focused($focused)
            .submitLabel(.go)
            .onSubmit(go)
          if needsToken {
            SecureField("App token", text: $token)
              .plainKeyboard()
          }
        } header: {
          Text("Server")
        } footer: {
          Text(needsToken
            ? "A conductor on your Mac: the token is in ~/.crew/conductor.json."
            : "The address of your team's Crew server. You sign in with your work account.")
        }

        if let message = error ?? model.signInMessage {
          Section {
            Label(message, systemImage: "exclamationmark.triangle.fill")
              .foregroundStyle(.red)
          }
        }
      }
      .safeAreaInset(edge: .bottom) {
        Button(action: go) {
          Group {
            if busy { ProgressView() } else { Text("Sign in").bold() }
          }
          .frame(maxWidth: .infinity)
          .padding(.vertical, 6)
        }
        .buttonStyle(.glassProminent)
        .tint(.primary)
        .foregroundStyle(Color.crewBackground)
        .controlSize(.large)
        .disabled(url == nil || busy || (needsToken && token.isEmpty))
        .padding(.horizontal, 20)
        .padding(.bottom, 8)
      }
      .onAppear {
        if server.isEmpty { server = model.lastServer.replacingOccurrences(of: "https://", with: "") }
      }
    }
  }

  private func go() {
    guard let url, !busy else { return }
    busy = true
    error = nil
    Task {
      defer { busy = false }
      do {
        if Endpoint.isTeamServer(url) {
          let jwt = try await accessSignIn(url)
          try await model.signIn(Endpoint(url: url, accessToken: jwt))
        } else {
          try await model.signIn(Endpoint(url: url, appToken: token.trimmingCharacters(in: .whitespacesAndNewlines)))
        }
      } catch let e as ASWebAuthenticationSessionError where e.code == .canceledLogin {
        // Closed the sheet: nothing to say.
      } catch {
        self.error = error.localizedDescription
      }
    }
  }

  /// The conductor's /auth/app-login, behind Access, sends the login back to crew://signed-in.
  private func accessSignIn(_ server: URL) async throws -> String {
    let state = (0..<32).map { _ in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_".randomElement()! }.map(String.init).joined()
    var comps = URLComponents(url: server.appending(path: "auth/app-login"), resolvingAgainstBaseURL: false)!
    comps.queryItems = [URLQueryItem(name: "to", value: "ios"), URLQueryItem(name: "state", value: state)]
    let back = try await webAuth.authenticate(using: comps.url!, callback: .customScheme("crew"), preferredBrowserSession: .shared, additionalHeaderFields: [:])
    let items = URLComponents(url: back, resolvingAgainstBaseURL: false)?.queryItems ?? []
    guard items.first(where: { $0.name == "state" })?.value == state,
          let jwt = items.first(where: { $0.name == "token" })?.value, !jwt.isEmpty else {
      throw ConductorError.server(status: 400, message: "The sign-in did not come back right. Try again.")
    }
    return jwt
  }
}
