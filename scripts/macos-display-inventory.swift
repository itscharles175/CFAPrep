import AppKit
import Foundation

struct Rect: Encodable {
    let x: Int
    let y: Int
    let width: Int
    let height: Int
}

struct Display: Encodable {
    let index: Int
    let primary: Bool
    let bounds: Rect
    let work_area: Rect
    let scale_factor: Double
}

let screens = NSScreen.screens
guard let primary = screens.first else {
    FileHandle.standardOutput.write(Data("[]\n".utf8))
    exit(0)
}

let desktopTop = primary.frame.maxY
func chromiumRect(_ rect: NSRect) -> Rect {
    Rect(
        x: Int(rect.origin.x.rounded()),
        y: Int((desktopTop - rect.maxY).rounded()),
        width: Int(rect.width.rounded()),
        height: Int(rect.height.rounded())
    )
}

let inventory = screens.enumerated().map { index, screen in
    Display(
        index: index,
        primary: index == 0,
        bounds: chromiumRect(screen.frame),
        work_area: chromiumRect(screen.visibleFrame),
        scale_factor: screen.backingScaleFactor
    )
}

let encoder = JSONEncoder()
encoder.outputFormatting = [.sortedKeys]
let data = try encoder.encode(inventory)
FileHandle.standardOutput.write(data)
FileHandle.standardOutput.write(Data("\n".utf8))
