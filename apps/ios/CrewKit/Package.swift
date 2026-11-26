// swift-tools-version: 6.2
// The Crew iPhone app's code, as a package so it builds and tests with plain
// `swift build` / `swift test` on a Mac (no simulator needed). The Xcode
// project in ../ (project.yml) is a thin app target around CrewUI.
//
// CrewKit: the wire format (packages/protocol in Swift), the conductor client,
// and the logic that turns a thread's events into what the chat shows.
// CrewUI: the app's state and its SwiftUI screens.

import PackageDescription

let package = Package(
  name: "CrewKit",
  platforms: [.iOS(.v26), .macOS(.v26)],
  products: [
    .library(name: "CrewKit", targets: ["CrewKit"]),
    .library(name: "CrewUI", targets: ["CrewUI"]),
  ],
  targets: [
    .target(name: "CrewKit"),
    .target(
      name: "CrewUI",
      dependencies: ["CrewKit"],
      swiftSettings: [.defaultIsolation(MainActor.self)]
    ),
    .testTarget(name: "CrewKitTests", dependencies: ["CrewKit"]),
  ]
)
