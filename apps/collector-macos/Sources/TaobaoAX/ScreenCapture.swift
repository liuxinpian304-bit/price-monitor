@preconcurrency import AppKit
@preconcurrency import CoreGraphics
@preconcurrency import CoreImage
@preconcurrency import CoreMedia
@preconcurrency import CoreVideo
import Darwin
import Foundation
@preconcurrency import ScreenCaptureKit

enum ScreenshotCaptureBackend: Equatable {
    case coreGraphics
    case screenCaptureKitStream
    case screenshotManager
}

enum ScreenshotCaptureRouting {
    static func backend(for version: OperatingSystemVersion) -> ScreenshotCaptureBackend {
        if version.majorVersion >= 14 {
            return .screenshotManager
        }
        if version.majorVersion >= 13
            || (version.majorVersion == 12 && version.minorVersion >= 3) {
            return .screenCaptureKitStream
        }
        return .coreGraphics
    }
}

private struct EvidenceDestination {
    let filename: String

    init(_ destination: String) throws {
        guard !destination.isEmpty,
              !destination.contains("\0"),
              !destination.contains("/"),
              !destination.contains("\\"),
              destination != ".",
              destination != "..",
              destination.lowercased().hasSuffix(".png") else {
            throw Self.invalidDestination()
        }

        self.filename = destination
    }

    static func invalidDestination() -> HelperError {
        HelperError(code: "INVALID_DESTINATION", message: "Invalid evidence destination.")
    }
}

struct EvidenceFileWriter {
    private let afterRootOpened: () throws -> Void

    init(afterRootOpened: @escaping () throws -> Void = {}) {
        self.afterRootOpened = afterRootOpened
    }

    func write(_ data: Data, root: String, destination: String) throws {
        let destination = try EvidenceDestination(destination)
        guard !root.isEmpty, !root.contains("\0") else {
            throw rootUnavailable()
        }
        let canonicalRoot = try canonicalRootPath(root)
        let rootDescriptor = try openCanonicalRoot(canonicalRoot)
        defer { close(rootDescriptor) }
        do {
            try afterRootOpened()
        } catch {
            throw HelperError(code: "EVIDENCE_WRITE_FAILED", message: "Evidence could not be written.")
        }
        try writeAtomically(data, filename: destination.filename, rootDescriptor: rootDescriptor)
    }

    private func canonicalRootPath(_ path: String) throws -> String {
        guard let resolved = path.withCString({ realpath($0, nil) }) else {
            throw rootUnavailable()
        }
        defer { free(resolved) }
        return String(cString: resolved)
    }

    private func openCanonicalRoot(_ path: String) throws -> Int32 {
        guard (path as NSString).isAbsolutePath else { throw rootUnavailable() }
        let components = path.split(separator: "/").map(String.init)
        let flags = O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
        let filesystemRoot = open("/", flags)
        guard filesystemRoot >= 0 else { throw rootUnavailable() }

        var current = filesystemRoot
        for component in components {
            let next = component.withCString { openat(current, $0, flags) }
            guard next >= 0 else {
                close(current)
                throw rootUnavailable()
            }
            close(current)
            current = next
        }
        return current
    }

    private func writeAtomically(_ data: Data, filename: String, rootDescriptor: Int32) throws {
        let temporaryName = ".collector-\(UUID().uuidString).tmp"
        let descriptor = temporaryName.withCString {
            openat(
                rootDescriptor,
                $0,
                O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
                mode_t(0o600)
            )
        }
        guard descriptor >= 0 else {
            throw HelperError(code: "EVIDENCE_WRITE_FAILED", message: "Evidence could not be written.")
        }

        var descriptorIsOpen = true
        var temporaryExists = true
        defer {
            if descriptorIsOpen {
                close(descriptor)
            }
            if temporaryExists {
                temporaryName.withCString { _ = unlinkat(rootDescriptor, $0, 0) }
            }
        }

        try writeAll(data, to: descriptor)
        guard fsync(descriptor) == 0 else {
            throw HelperError(code: "EVIDENCE_WRITE_FAILED", message: "Evidence could not be written.")
        }
        let closeResult = close(descriptor)
        descriptorIsOpen = false
        guard closeResult == 0 else {
            throw HelperError(code: "EVIDENCE_WRITE_FAILED", message: "Evidence could not be written.")
        }
        try rejectNonRegularDestination(filename, rootDescriptor: rootDescriptor)

        let renameResult = temporaryName.withCString { temporaryPointer in
            filename.withCString { filenamePointer in
                renameat(rootDescriptor, temporaryPointer, rootDescriptor, filenamePointer)
            }
        }
        guard renameResult == 0 else {
            throw HelperError(code: "EVIDENCE_WRITE_FAILED", message: "Evidence could not be written.")
        }
        temporaryExists = false
        _ = fsync(rootDescriptor)
    }

    private func rejectNonRegularDestination(_ filename: String, rootDescriptor: Int32) throws {
        var information = stat()
        let result = filename.withCString {
            fstatat(rootDescriptor, $0, &information, AT_SYMLINK_NOFOLLOW)
        }
        if result == 0 {
            guard information.st_mode & S_IFMT == S_IFREG else {
                throw EvidenceDestination.invalidDestination()
            }
            return
        }
        guard errno == ENOENT else {
            throw HelperError(code: "EVIDENCE_WRITE_FAILED", message: "Evidence could not be written.")
        }
    }

    private func writeAll(_ data: Data, to descriptor: Int32) throws {
        try data.withUnsafeBytes { bytes in
            guard let baseAddress = bytes.baseAddress else { return }
            var offset = 0
            while offset < bytes.count {
                let written = Darwin.write(
                    descriptor,
                    baseAddress.advanced(by: offset),
                    bytes.count - offset
                )
                if written < 0 && errno == EINTR {
                    continue
                }
                guard written > 0 else {
                    throw HelperError(
                        code: "EVIDENCE_WRITE_FAILED",
                        message: "Evidence could not be written."
                    )
                }
                offset += written
            }
        }
    }

    private func rootUnavailable() -> HelperError {
        HelperError(
            code: "EVIDENCE_ROOT_NOT_AVAILABLE",
            message: "Evidence root is not available."
        )
    }
}

struct ScreenCapture {
    private let environment: [String: String]

    init(environment: [String: String] = ProcessInfo.processInfo.environment) {
        self.environment = environment
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

        _ = try EvidenceDestination(destination)
        guard let window = frontWindow(processIdentifier: processIdentifier) else {
            throw HelperError(
                code: "FRONT_WINDOW_NOT_AVAILABLE",
                message: "Application window is not available."
            )
        }
        let image = try captureImage(window: window)

        let representation = NSBitmapImageRep(cgImage: image)
        guard let png = representation.representation(using: .png, properties: [:]) else {
            throw HelperError(code: "SCREEN_CAPTURE_FAILED", message: "Screen capture failed.")
        }
        try EvidenceFileWriter().write(png, root: root, destination: destination)

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
        switch ScreenshotCaptureRouting.backend(for: ProcessInfo.processInfo.operatingSystemVersion) {
        case .screenshotManager:
            guard #available(macOS 14.0, *) else { throw captureFailed() }
            return try captureImageWithScreenshotManager(window: window)
        case .screenCaptureKitStream:
            guard #available(macOS 12.3, *) else { throw captureFailed() }
            return try captureImageWithStream(window: window)
        case .coreGraphics:
            return try captureImageWithLegacyCoreGraphics(window: window)
        }
    }

    @available(macOS 14.0, *)
    private func captureImageWithScreenshotManager(window: WindowDescriptor) throws -> CGImage {
        let shareableWindow = try shareableWindow(identifier: window.identifier)
        let semaphore = DispatchSemaphore(value: 0)
        let capturedImage = CapturedImageBox()

        let configuration = streamConfiguration(for: shareableWindow)
        let filter = SCContentFilter(desktopIndependentWindow: shareableWindow)
        SCScreenshotManager.captureImage(
            contentFilter: filter,
            configuration: configuration
        ) { image, _ in
            capturedImage.store(image)
            semaphore.signal()
        }

        guard semaphore.wait(timeout: .now() + 10) == .success,
              let image = capturedImage.load() else {
            throw captureFailed()
        }
        return image
    }

    @available(macOS 12.3, *)
    private func captureImageWithStream(window: WindowDescriptor) throws -> CGImage {
        let shareableWindow = try shareableWindow(identifier: window.identifier)
        let receiver = StreamFrameReceiver()
        let filter = SCContentFilter(desktopIndependentWindow: shareableWindow)
        let stream = SCStream(
            filter: filter,
            configuration: streamConfiguration(for: shareableWindow),
            delegate: receiver
        )
        do {
            try stream.addStreamOutput(
                receiver,
                type: .screen,
                sampleHandlerQueue: receiver.queue
            )
        } catch {
            throw captureFailed()
        }

        let startSemaphore = DispatchSemaphore(value: 0)
        let startSucceeded = LockedBooleanBox()
        stream.startCapture { error in
            startSucceeded.store(error == nil)
            startSemaphore.signal()
        }
        guard startSemaphore.wait(timeout: .now() + 10) == .success,
              startSucceeded.load() else {
            throw captureFailed()
        }

        defer {
            let stopSemaphore = DispatchSemaphore(value: 0)
            stream.stopCapture { _ in stopSemaphore.signal() }
            _ = stopSemaphore.wait(timeout: .now() + 2)
        }

        guard receiver.semaphore.wait(timeout: .now() + 10) == .success,
              let image = receiver.image.load() else {
            throw captureFailed()
        }
        return image
    }

    @available(macOS 12.3, *)
    private func shareableWindow(identifier: CGWindowID) throws -> SCWindow {
        let semaphore = DispatchSemaphore(value: 0)
        let capturedWindow = ShareableWindowBox()

        SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: true) { content, _ in
            guard let shareableWindow = content?.windows.first(where: {
                $0.windowID == identifier
            }) else {
                semaphore.signal()
                return
            }
            capturedWindow.store(shareableWindow)
            semaphore.signal()
        }

        guard semaphore.wait(timeout: .now() + 10) == .success,
              let shareableWindow = capturedWindow.load() else {
            throw captureFailed()
        }
        return shareableWindow
    }

    @available(macOS 12.3, *)
    private func streamConfiguration(for window: SCWindow) -> SCStreamConfiguration {
        let configuration = SCStreamConfiguration()
        configuration.width = max(1, Int(window.frame.width * 2))
        configuration.height = max(1, Int(window.frame.height * 2))
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 30)
        configuration.pixelFormat = kCVPixelFormatType_32BGRA
        configuration.queueDepth = 1
        configuration.showsCursor = false
        return configuration
    }

    private func captureImageWithLegacyCoreGraphics(window: WindowDescriptor) throws -> CGImage {
        let frameworkPath = "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics"
        guard let handle = dlopen(frameworkPath, RTLD_LAZY | RTLD_LOCAL) else {
            throw captureFailed()
        }
        defer { dlclose(handle) }
        guard let symbol = dlsym(handle, "CGWindowListCreateImage") else {
            throw captureFailed()
        }

        typealias CreateWindowImage = @convention(c) (
            CGRect,
            UInt32,
            CGWindowID,
            UInt32
        ) -> Unmanaged<CGImage>?
        let createWindowImage = unsafeBitCast(symbol, to: CreateWindowImage.self)
        let options = CGWindowImageOption([.boundsIgnoreFraming, .bestResolution])
        guard let image = createWindowImage(
            .null,
            CGWindowListOption.optionIncludingWindow.rawValue,
            window.identifier,
            options.rawValue
        )?.takeRetainedValue() else {
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

@available(macOS 12.3, *)
private final class ShareableWindowBox: @unchecked Sendable {
    private let lock = NSLock()
    private var window: SCWindow?

    func store(_ window: SCWindow) {
        lock.lock()
        self.window = window
        lock.unlock()
    }

    func load() -> SCWindow? {
        lock.lock()
        defer { lock.unlock() }
        return window
    }
}

private final class LockedBooleanBox: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false

    func store(_ value: Bool) {
        lock.lock()
        self.value = value
        lock.unlock()
    }

    func load() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return value
    }
}

@available(macOS 12.3, *)
private final class StreamFrameReceiver: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    let queue = DispatchQueue(label: "taobao-ax-helper.screen-capture")
    let semaphore = DispatchSemaphore(value: 0)
    let image = CapturedImageBox()

    private let context = CIContext()
    private let lock = NSLock()
    private var completed = false

    func stream(
        _ stream: SCStream,
        didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of outputType: SCStreamOutputType
    ) {
        guard outputType == .screen,
              sampleBuffer.isValid,
              let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else {
            return
        }
        let source = CIImage(cvPixelBuffer: pixelBuffer)
        guard let captured = context.createCGImage(source, from: source.extent) else {
            return
        }
        finish(with: captured)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        finish(with: nil)
    }

    private func finish(with captured: CGImage?) {
        lock.lock()
        guard !completed else {
            lock.unlock()
            return
        }
        completed = true
        lock.unlock()
        image.store(captured)
        semaphore.signal()
    }
}
