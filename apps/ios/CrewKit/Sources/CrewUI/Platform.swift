import SwiftUI

// The app is for iPhone. These wrap the few iOS-only APIs so the package also
// builds on a Mac (`swift build`), which is how it is checked without a simulator.

#if canImport(UIKit)
import UIKit
public typealias PlatformImage = UIImage
#else
import AppKit
public typealias PlatformImage = NSImage
#endif

extension Color {
  // Minimal, as in ChatGPT and Apple's own apps: black and white, grey surfaces.
  // Colour comes from the agent faces and small status dots, not from the chrome.

  /// Your own messages, and cards (questions, approvals, specialists): ChatGPT's greys.
  static let surface = Color.dynamic(light: 0xF4F4F4, dark: 0x2F2F2F)
  /// A raised control on a surface (an answer option).
  static let raised = Color.dynamic(light: 0xFFFFFF, dark: 0x3A3A3A)

  static func dynamic(light: UInt32, dark: UInt32) -> Color {
    #if canImport(UIKit)
    Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor(Color(hex: dark)) : UIColor(Color(hex: light)) })
    #else
    Color(nsColor: NSColor(name: nil) { $0.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor(Color(hex: dark)) : NSColor(Color(hex: light)) })
    #endif
  }

  static var crewBackground: Color {
    #if canImport(UIKit)
    Color(uiColor: .systemBackground)
    #else
    Color(nsColor: .windowBackgroundColor)
    #endif
  }

  static var crewGroupedBackground: Color {
    #if canImport(UIKit)
    Color(uiColor: .secondarySystemBackground)
    #else
    Color(nsColor: .controlBackgroundColor)
    #endif
  }
}

extension Image {
  init(platformImage: PlatformImage) {
    #if canImport(UIKit)
    self.init(uiImage: platformImage)
    #else
    self.init(nsImage: platformImage)
    #endif
  }
}

extension View {
  /// Small titles in pushed screens (a thread), large ones on the tab roots.
  func inlineTitle() -> some View {
    #if os(iOS)
    navigationBarTitleDisplayMode(.inline)
    #else
    self
    #endif
  }

  /// The glass tab bar shrinks while you scroll down a list, as in Apple's own apps.
  func minimizingTabBar() -> some View {
    #if os(iOS)
    tabBarMinimizeBehavior(.onScrollDown)
    #else
    self
    #endif
  }

  func urlKeyboard() -> some View {
    #if os(iOS)
    keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
    #else
    self
    #endif
  }

  func plainKeyboard() -> some View {
    #if os(iOS)
    textInputAutocapitalization(.never).autocorrectionDisabled()
    #else
    self
    #endif
  }

  /// The keyboard goes away when you drag the conversation, as in Messages.
  func dismissesKeyboardOnScroll() -> some View {
    #if os(iOS)
    scrollDismissesKeyboard(.interactively)
    #else
    self
    #endif
  }
}

/// Closes the keyboard: after you send a message, as in Messages and ChatGPT.
@MainActor func dismissKeyboard() {
  #if canImport(UIKit)
  UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
  #endif
}

enum Clipboard {
  static func copy(_ text: String) {
    #if canImport(UIKit)
    UIPasteboard.general.string = text
    #else
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
    #endif
  }
}

enum ImageData {
  /// JPEG for an upload, at most 2048 px on the long side: photos from the camera are huge.
  static func jpeg(_ data: Data) -> Data? {
    #if canImport(UIKit)
    guard let image = UIImage(data: data) else { return nil }
    let long = max(image.size.width, image.size.height)
    let scale = min(1, 2048 / max(long, 1))
    let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    let resized = UIGraphicsImageRenderer(size: size, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
    return resized.jpegData(compressionQuality: 0.85)
    #else
    return data
    #endif
  }
}
