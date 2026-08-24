@preconcurrency import AppKit
@preconcurrency import CoreGraphics
import Foundation
@preconcurrency import ScreenCaptureKit

enum EvidencePathResolver {
    static func resolve(root: String, destination: String) throws -> URL {
        guard !root.isEmpty,
              !destination.isEmpty,
              !destination.contains("\0"),
              !(destination as NSString).isAbsolutePath,
              !destination.split(separator: "/", omittingEmptySubsequences: false).contains(".."),
              destination.lowercased().hasSuffix(".png") else {
            throw invalidDestination()
        }

        let rootURL = URL(fileURLWithPath: root, isDirectory: true)
            .standardizedFileURL
            .resolvingSymlinksInPath()
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: rootURL.path, isDirectory: &isDirectory),
              isDirectory.boolValue else {
            throw HelperError(
                code: "EVIDENCE_ROOT_NOT_AVAILABLE",
                message: "Evidence root is not available."
            )
        }

        var destinationURL = rootURL
        for component in destination.split(separator: "/") {
            destinationURL = destinationURL
                .appendingPathComponent(String(component), isDirectory: false)
                .standardizedFileURL
                .resolvingSymlinksInPath()
            guard isDescendant(destinationURL, of: rootURL) else {
                throw invalidDestination()
            }
        }
        guard destinationURL.pathExtension.lowercased() == "png",
              isDescendant(destinationURL, of: rootURL) else {
            throw invalidDestination()
        }
        return destinationURL
    }

    static func isDescendant(_ candidate: URL, of root: URL) -> Bool {
        candidate.path.hasPrefix(root.path + "/")
    }

    private static func invalidDestination() -> HelperError {
        HelperError(code: "INVALID_DESTINATION", message: "Invalid evidence destination.")
    }
}

struct ScreenCapture {
    private let environment: [String: String]
    private let fileManager: FileManager

    init(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        fileManager: FileManager = .default
    ) {
        self.environment = environment
        self.fileManager = fileManager
    }

    func captureWindow(processIdentifier: pid_t, destination: String) throws -> JSONValue {
        guard CGPreflightScreenCaptureAccess() else {
            throw HelperError(
                code: "SCREEN_RECORDING_PERMISSION_REQUIRED",
                message: "Screen Recording permission is required."
            )
        }
        guard let root = environment["COLLECTOR_WORK_DIR"], !root.isEmpty else {
            throw HelperError(
                code: "EVIDENCE_ROOT_NOT_CONFIGURED",
                message: "Evidence root is not configured."
            )
        }

        let initialDestination = try EvidencePathResolver.resolve(root: root, destination: destination)
        guard let window = frontWindow(processIdentifier: processIdentifier) else {
            throw HelperError(
                code: "FRONT_WINDOW_NOT_AVAILABLE",
                message: "Application window is not available."
            )
        }
        let image = try captureImage(window: window)

        do {
            try fileManager.createDirectory(
                at: initialDestination.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            let verifiedDestination = try EvidencePathResolver.resolve(
                root: root,
                destination: destination
            )
            guard verifiedDestination == initialDestination else {
                throw HelperError(code: "INVALID_DESTINATION", message: "Invalid evidence destination.")
            }

            let representation = NSBitmapImageRep(cgImage: image)
            guard let png = representation.representation(using: .png, properties: [:]) else {
                throw HelperError(code: "SCREEN_CAPTURE_FAILED", message: "Screen capture failed.")
            }
            try png.write(to: verifiedDestination, options: .atomic)
        } catch let error as HelperError {
            throw error
        } catch {
            throw HelperError(code: "SCREEN_CAPTURE_FAILED", message: "Screen capture failed.")
        }

        return .object(["written": .boolean(true)])
    }

    private func frontWindow(processIdentifier: pid_t) -> WindowDescriptor? {
        let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        guard let windows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
            return nil
        }

        for window in windows {
            guard (window[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == processIdentifier,
                  (window[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
                  let identifier = (window[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
                  let boundsDictionary = window[kCGWindowBounds as String] as? [String: Any],
                  let bounds = CGRect(dictionaryRepresentation: boundsDictionary as CFDictionary),
                  bounds.width > 0,
                  bounds.height > 0 else {
                continue
            }
            return WindowDescriptor(identifier: CGWindowID(identifier))
        }
        return nil
    }

    private func captureImage(window: WindowDescriptor) throws -> CGImage {
        guard #available(macOS 14.0, *) else {
            throw HelperError(
                code: "SCREEN_CAPTURE_UNAVAILABLE",
                message: "Screen capture is unavailable on this macOS version."
            )
        }
        return try captureImageWithScreenCaptureKit(window: window)
    }

    @available(macOS 14.0, *)
    private func captureImageWithScreenCaptureKit(window: WindowDescriptor) throws -> CGImage {
        let semaphore = DispatchSemaphore(value: 0)
        let capturedImage = CapturedImageBox()

        SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: true) { content, _ in
            guard let shareableWindow = content?.windows.first(where: {
                $0.windowID == window.identifier
            }) else {
                semaphore.signal()
                return
            }

            let configuration = SCStreamConfiguration()
            configuration.width = max(1, Int(shareableWindow.frame.width * 2))
            configuration.height = max(1, Int(shareableWindow.frame.height * 2))
            configuration.showsCursor = false
            let filter = SCContentFilter(desktopIndependentWindow: shareableWindow)

            SCScreenshotManager.captureImage(
                contentFilter: filter,
                configuration: configuration
            ) { image, _ in
                capturedImage.store(image)
                semaphore.signal()
            }
        }

        guard semaphore.wait(timeout: .now() + 10) == .success,
              let image = capturedImage.load() else {
            throw captureFailed()
        }
        return image
    }

    private func captureFailed() -> HelperError {
        HelperError(code: "SCREEN_CAPTURE_FAILED", message: "Screen capture failed.")
    }
}

private struct WindowDescriptor {
    let identifier: CGWindowID
}

private final class CapturedImageBox: @unchecked Sendable {
    private let lock = NSLock()
    private var image: CGImage?

    func store(_ image: CGImage?) {
        lock.lock()
        self.image = image
        lock.unlock()
    }

    func load() -> CGImage? {
        lock.lock()
        defer { lock.unlock() }
        return image
    }
}
