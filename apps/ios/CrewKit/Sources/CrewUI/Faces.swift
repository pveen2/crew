import SwiftUI
import CrewKit

// Agent faces (crew-icons), as in packages/ui/src/Face.tsx: a bold colour disc,
// a black ring and one mouth line. The mouth is the agent's identity.

private let mouths: [String: String] = [
  "gm": "M66 42 A 19 19 0 0 1 43 66",
  "developer": "M40 58 L 60 58",
  "store-manager": "M36 54 Q 50 69 64 54",
  "data-analyst": "M36 61 L 44 53 L 52 59 L 64 46",
  "paid-media": "circle 50 58 7",
  "creative-strategist": "M36 58 Q 43 51 50 58 T 64 58",
  "creative-producer": "M40 60 Q 53 65 63 51",
  "brand-reviewer": "M38 58 L 62 55",
  "email-and-retention": "M43 56 Q 50 64 57 56",
  "customer-care": "M37 50 Q 50 74 63 50",
  "social-and-community": "M38 52 L 62 52 Q 62 69 50 69 Q 38 69 38 52 Z",
  "finance-and-operations": "M45 58 Q 50 62 55 58",
  "seo-and-geo": "M34 42 A 19 19 0 0 0 57 66",
  "dj": "M37 54 Q 43 65 50 56 Q 57 65 63 54",
  "copywriter": "M37 58 L 45 58 M 55 58 L 63 58",
  "designer": "M36 55 L 43 61 L 50 55 L 57 61 L 64 55",
  "web-researcher": "dots",
  "neutral": "M44 58 L 56 58",
]

private let aliases: [String: String] = [
  "paid-media-manager": "paid-media", "seo": "seo-and-geo", "seo-geo": "seo-and-geo",
  "email-retention": "email-and-retention", "social-community": "social-and-community",
  "finance-operations": "finance-and-operations", "finance-ops": "finance-and-operations",
  "copy-writer": "copywriter", "web-research": "web-researcher", "researcher": "web-researcher",
]

private let discs: [String: UInt32] = [
  "gm": 0xf0531f, "developer": 0x2f5bea, "store-manager": 0x1fae5b, "data-analyst": 0xf7c31c,
  "paid-media": 0x23a8f0, "creative-strategist": 0xf2408c, "creative-producer": 0x9acd2a,
  "brand-reviewer": 0xe0262e, "email-and-retention": 0xff85b3, "customer-care": 0x10b0a3,
  "social-and-community": 0xd94fd3, "finance-and-operations": 0xc07f2c, "seo-and-geo": 0x138a4e,
  "dj": 0x8b4cf0, "copywriter": 0xff9a1f, "designer": 0x7c8cff, "web-researcher": 0x7edcc0, "neutral": 0x8f8f8f,
]

extension Color {
  init(hex: UInt32) {
    self.init(red: Double((hex >> 16) & 0xff) / 255, green: Double((hex >> 8) & 0xff) / 255, blue: Double(hex & 0xff) / 255)
  }
}

func faceKey(_ role: String) -> String {
  let k = aliases[role] ?? role
  return mouths[k] == nil ? "neutral" : k
}

func faceColor(_ role: String) -> Color { Color(hex: discs[faceKey(role)] ?? 0x8f8f8f) }

/// A mouth in the faces' 100×100 box.
nonisolated struct MouthShape: Shape {
  var spec: String

  func path(in rect: CGRect) -> Path {
    let s = rect.width / 100
    var p = Path()
    if spec == "dots" {
      for x in [39.0, 50, 61] { p.addEllipse(in: CGRect(x: (x - 1) * s, y: 57 * s, width: 2 * s, height: 2 * s)) }
      return p
    }
    if spec.hasPrefix("circle") {
      let n = spec.split(separator: " ").dropFirst().compactMap { Double($0) }
      p.addEllipse(in: CGRect(x: (n[0] - n[2]) * s, y: (n[1] - n[2]) * s, width: 2 * n[2] * s, height: 2 * n[2] * s))
      return p
    }
    return SVGPath.parse(spec, scale: s)
  }
}

/// Enough of SVG path syntax for the faces: M L Q T A Z, absolute coordinates.
nonisolated enum SVGPath {
  static func parse(_ d: String, scale s: CGFloat) -> Path {
    var p = Path()
    // Commands and numbers, also when glued together ("M66 42").
    var tokens = d.matches(of: /[A-Za-z]|-?\d*\.?\d+/).map { String($0.output) }[...]
    var cmd = "M"
    var current = CGPoint.zero
    var lastControl: CGPoint?
    func num() -> CGFloat { CGFloat(Double(tokens.popFirst() ?? "0") ?? 0) }
    func pt() -> CGPoint { let x = num(); let y = num(); return CGPoint(x: x, y: y) }
    func sc(_ q: CGPoint) -> CGPoint { CGPoint(x: q.x * s, y: q.y * s) }
    while let t = tokens.first {
      if t.first?.isLetter == true { cmd = t; tokens.removeFirst() }
      switch cmd {
      case "M":
        current = pt(); p.move(to: sc(current)); lastControl = nil; cmd = "L"
      case "L":
        current = pt(); p.addLine(to: sc(current)); lastControl = nil
      case "Q":
        let c = pt(); let e = pt()
        p.addQuadCurve(to: sc(e), control: sc(c)); lastControl = c; current = e
      case "T":
        let c = lastControl.map { CGPoint(x: 2 * current.x - $0.x, y: 2 * current.y - $0.y) } ?? current
        let e = pt()
        p.addQuadCurve(to: sc(e), control: sc(c)); lastControl = c; current = e
      case "A":
        let rx = num(); _ = num(); _ = num()
        let large = num() != 0; let sweep = num() != 0
        let e = pt()
        arc(&p, from: current, to: e, r: rx, large: large, sweep: sweep, scale: s)
        current = e; lastControl = nil
      case "Z":
        p.closeSubpath(); cmd = "M"
        if tokens.first?.first?.isLetter == false { continue }
      default:
        tokens.removeFirst()
      }
    }
    return p
  }

  /// An SVG arc (circular), converted from end points to a centre.
  private static func arc(_ p: inout Path, from a: CGPoint, to b: CGPoint, r: CGFloat, large: Bool, sweep: Bool, scale s: CGFloat) {
    let mid = CGPoint(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2)
    let dx = b.x - a.x, dy = b.y - a.y
    let half = hypot(dx, dy) / 2
    let radius = max(r, half)
    let h = sqrt(max(0, radius * radius - half * half))
    // Unit normal to the chord; the centre sits on one side or the other.
    let nx = -dy / (2 * half), ny = dx / (2 * half)
    let sign: CGFloat = (large != sweep) ? 1 : -1
    let c = CGPoint(x: mid.x + sign * h * nx, y: mid.y + sign * h * ny)
    let start = atan2(a.y - c.y, a.x - c.x)
    let end = atan2(b.y - c.y, b.x - c.x)
    // SVG's sweep=1 is clockwise on screen (y down), which is Path's clockwise: false.
    p.addArc(center: CGPoint(x: c.x * s, y: c.y * s), radius: radius * s, startAngle: .radians(start), endAngle: .radians(end), clockwise: !sweep)
  }
}

struct RoleFace: View {
  @Environment(AppModel.self) private var model
  var role: String
  var size: CGFloat = 26

  var body: some View {
    let ink = Color(hex: 0x151515)
    let line = size <= 32 ? 7.5 : 6.0
    ZStack {
      Circle().fill(faceColor(role))
      Circle()
        .inset(by: 17 * size / 100)
        .stroke(ink, lineWidth: line * size / 100)
      MouthShape(spec: mouths[faceKey(role)] ?? "")
        .stroke(ink, style: StrokeStyle(lineWidth: line * size / 100, lineCap: .round, lineJoin: .round))
    }
    .frame(width: size, height: size)
    .accessibilityLabel(model.label(role))
  }
}

private let personColors: [UInt32] = [0x3b6cf6, 0xe0538f, 0x16a37f, 0xd97706, 0x8b5cf6, 0x0e9fb8, 0xdc4c3f, 0x5b7c99]

/// A colleague: a round face with their initial, coloured by email (as in the Mac app).
struct PersonFace: View {
  @Environment(AppModel.self) private var model
  var email: String
  var size: CGFloat = 26
  /// A green dot while they have Crew open.
  var showOnline = false

  var body: some View {
    // FNV-1a over the UTF-16 code units, like the Mac app, so colours match.
    var h: UInt32 = 2166136261
    for c in email.utf16 { h = (h ^ UInt32(c)) &* 16777619 }
    let name = model.personName(email)
    return Circle()
      .fill(Color(hex: personColors[Int(h % UInt32(personColors.count))]))
      .overlay(Text(name.prefix(1).uppercased()).font(.system(size: size * 0.5, weight: .semibold)).foregroundStyle(.white))
      .frame(width: size, height: size)
      .overlay(alignment: .bottomTrailing) {
        if showOnline && model.online.contains(email) {
          Circle().fill(.green).frame(width: size * 0.32, height: size * 0.32)
            .overlay(Circle().stroke(Color.crewBackground, lineWidth: 1.5))
        }
      }
      .accessibilityLabel(name)
  }
}

/// Overlapping faces: the agents in a thread.
struct RoleFaces: View {
  var roles: [String]
  var size: CGFloat = 20
  var max = 3

  var body: some View {
    HStack(spacing: -size * 0.3) {
      ForEach(Array(roles.prefix(max)), id: \.self) { r in
        RoleFace(role: r, size: size)
          .overlay(Circle().stroke(Color.crewBackground, lineWidth: 1.5))
      }
    }
  }
}
