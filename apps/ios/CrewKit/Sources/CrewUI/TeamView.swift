import SwiftUI
import CrewKit

/// The team: who is working on what right now, every agent, the people, and the account.
struct TeamView: View {
  @Environment(AppModel.self) private var model
  @State private var confirmSignOut = false

  var body: some View {
    List {
      let working = model.activity.filter { $0.status == .running || $0.status == .queued }
      if !working.isEmpty {
        Section("Working now") {
          ForEach(working, id: \.sessionId) { a in
            NavigationLink(value: Route.thread(a.threadId, session: nil)) {
              HStack(spacing: 12) {
                RoleFace(role: a.role, size: 32)
                  .phaseAnimator([1.0, 0.85]) { v, s in v.scaleEffect(s) } animation: { _ in .easeInOut(duration: 0.8) }
                VStack(alignment: .leading, spacing: 2) {
                  Text(model.label(a.role)).font(.subheadline.weight(.semibold))
                  Text(a.doing).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
                  Text(a.threadTitle).font(.caption).foregroundStyle(.tertiary).lineLimit(1)
                }
              }
            }
          }
        }
      }

      Section("Agents") {
        ForEach(model.roles) { r in
          HStack(alignment: .top, spacing: 12) {
            RoleFace(role: r.name, size: 36)
            VStack(alignment: .leading, spacing: 3) {
              HStack(spacing: 6) {
                Text(r.label).font(.body.weight(.semibold))
                if r.isLead {
                  Text("Lead").font(.caption2.weight(.bold)).padding(.horizontal, 6).padding(.vertical, 2)
                    .background(Color.surface, in: .capsule).foregroundStyle(.secondary)
                }
              }
              Text(r.description).font(.footnote).foregroundStyle(.secondary).lineLimit(3)
              Text("\(engineName(r.engine)) · \(r.model)").font(.caption).foregroundStyle(.tertiary)
            }
          }
          .padding(.vertical, 2)
        }
      }

      if model.isTeamServer && !model.people.isEmpty {
        Section("People") {
          ForEach(model.people) { p in
            HStack(spacing: 12) {
              PersonFace(email: p.email, size: 32, showOnline: true)
              VStack(alignment: .leading) {
                Text(p.email == model.me ? "\(p.name) (you)" : p.name)
                Text(model.online.contains(p.email) ? "Online" : p.email).font(.caption).foregroundStyle(.secondary)
              }
            }
          }
        }
      }

      Section {
        LabeledContent("Server", value: model.endpoint?.url.host() ?? "")
        if let me = model.me { LabeledContent("Signed in as", value: me) }
        if let exp = model.endpoint?.accessExpiresAt {
          LabeledContent("Sign-in valid until", value: exp.formatted(date: .abbreviated, time: .shortened))
        }
        Button("Sign out", role: .destructive) { confirmSignOut = true }
      } header: {
        Text("Account")
      } footer: {
        Text("Crew \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "")")
      }
    }
    .navigationTitle("Team")
    .refreshable { try? await model.refreshState() }
    .confirmationDialog("Sign out of \(model.endpoint?.url.host() ?? "Crew")?", isPresented: $confirmSignOut, titleVisibility: .visible) {
      Button("Sign out", role: .destructive) { model.signOut() }
    }
  }

  private func engineName(_ e: String) -> String {
    switch e {
    case "claude-code": "Claude Code"
    case "codex": "Codex"
    case "grok": "Grok Build"
    case "antigravity": "Antigravity"
    default: e
    }
  }
}
