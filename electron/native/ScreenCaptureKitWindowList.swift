import AppKit
import ApplicationServices
import Foundation
import CoreGraphics
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

struct WindowListEntry: Codable {
	let id: String
	let name: String
	let display_id: String
	let appName: String?
	let windowTitle: String?
	let bundleId: String?
	/// The owning app's bundle path, so Electron can show its icon for windows
	/// that have no thumbnail (a full-screen app on another Space).
	let appPath: String?
	/// A JPEG data URL preview, present only when `--thumbnails` is passed.
	var thumbnail: String?
	let x: Double
	let y: Double
	let width: Double
	let height: Double
}

func normalize(_ value: String?) -> String? {
	guard let rawValue = value?.trimmingCharacters(in: .whitespacesAndNewlines), !rawValue.isEmpty else {
		return nil
	}

	return rawValue
}

/// Optional arguments:
///   --thumbnails WxH   attach a JPEG preview of each window, at most W x H px
///   --ids a,b,c        list only these window ids (used for recording previews)
///   --focus a,b,c      bring these windows on screen (switching desktops if
///                      needed), print which ones made it, and exit
struct Options {
	var thumbnailSize: CGSize?
	var onlyIds: Set<UInt32>?
	var focusIds: [UInt32]?
}

func parseOptions(_ args: [String]) -> Options {
	var options = Options()
	var index = 1
	while index < args.count {
		let arg = args[index]
		let value = index + 1 < args.count ? args[index + 1] : nil
		if arg == "--thumbnails", let value {
			let parts = value.lowercased().split(separator: "x").compactMap { Double($0) }
			if parts.count == 2, parts[0] > 0, parts[1] > 0 {
				options.thumbnailSize = CGSize(width: parts[0], height: parts[1])
			}
			index += 2
		} else if arg == "--ids", let value {
			options.onlyIds = Set(value.split(separator: ",").compactMap { UInt32($0) })
			index += 2
		} else if arg == "--focus", let value {
			options.focusIds = value.split(separator: ",").compactMap { UInt32($0) }
			index += 2
		} else {
			index += 1
		}
	}
	return options
}

let options = parseOptions(CommandLine.arguments)

/// Collects previews from concurrent captures.
actor ThumbnailStore {
	private(set) var previews: [UInt32: String] = [:]
	private(set) var finished = 0

	func record(_ id: UInt32, _ preview: String?) {
		if let preview { previews[id] = preview }
		finished += 1
	}
}

/// The pre-ScreenCaptureKit window snapshot. ScreenCaptureKit refuses windows
/// that are not on screen (minimized, or on another desktop or full-screen
/// Space), but the window server still holds their last frame, which this
/// returns. Looked up at runtime because newer SDKs no longer declare it.
private typealias LegacyWindowImageFn = @convention(c) (CGRect, UInt32, UInt32, UInt32) -> Unmanaged<CGImage>?
private let legacyWindowImage: LegacyWindowImageFn? = {
	guard let handle = dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", RTLD_NOW),
	      let symbol = dlsym(handle, "CGWindowListCreateImage") else { return nil }
	return unsafeBitCast(symbol, to: LegacyWindowImageFn.self)
}()

private func legacySnapshot(of windowId: CGWindowID) -> CGImage? {
	// kCGWindowListOptionIncludingWindow, with
	// kCGWindowImageBoundsIgnoreFraming | kCGWindowImageNominalResolution.
	legacyWindowImage?(.null, 1 << 3, windowId, (1 << 0) | (1 << 4))?.takeRetainedValue()
}

private func scaled(_ image: CGImage, fitting size: CGSize) -> CGImage? {
	let scale = min(size.width / CGFloat(image.width), size.height / CGFloat(image.height), 1)
	let width = max(2, Int((CGFloat(image.width) * scale).rounded()))
	let height = max(2, Int((CGFloat(image.height) * scale).rounded()))
	guard let context = CGContext(
		data: nil,
		width: width,
		height: height,
		bitsPerComponent: 8,
		bytesPerRow: 0,
		space: CGColorSpaceCreateDeviceRGB(),
		bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
	) else { return nil }
	context.interpolationQuality = .high
	context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
	return context.makeImage()
}

private func jpegDataURL(_ image: CGImage) -> String? {
	let data = NSMutableData()
	guard let destination = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else {
		return nil
	}
	CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.72] as CFDictionary)
	guard CGImageDestinationFinalize(destination) else { return nil }
	return "data:image/jpeg;base64,\((data as Data).base64EncodedString())"
}

/// A preview of one window from the window server's own copy. Works for
/// covered windows, minimized ones and windows on other desktops. Synchronous,
/// so it runs on the main thread after the async listing has finished.
func legacyPreview(of windowId: CGWindowID, fitting size: CGSize) -> String? {
	guard let snapshot = legacySnapshot(of: windowId), snapshot.width > 1, snapshot.height > 1,
	      let image = scaled(snapshot, fitting: size) else { return nil }
	return jpegDataURL(image)
}

/// ScreenCaptureKit preview, used only if the legacy snapshot ever goes away.
/// It can only see windows that are on screen.
func capturePreview(of window: SCWindow, fitting size: CGSize) async -> String? {
	guard window.isOnScreen, window.frame.width > 0, window.frame.height > 0 else { return nil }
	let scale = min(size.width / window.frame.width, size.height / window.frame.height, 2)
	let configuration = SCStreamConfiguration()
	configuration.width = max(2, Int((window.frame.width * scale).rounded()))
	configuration.height = max(2, Int((window.frame.height * scale).rounded()))
	configuration.showsCursor = false
	configuration.ignoreShadowsSingleWindow = true
	guard let image = try? await SCScreenshotManager.captureImage(
		contentFilter: SCContentFilter(desktopIndependentWindow: window),
		configuration: configuration
	) else { return nil }
	return jpegDataURL(image)
}

// MARK: - Bringing windows on screen

private func windowInfo(_ id: CGWindowID) -> [String: Any]? {
	(CGWindowListCopyWindowInfo([.optionIncludingWindow], id) as? [[String: Any]])?.first
}

private func isWindowOnScreen(_ id: CGWindowID) -> Bool {
	windowInfo(id)?[kCGWindowIsOnscreen as String] as? Bool ?? false
}

/// Maps an Accessibility window to its window number. Private but long-lived
/// (window managers rely on it), so it is looked up at runtime.
private typealias AXGetWindowFn = @convention(c) (AXUIElement, UnsafeMutablePointer<CGWindowID>) -> AXError
private let axGetWindow: AXGetWindowFn? = {
	guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "_AXUIElementGetWindow") else { return nil }
	return unsafeBitCast(symbol, to: AXGetWindowFn.self)
}()

/// Un-minimizes and raises the window when Accessibility can reach it. That is
/// only possible on the current desktop; for other desktops, activating the
/// app is what brings it over.
private func raiseWithAccessibility(windowId: CGWindowID, pid: pid_t, title: String?) {
	guard AXIsProcessTrusted() else { return }
	let app = AXUIElementCreateApplication(pid)
	var value: CFTypeRef?
	guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &value) == .success,
	      let windows = value as? [AXUIElement] else { return }

	let match = windows.first { element in
		var number: CGWindowID = 0
		if let axGetWindow, axGetWindow(element, &number) == .success { return number == windowId }
		var titleValue: CFTypeRef?
		AXUIElementCopyAttributeValue(element, kAXTitleAttribute as CFString, &titleValue)
		return title != nil && (titleValue as? String) == title
	}
	guard let window = match else { return }
	AXUIElementSetAttributeValue(window, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
	AXUIElementPerformAction(window, kAXRaiseAction as CFString)
	AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
}

/// Zoom-style: sharing a window that is minimized, hidden, or on another
/// desktop brings it forward first, because macOS can only record what is on
/// screen. Windows that are already visible are left exactly where they are.
func focusWindows(_ ids: [CGWindowID]) -> [String: [UInt32]] {
	for id in ids where !isWindowOnScreen(id) {
		guard let info = windowInfo(id), let pid = info[kCGWindowOwnerPID as String] as? pid_t,
		      let app = NSRunningApplication(processIdentifier: pid) else { continue }
		let title = info[kCGWindowName as String] as? String
		if app.isHidden { app.unhide() }
		raiseWithAccessibility(windowId: id, pid: pid, title: title)
		app.activate(options: [])

		let deadline = Date().addingTimeInterval(1.5)
		while !isWindowOnScreen(id), Date() < deadline {
			usleep(50_000)
		}
		// Activation can land on the app's other window; now that its desktop
		// is showing, raising the chosen one usually works.
		if !isWindowOnScreen(id) {
			raiseWithAccessibility(windowId: id, pid: pid, title: title)
			let retry = Date().addingTimeInterval(0.6)
			while !isWindowOnScreen(id), Date() < retry {
				usleep(50_000)
			}
		}
	}
	let onScreen = ids.filter(isWindowOnScreen)
	return ["onScreen": onScreen, "offScreen": ids.filter { !onScreen.contains($0) }]
}

let excludedBundleIds: Set<String> = [
	"com.apple.controlcenter",
	"com.apple.dock",
	"com.apple.WindowManager",
	"com.apple.wallpaper.agent",
]

let excludedWindowTitles: Set<String> = [
	"Display 1 Backstop",
	"Event Shield Window",
	"Menubar",
	"Offscreen Wallpaper Window",
	"Wallpaper-",
]

if let focusIds = options.focusIds {
	let result = focusWindows(focusIds)
	let data = (try? JSONEncoder().encode(result)) ?? Data("{}".utf8)
	FileHandle.standardOutput.write(data)
	exit(0)
}

// Force CoreGraphics Services initialization before asking ScreenCaptureKit for
// shareable content. Without this, the helper can stall sporadically when run
// as a standalone CLI process from Electron.
let _ = CGMainDisplayID()

/// Window details straight from the window server, without ScreenCaptureKit.
/// Used when the caller already knows which windows it wants (tracking a
/// recorded window, or the recording preview), so it never competes with the
/// recorder's own ScreenCaptureKit requests.
func windowServerEntries(for ids: Set<UInt32>) -> [WindowListEntry] {
	ids.sorted().compactMap { id -> WindowListEntry? in
		guard let info = windowInfo(CGWindowID(id)),
		      let boundsDictionary = info[kCGWindowBounds as String] as? NSDictionary,
		      let frame = CGRect(dictionaryRepresentation: boundsDictionary) else { return nil }
		let running = (info[kCGWindowOwnerPID as String] as? pid_t).flatMap {
			NSRunningApplication(processIdentifier: $0)
		}
		let appName = normalize(info[kCGWindowOwnerName as String] as? String) ?? normalize(running?.localizedName)
		let windowTitle = normalize(info[kCGWindowName as String] as? String)

		var displayId: CGDirectDisplayID = 0
		var displayCount: UInt32 = 0
		CGGetDisplaysWithPoint(CGPoint(x: frame.midX, y: frame.midY), 1, &displayId, &displayCount)
		if displayCount == 0 {
			CGGetDisplaysWithRect(frame, 1, &displayId, &displayCount)
		}

		let resolvedTitle = windowTitle ?? appName ?? "Window"
		let name: String
		if let appName, let windowTitle {
			name = "\(appName) — \(windowTitle)"
		} else {
			name = resolvedTitle
		}
		return WindowListEntry(
			id: "window:\(id):0",
			name: name,
			display_id: displayCount > 0 ? String(displayId) : "",
			appName: appName,
			windowTitle: resolvedTitle,
			bundleId: normalize(running?.bundleIdentifier),
			appPath: running?.bundleURL?.path,
			x: Double(frame.origin.x),
			y: Double(frame.origin.y),
			width: Double(frame.width),
			height: Double(frame.height)
		)
	}
}

func writeAndExit(_ entries: [WindowListEntry]) -> Never {
	let encoder = JSONEncoder()
	encoder.outputFormatting = [.sortedKeys]
	if let data = try? encoder.encode(entries) {
		FileHandle.standardOutput.write(data)
		exit(0)
	}
	fputs("Error encoding the window list\n", stderr)
	exit(1)
}

if let onlyIds = options.onlyIds, options.thumbnailSize == nil || legacyWindowImage != nil {
	var entries = windowServerEntries(for: onlyIds)
	if let size = options.thumbnailSize {
		entries = entries.map { entry in
			var copy = entry
			if let id = UInt32(entry.id.split(separator: ":").dropFirst().first ?? "") {
				copy.thumbnail = legacyPreview(of: id, fitting: size)
			}
			return copy
		}
	}
	writeAndExit(entries)
}

// Never linger. A stuck ScreenCaptureKit request must not leave this helper
// running after Electron has given up on it.
DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 12) {
	fputs("Window listing timed out\n", stderr)
	fflush(stderr)
	exit(3)
}

/// The listing produced by the async task, handed back to the main thread.
final class ListingResult: @unchecked Sendable {
	var entries: [WindowListEntry] = []
}
let listing = ListingResult()

let group = DispatchGroup()
group.enter()

Task {
	do {
		// Ask for every window, not just the ones macOS reports as "on screen".
		// SCWindow.isOnScreen is occlusion-sensitive: a maximized window (or
		// Recordly's own full-screen HUD overlay) marks everything behind it on
		// that display as off-screen, which emptied the window picker for the
		// display the user was actually working on.
		let shareableContent = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)

		struct RawWindowEntry {
			let entry: WindowListEntry
			let hasRawTitle: Bool
			let bundleId: String?
			let isOnScreen: Bool
		}

		let rawEntries = shareableContent.windows.compactMap { window -> RawWindowEntry? in
			let appName = normalize(window.owningApplication?.applicationName)
			let windowTitle = normalize(window.title)
			let bundleId = normalize(window.owningApplication?.bundleIdentifier)
			let frame = window.frame

			guard window.windowLayer == 0 else {
				return nil
			}

			guard frame.width >= 50, frame.height >= 50 else {
				return nil
			}

			guard appName != nil || windowTitle != nil else {
				return nil
			}

			// Enumerating every window also surfaces helper, XPC and placeholder
			// windows that are never on screen and carry no title. A real window
			// is either visible right now or has a title the user can recognize.
			guard window.isOnScreen || windowTitle != nil else {
				return nil
			}

			if let bundleId, excludedBundleIds.contains(bundleId) {
				return nil
			}

			// Background agents and menu bar utilities (login items, status
			// popovers) own hidden windows that cannot be recorded. List only
			// windows of regular apps, the ones with a Dock icon, as Zoom does.
			if let pid = window.owningApplication?.processID,
			   let running = NSRunningApplication(processIdentifier: pid),
			   running.activationPolicy != .regular {
				return nil
			}

			if let onlyIds = options.onlyIds, !onlyIds.contains(window.windowID) {
				return nil
			}

			if let windowTitle, excludedWindowTitles.contains(windowTitle) {
				return nil
			}

			let matchedDisplay = shareableContent.displays.first(where: { display in
				display.frame.intersects(frame) || display.frame.contains(CGPoint(x: frame.midX, y: frame.midY))
			})

			let resolvedWindowTitle = windowTitle ?? appName ?? "Window"
			let resolvedName: String
			if let appName, let windowTitle {
				resolvedName = "\(appName) — \(windowTitle)"
			} else {
				resolvedName = resolvedWindowTitle
			}

			let entry = WindowListEntry(
				id: "window:\(window.windowID):0",
				name: resolvedName,
				display_id: matchedDisplay.map { String($0.displayID) } ?? "",
				appName: appName,
				windowTitle: resolvedWindowTitle,
				bundleId: bundleId,
				appPath: window.owningApplication.flatMap {
					NSRunningApplication(processIdentifier: $0.processID)?.bundleURL?.path
				},
				x: Double(frame.origin.x),
				y: Double(frame.origin.y),
				width: Double(frame.width),
				height: Double(frame.height)
			)

			return RawWindowEntry(entry: entry, hasRawTitle: windowTitle != nil, bundleId: bundleId, isOnScreen: window.isOnScreen)
		}

		// For apps with multiple windows, drop auxiliary windows that lack a
		// distinct title (e.g. Arc's sidebar/tab-bar chrome). If ALL windows
		// from an app lack titles, keep them all.
		var titledCountByBundle: [String: Int] = [:]
		for raw in rawEntries {
			if let bid = raw.bundleId, raw.hasRawTitle {
				titledCountByBundle[bid, default: 0] += 1
			}
		}

		let entries = rawEntries
			.filter { raw in
				guard let bid = raw.bundleId else { return raw.hasRawTitle || raw.isOnScreen }
				if let titled = titledCountByBundle[bid], titled > 0 {
					return raw.hasRawTitle
				}
				return raw.hasRawTitle || raw.isOnScreen
			}
			.map { $0.entry }
		.sorted { lhs, rhs in
			let lhsApp = lhs.appName ?? lhs.name
			let rhsApp = rhs.appName ?? rhs.name
			if lhsApp != rhsApp {
				return lhsApp.localizedCaseInsensitiveCompare(rhsApp) == .orderedAscending
			}

			return (lhs.windowTitle ?? lhs.name).localizedCaseInsensitiveCompare(rhs.windowTitle ?? rhs.name) == .orderedAscending
		}

		var output = entries
		if let size = options.thumbnailSize, legacyWindowImage == nil {
			// Capture concurrently, but never let one stubborn window hold up the
			// picker: whatever has finished after three seconds is used.
			let windowsById = Dictionary(
				shareableContent.windows.map { ($0.windowID, $0) },
				uniquingKeysWith: { first, _ in first }
			)
			let wanted = output.compactMap { entry -> SCWindow? in
				guard let id = UInt32(entry.id.split(separator: ":").dropFirst().first ?? "") else { return nil }
				return windowsById[id]
			}
			let store = ThumbnailStore()
			for window in wanted {
				Task.detached {
					await store.record(window.windowID, await capturePreview(of: window, fitting: size))
				}
			}
			let deadline = Date().addingTimeInterval(3)
			while await store.finished < wanted.count, Date() < deadline {
				try? await Task.sleep(nanoseconds: 40_000_000)
			}
			let previews = await store.previews
			output = output.map { entry in
				var copy = entry
				if let id = UInt32(entry.id.split(separator: ":").dropFirst().first ?? "") {
					copy.thumbnail = previews[id]
				}
				return copy
			}
		}

		listing.entries = output
	} catch {
		fputs("Error listing windows: \(error.localizedDescription)\n", stderr)
		fflush(stderr)
		exit(1)
	}

	group.leave()
}

group.wait()

var output = listing.entries
if let size = options.thumbnailSize, legacyWindowImage != nil {
	// One at a time on the main thread: quick (a few milliseconds each) and
	// safe when several helpers run at once. Stop adding previews after three
	// seconds so the picker never waits on a slow window.
	let deadline = Date().addingTimeInterval(3)
	output = output.map { entry in
		var copy = entry
		if Date() < deadline, let id = UInt32(entry.id.split(separator: ":").dropFirst().first ?? "") {
			copy.thumbnail = legacyPreview(of: id, fitting: size)
		}
		return copy
	}
}

writeAndExit(output)
