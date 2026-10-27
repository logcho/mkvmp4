import Cocoa
import WebKit
import UniformTypeIdentifiers

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKDownloadDelegate, WKUIDelegate, NSOpenSavePanelDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var backend: Process?
    var backendOutput = ""
    var localURL: URL?
    var quitting = false
    var started = false
    var startupTimer: Timer?
    var errorLog: URL!

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        createMenu()
        let config = WKWebViewConfiguration()
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 600, height: 690), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "MKV to MP4"
        window.minSize = NSSize(width: 380, height: 620)
        window.contentView = webView
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        webView.loadHTMLString("<body style='background:#fafafa;color:#747474;font:300 14px -apple-system;padding:80px 40px'>Starting converter…</body>", baseURL: nil)
        startBackend()
    }

    func createMenu() {
        let menu = NSMenu()
        let appItem = NSMenuItem()
        menu.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About MKV to MP4", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide MKV to MP4", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit MKV to MP4", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "Edit")
        for (title, action, key) in [("Undo", "undo:", "z"), ("Cut", "cut:", "x"), ("Copy", "copy:", "c"), ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")] {
            editMenu.addItem(withTitle: title, action: Selector(action), keyEquivalent: key)
        }
        editItem.submenu = editMenu
        menu.addItem(editItem)
        NSApp.mainMenu = menu
    }

    func startBackend() {
        guard let resources = Bundle.main.resourceURL else { fail("App resources are missing."); return }
        let fm = FileManager.default
        let support = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("MKV to MP4", isDirectory: true)
        do {
            try fm.createDirectory(at: support, withIntermediateDirectories: true)
            errorLog = support.appendingPathComponent("server.log")
            fm.createFile(atPath: errorLog.path, contents: nil)
            let errorHandle = try FileHandle(forWritingTo: errorLog)
            let process = Process()
            process.executableURL = resources.appendingPathComponent("bin/node")
            process.arguments = [resources.appendingPathComponent("server.mjs").path]
            process.currentDirectoryURL = resources
            var env = ProcessInfo.processInfo.environment
            env["PATH"] = resources.appendingPathComponent("bin").path + ":/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
            env["CONVERSIONS_DIR"] = support.appendingPathComponent("Temporary Conversions").path
            process.environment = env
            let output = Pipe()
            process.standardOutput = output
            process.standardError = errorHandle
            output.fileHandleForReading.readabilityHandler = { [weak self] handle in
                let data = handle.availableData
                guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
                DispatchQueue.main.async { self?.readBackend(text) }
            }
            process.terminationHandler = { [weak self] _ in
                DispatchQueue.main.async {
                    guard let self, !self.quitting else { return }
                    self.fail("The conversion server stopped. Close and reopen the app.\n\nLog: \(self.errorLog.path)")
                }
            }
            backend = process
            try process.run()
            startupTimer = Timer.scheduledTimer(withTimeInterval: 15, repeats: false) { [weak self] _ in
                guard let self, !self.started else { return }
                self.fail("The conversion server did not start. Close and reopen the app.")
            }
        } catch { fail("Could not start the converter: \(error.localizedDescription)") }
    }

    func readBackend(_ text: String) {
        guard !started else { return }
        backendOutput += text
        guard let line = backendOutput.split(separator: "\n").first,
              let data = String(line).data(using: .utf8),
              let info = try? JSONSerialization.jsonObject(with: data) as? [String: Int],
              let port = info["port"], let url = URL(string: "http://127.0.0.1:\(port)/") else { return }
        started = true
        startupTimer?.invalidate()
        localURL = url
        webView.load(URLRequest(url: url))
    }

    func panel(_ sender: Any, shouldEnable url: URL) -> Bool {
        var directory: ObjCBool = false
        if FileManager.default.fileExists(atPath: url.path, isDirectory: &directory), directory.boolValue { return true }
        return url.pathExtension.lowercased() == "mkv"
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        guard frame.isMainFrame, frame.request.url?.host == localURL?.host,
              frame.request.url?.port == localURL?.port else { completionHandler(nil); return }
        let panel = NSOpenPanel()
        panel.delegate = self
        panel.allowsOtherFileTypes = true
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.message = "Choose an MKV video to convert."
        panel.beginSheetModal(for: window) { result in completionHandler(result == .OK ? panel.urls : nil) }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if url.scheme == "about" { decisionHandler(.allow); return }
        guard url.scheme == "http", url.host == localURL?.host, url.port == localURL?.port else { decisionHandler(.cancel); return }
        decisionHandler(navigationAction.shouldPerformDownload ? .download : .allow)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        let response = navigationResponse.response as? HTTPURLResponse
        let attachment = response?.value(forHTTPHeaderField: "Content-Disposition")?.hasPrefix("attachment") == true
        decisionHandler(attachment ? .download : .allow)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggestedFilename
        panel.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
        panel.canCreateDirectories = true
        panel.beginSheetModal(for: window) { result in completionHandler(result == .OK ? panel.url : nil) }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        if (error as NSError).code != NSURLErrorCancelled { showAlert("Download failed", error.localizedDescription) }
    }

    func showAlert(_ title: String, _ message: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.beginSheetModal(for: window, completionHandler: nil)
    }
    func fail(_ message: String) { startupTimer?.invalidate(); showAlert("Could not start converter", message) }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationWillTerminate(_ notification: Notification) {
        quitting = true
        startupTimer?.invalidate()
        if let process = backend, process.isRunning { process.terminate(); process.waitUntilExit() }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
