# Crew for iPhone

A native SwiftUI app (iOS 26, Liquid Glass) for working with your team from your
phone. Like the Mac app it only displays what the conductor sends: it talks to the
same HTTP API and WebSocket (`packages/protocol`), and has no agent logic.

```
apps/ios/
  project.yml        XcodeGen spec for Crew.xcodeproj (generated, not checked in)
  Crew/              the app target: CrewApp.swift and the asset catalog
  CrewKit/           a Swift package with all the code
    Sources/CrewKit  wire format (packages/protocol in Swift), conductor client,
                     how events become the chat (ported from ThreadView.tsx),
                     @-mentions, Markdown blocks, Keychain
    Sources/CrewUI   app state (AppModel, mirrors apps/mac/src/store.ts) and screens
    Tests/           unit tests for CrewKit
```

When `packages/protocol/src/index.ts` changes, change `CrewKit/Sources/CrewKit/Models.swift`
and `Events.swift` with it. Event types and enum values the app does not know yet are
skipped rather than breaking the app, so an older app keeps working with a newer server.

## Run it

You need Xcode 26 or later (from the App Store) and XcodeGen (`brew install xcodegen`).

```sh
pnpm ios          # generates Crew.xcodeproj and opens it in Xcode
```

Pick an iPhone simulator and press Run. To run it on your own phone, set your team
under Signing & Capabilities (an Apple Developer account; a free one works for
your own device).

**Sign in:**

- **A team server** (behind Cloudflare Access): type its address, e.g.
  `crew.example.com`. The app opens the Access sign-in in a system sheet. The
  conductor's `/auth/app-login?to=ios` sends the login back to the app through
  `crew://signed-in`, and the app keeps it in the Keychain and sends it as the
  `cf-access-token` header. When it runs out, the app asks you to sign in again.
- **A conductor on your Mac** (development, in the Simulator): `127.0.0.1:4317` and the
  token from `~/.crew/conductor.json`. A real phone can't reach 127.0.0.1 on your Mac;
  use a team server for that.

**Without a server:** `pnpm ios:demo` starts a pretend conductor with sample threads
(a question, an approval, a finished answer with a draft, direct messages) that
answers messages with a streamed reply. Sign in to `127.0.0.1:4390` with the token `demo`.

**Debug builds only**, for the Simulator and screenshots: set these in the scheme
(or as `SIMCTL_CHILD_…` for `xcrun simctl launch`):

- `CREW_SERVER` and `CREW_TOKEN`: sign in without the sign-in screen.
- `CREW_OPEN=crew://thread/<id>`: open a screen at launch.

**Links:** `crew://inbox`, `crew://threads`, `crew://new`, `crew://thread/<id>`,
`crew://messages`, `crew://dm/<id>` and `crew://team` open that screen. These are also
what notifications will open later.

## Tests

```sh
cd apps/ios/CrewKit && swift test     # with Xcode installed
```

Xcode is needed for `swift test` and for building CrewUI, because the Command Line
Tools alone lack SwiftUI's macro plugin.

## What's in it

- **Look:** minimal, like ChatGPT and Apple's own apps, in light and dark mode. The
  chrome is black and white, your messages sit in grey bubbles, and questions and
  approvals are grey cards. Colour comes from the agent faces and small status dots
  only.
- **Tabs** (the floating glass tab bar, which shrinks while you scroll): Inbox,
  Threads, Messages (team server only) and Team. As in Slack, icons are outlined and the
  selected one is filled.
- **Inbox:** swipe right to approve, left to deny. Long-press for "Always allow this
  tool" and "Approve all in this thread".
- **Threads:** swipe to close, a filter for Mine or All, and new threads with an agent
  picker, suggestions and photos.
- **Streamed answers:** while an agent writes, its answer comes in word by word and
  the newest words fade in (the conductor's `draft` socket messages). The finished
  message carries on from where the stream was, without a jump.
- **A thread:** the conversation, rendered natively (Markdown, "Worked 6s · 3
  steps", specialist cards you tap to step in, question cards with tap-to-answer,
  approval cards, drafts in a sheet). Under it is a glass composer with @-mention
  suggestions, photos, and Stop while an agent works. Also shows queued messages you
  can edit or take back, approvals from other agents in the thread, and who is typing.
- **Messages:** direct messages between people, with online status.

**Not built yet:**

- Push notifications, so you can approve from the lock screen. This needs APNs on
  the conductor.
- The Docs tab.
- Spend.
- Server sign-ins for connections.
- Concept boards drawn as ad mockups (they show as a list for now).
- Live Activities.
