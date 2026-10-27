import AppKit

let image = NSImage(size: NSSize(width: 1024, height: 1024))
image.lockFocus()
NSColor(white: 0.96, alpha: 1).setFill()
NSBezierPath(roundedRect: NSRect(x: 72, y: 72, width: 880, height: 880), xRadius: 195, yRadius: 195).fill()
NSColor(white: 0.09, alpha: 1).setStroke()
let arrow = NSBezierPath()
arrow.lineWidth = 48
arrow.lineCapStyle = .round
arrow.lineJoinStyle = .round
arrow.move(to: NSPoint(x: 300, y: 512))
arrow.line(to: NSPoint(x: 724, y: 512))
arrow.move(to: NSPoint(x: 580, y: 657))
arrow.line(to: NSPoint(x: 724, y: 512))
arrow.line(to: NSPoint(x: 580, y: 367))
arrow.move(to: NSPoint(x: 330, y: 310))
arrow.line(to: NSPoint(x: 694, y: 310))
arrow.stroke()
image.unlockFocus()
let bitmap = NSBitmapImageRep(data: image.tiffRepresentation!)!
try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
