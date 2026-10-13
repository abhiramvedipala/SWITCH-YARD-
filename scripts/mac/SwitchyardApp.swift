// Switchyard.app — a native AppKit + WebKit shell around the local server (no Electron, no third-party code).
// Built by scripts/mac/make-app.sh: `swiftc -O -framework Cocoa -framework WebKit`. @@REPO@@ is substituted at build time.
// Semantics mirror the old bash launcher: probe 127.0.0.1:<port>, start `node packages/core/dist/server.js`
// if it is down (detached, so ⌘Q leaves the server running; `npm run stop` stops it), then load the UI with
// the token from ~/.switchyard/ui-session. Env: SWITCHYARD_PORT, SWITCHYARD_HOME.
import Cocoa
@preconcurrency import WebKit

@main
class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKUIDelegate, WKNavigationDelegate {
  static let shared = AppDelegate()
  // NSApplicationDelegate's default main() expects a main nib; there is none, so wire the delegate by hand.
  static func main() {
    NSApplication.shared.delegate = shared
    NSApplication.shared.run()
  }

  let repo = "@@REPO@@"
  let env = ProcessInfo.processInfo.environment
  lazy var port = Int(env["SWITCHYARD_PORT"] ?? "") ?? 4777
  lazy var home = env["SWITCHYARD_HOME"] ?? (NSHomeDirectory() + "/.switchyard")
  lazy var base = URL(string: "http://127.0.0.1:\(port)/")!
  lazy var logPath = home + "/server.log"

  func isLoopback(_ url: URL?) -> Bool {
    guard let h = url?.host else { return false }
    return h == "127.0.0.1" || h == "localhost" || h == "::1"
  }

  func shellQuote(_ s: String) -> String { "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'" }
  func log(_ s: String) { FileHandle.standardError.write(Data("switchyard: \(s)\n".utf8)) }

  var window: NSWindow!
  var webView: WKWebView!
  var status: NSTextField!
  var attempts = 0

  // MARK: app lifecycle
  func applicationDidFinishLaunching(_ note: Notification) {
    log("port \(port), home \(home), repo \(repo)")
    NSApp.setActivationPolicy(.regular)
    buildMenu()
    buildWindow()
    NSApp.activate(ignoringOtherApps: true)
    log("window up")
    probe { up in
      self.log(up ? "server already up" : "server down, starting it")
      if up { self.loadUI() } else { self.startServer(); self.waitForServer() }
    }
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
    window.makeKeyAndOrderFront(nil)
    return true
  }

  // MARK: window + web view
  func buildWindow() {
    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
      styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
      backing: .buffered, defer: false)
    window.title = "Switchyard"
    window.titlebarAppearsTransparent = true
    window.titleVisibility = .hidden
    window.minSize = NSSize(width: 900, height: 600)
    window.isReleasedWhenClosed = false  // ⌘W just hides it; the Dock icon brings it back
    window.delegate = self
    window.center()
    window.setFrameAutosaveName("SwitchyardMain")
    window.tabbingMode = .disallowed

    let config = WKWebViewConfiguration()
    config.preferences.setValue(true, forKey: "developerExtrasEnabled")  // right-click → Inspect Element
    config.websiteDataStore = .default()  // persistent localStorage (the UI token lives there)
    // The UI's own top bar sits under the traffic lights (full-size content view): make room for them.
    // ponytail: done here, not in packages/web, so the browser layout is untouched.
    let css = ".topbar{padding-left:82px !important}"
    let js = "var s=document.createElement('style');s.textContent=\(jsonString(css));document.head.appendChild(s);"
    config.userContentController.addUserScript(
      WKUserScript(source: js, injectionTime: .atDocumentEnd, forMainFrameOnly: true))

    webView = WKWebView(frame: window.contentView!.bounds, configuration: config)
    webView.autoresizingMask = [.width, .height]
    webView.allowsBackForwardNavigationGestures = false
    webView.uiDelegate = self
    webView.navigationDelegate = self
    if #available(macOS 13.3, *) { webView.isInspectable = true }
    webView.isHidden = true
    window.contentView!.addSubview(webView)

    status = NSTextField(wrappingLabelWithString: "Starting Switchyard…")
    status.alignment = .center
    status.font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
    status.textColor = .secondaryLabelColor
    status.translatesAutoresizingMaskIntoConstraints = false
    window.contentView!.addSubview(status)
    NSLayoutConstraint.activate([
      status.centerXAnchor.constraint(equalTo: window.contentView!.centerXAnchor),
      status.centerYAnchor.constraint(equalTo: window.contentView!.centerYAnchor),
      status.widthAnchor.constraint(lessThanOrEqualTo: window.contentView!.widthAnchor, constant: -80),
    ])
    window.makeKeyAndOrderFront(nil)
  }

  func jsonString(_ s: String) -> String {
    let d = try! JSONSerialization.data(withJSONObject: [s])
    let arr = String(decoding: d, as: UTF8.self)
    return String(arr.dropFirst().dropLast())
  }

  func loadUI() {
    var url = base
    if let raw = try? String(contentsOfFile: home + "/ui-session", encoding: .utf8) {
      let token = raw.replacingOccurrences(of: "\n", with: "")
      if !token.isEmpty { url = URL(string: base.absoluteString + "#token=" + token) ?? base }
    }
    status.isHidden = true
    webView.isHidden = false
    webView.load(URLRequest(url: url))
  }

  // MARK: server bootstrap
  func probe(_ done: @escaping (Bool) -> Void) {
    var req = URLRequest(url: base)
    req.timeoutInterval = 1
    URLSession.shared.dataTask(with: req) { _, resp, _ in
      DispatchQueue.main.async { done(resp != nil) }
    }.resume()
  }

  func startServer() {
    let q = shellQuote
    let script = """
      mkdir -p \(q(home)); cd \(q(repo)) || exit 1
      [ -f packages/core/dist/server.js ] || npm run build >> \(q(logPath)) 2>&1
      nohup node --max-semi-space-size=1 packages/core/dist/server.js >> \(q(logPath)) 2>&1 &
      """
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/sh")
    p.arguments = ["-c", script]
    var e = env
    e["PATH"] = "/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/local/bin:" + (env["PATH"] ?? "/usr/bin:/bin")
    e["SWITCHYARD_PORT"] = String(port)
    e["SWITCHYARD_HOME"] = home
    p.environment = e
    do {
      try p.run()
      p.waitUntilExit()  // sh returns at once; the server is backgrounded with nohup
      log("start script exited \(p.terminationStatus)")
    } catch { showLogTail("Could not run /bin/sh: \(error)") }
  }

  func waitForServer() {
    probe { up in
      if up { return self.loadUI() }
      self.attempts += 1
      if self.attempts >= 120 { return self.showLogTail("Switchyard did not start within 60 s.") }
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.waitForServer() }
    }
  }

  func showLogTail(_ headline: String) {
    let text = (try? String(contentsOfFile: logPath, encoding: .utf8)) ?? "(no \(logPath))"
    let tail = text.split(separator: "\n", omittingEmptySubsequences: false).suffix(20).joined(separator: "\n")
    status.alignment = .left
    status.stringValue = headline + "\n\nLast lines of \(logPath):\n\n" + tail
  }

  // MARK: WKNavigationDelegate — anything that is not the local server opens in the default browser
  func webView(
    _ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    guard let url = action.request.url else { return decisionHandler(.cancel) }
    if isLoopback(url) && action.targetFrame != nil { return decisionHandler(.allow) }
    if url.scheme == "about" || url.scheme == "blob" || url.scheme == "data" { return decisionHandler(.allow) }
    NSWorkspace.shared.open(url)
    decisionHandler(.cancel)
  }

  // MARK: WKUIDelegate — target=_blank, mic permission and JS dialogs
  func webView(
    _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
    for action: WKNavigationAction, windowFeatures: WKWindowFeatures
  ) -> WKWebView? {
    if let url = action.request.url { NSWorkspace.shared.open(url) }
    return nil
  }

  @available(macOS 12.0, *)
  func webView(
    _ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
    initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
    decisionHandler: @escaping (WKPermissionDecision) -> Void
  ) {
    let local = origin.host == "127.0.0.1" || origin.host == "localhost"
    decisionHandler(local && type == .microphone ? .grant : .deny)
  }

  func alert(_ message: String, cancel: Bool) -> Bool {
    let a = NSAlert()
    a.messageText = "Switchyard"
    a.informativeText = message
    a.addButton(withTitle: "OK")
    if cancel { a.addButton(withTitle: "Cancel") }
    return a.runModal() == .alertFirstButtonReturn
  }

  func webView(
    _ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
    initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void
  ) {
    _ = alert(message, cancel: false)
    completionHandler()
  }

  func webView(
    _ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
    initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void
  ) {
    completionHandler(alert(message, cancel: true))
  }

  func webView(
    _ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
    initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void
  ) {
    let a = NSAlert()
    a.messageText = "Switchyard"
    a.informativeText = prompt
    a.addButton(withTitle: "OK")
    a.addButton(withTitle: "Cancel")
    let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
    field.stringValue = defaultText ?? ""
    a.accessoryView = field
    a.window.initialFirstResponder = field
    completionHandler(a.runModal() == .alertFirstButtonReturn ? field.stringValue : nil)
  }

  // MARK: menu bar
  @objc func reload(_ s: Any?) { webView.reload() }
  @objc func actualSize(_ s: Any?) { webView.pageZoom = 1 }
  @objc func zoomIn(_ s: Any?) { webView.pageZoom = min(3, webView.pageZoom + 0.1) }
  @objc func zoomOut(_ s: Any?) { webView.pageZoom = max(0.5, webView.pageZoom - 0.1) }

  func buildMenu() {
    let main = NSMenu()
    func menu(_ title: String, _ items: [NSMenuItem?]) -> NSMenu {
      let m = NSMenu(title: title)
      for i in items { m.addItem(i ?? .separator()) }
      let top = NSMenuItem(title: title, action: nil, keyEquivalent: "")
      top.submenu = m
      main.addItem(top)
      return m
    }
    func item(_ title: String, _ action: Selector, _ key: String, _ mods: NSEvent.ModifierFlags = .command, target: AnyObject? = nil) -> NSMenuItem {
      let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
      i.keyEquivalentModifierMask = mods
      i.target = target
      return i
    }
    _ = menu("Switchyard", [
      item("About Switchyard", #selector(NSApplication.orderFrontStandardAboutPanel(_:)), ""),
      nil,
      item("Hide Switchyard", #selector(NSApplication.hide(_:)), "h"),
      item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
      item("Show All", #selector(NSApplication.unhideAllApplications(_:)), ""),
      nil,
      item("Quit Switchyard", #selector(NSApplication.terminate(_:)), "q"),
    ])
    _ = menu("Edit", [
      item("Undo", Selector(("undo:")), "z"),
      item("Redo", Selector(("redo:")), "Z"),
      nil,
      item("Cut", #selector(NSText.cut(_:)), "x"),
      item("Copy", #selector(NSText.copy(_:)), "c"),
      item("Paste", #selector(NSText.paste(_:)), "v"),
      item("Select All", #selector(NSText.selectAll(_:)), "a"),
    ])
    _ = menu("View", [
      item("Reload", #selector(reload(_:)), "r", target: self),
      nil,
      item("Actual Size", #selector(actualSize(_:)), "0", target: self),
      item("Zoom In", #selector(zoomIn(_:)), "+", target: self),
      item("Zoom Out", #selector(zoomOut(_:)), "-", target: self),
      nil,
      item("Toggle Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
    ])
    let win = menu("Window", [
      item("Close", #selector(NSWindow.performClose(_:)), "w"),
      item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
      item("Zoom", #selector(NSWindow.performZoom(_:)), ""),
      nil,
      item("Bring All to Front", #selector(NSApplication.arrangeInFront(_:)), ""),
    ])
    NSApp.mainMenu = main
    NSApp.windowsMenu = win
  }
}
