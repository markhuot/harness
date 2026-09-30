// Clip a full-bleed square icon into the macOS app icon tile: an 824px squircle centred on a
// transparent 1024px canvas (Apple's macOS icon grid). Usage: swift icon-mask.swift <in.png> <out.png>
import AppKit

let args = CommandLine.arguments
guard args.count == 3, let source = NSImage(contentsOfFile: args[1]),
      let art = source.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  FileHandle.standardError.write("usage: icon-mask.swift <in.png> <out.png>\n".data(using: .utf8)!)
  exit(1)
}

let canvas = 1024.0, tile = 824.0, inset = (canvas - tile) / 2
guard let ctx = CGContext(data: nil, width: Int(canvas), height: Int(canvas), bitsPerComponent: 8, bytesPerRow: 0,
                          space: CGColorSpace(name: CGColorSpace.sRGB)!,
                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { exit(1) }
ctx.clear(CGRect(x: 0, y: 0, width: canvas, height: canvas))

// Apple's macOS grid rounds the 824px tile with a ~185px corner radius.
let radius = 185.4
ctx.addPath(CGPath(roundedRect: CGRect(x: inset, y: inset, width: tile, height: tile),
                   cornerWidth: radius, cornerHeight: radius, transform: nil))
ctx.clip()
ctx.interpolationQuality = .high
ctx.draw(art, in: CGRect(x: inset, y: inset, width: tile, height: tile))

guard let out = ctx.makeImage(),
      let png = NSBitmapImageRep(cgImage: out).representation(using: .png, properties: [:]) else { exit(1) }
try png.write(to: URL(fileURLWithPath: args[2]))
