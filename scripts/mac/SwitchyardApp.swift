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
  lazy var needsYou = NeedsYou(app: self)

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
    needsYou.schedule()  // server is up: start the attention polls
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
      item("Needs You Panel", #selector(NeedsYou.toggle(_:)), "n", [.command, .option], target: needsYou),
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

// MARK: "Needs you" — a floating utility panel plus a menu-bar count, fed by the local /api/attention feed.
// Long-polls while the panel is visible; a 30 s summary poll keeps the count while only the status item shows;
// nothing runs when both are hidden. Talks only to 127.0.0.1:<port> with the ui-session token (never logged).
// SWITCHYARD_PANEL_SELFTEST=1 (mac:check) shows the panel and answers the first question with "ok" once.
final class FlippedStack: NSStackView { override var isFlipped: Bool { true } }

final class NeedsYou: NSObject, NSWindowDelegate {
  unowned let app: AppDelegate
  var selftest: Bool
  var panel: NSPanel!
  var list: NSStackView!
  var statusItem: NSStatusItem!
  var items: [[String: Any]] = []
  var since = ""  // the feed's last content hash
  var task: URLSessionDataTask?
  var timer: Timer?
  var removal: NSKeyValueObservation?
  lazy var session: URLSession = {
    let c = URLSessionConfiguration.ephemeral  // no cache: a 304 must reach us as a 304
    c.urlCache = nil
    c.requestCachePolicy = .reloadIgnoringLocalCacheData
    return URLSession(configuration: c)
  }()

  init(app: AppDelegate) {
    self.app = app
    selftest = app.env["SWITCHYARD_PANEL_SELFTEST"] == "1"
    super.init()
    buildStatusItem()
    buildPanel()  // renders the empty state, which also sets the status item's count
    if selftest { show() }
  }

  func buildPanel() {
    panel = NSPanel(
      contentRect: NSRect(x: 0, y: 0, width: 340, height: 420),
      styleMask: [.titled, .closable, .resizable, .utilityWindow, .nonactivatingPanel],
      backing: .buffered, defer: false)
    panel.title = "Needs you"
    panel.level = .floating
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    panel.isReleasedWhenClosed = false
    panel.hidesOnDeactivate = false
    panel.becomesKeyOnlyIfNeeded = true  // only takes the keyboard when you click its answer field
    panel.minSize = NSSize(width: 260, height: 160)
    panel.delegate = self
    if let s = NSScreen.main?.visibleFrame { panel.setFrameTopLeftPoint(NSPoint(x: s.maxX - 360, y: s.maxY - 20)) }
    panel.setFrameAutosaveName("SwitchyardNeedsYou")
    let fx = NSVisualEffectView()
    fx.material = .popover
    fx.blendingMode = .behindWindow
    fx.state = .active
    panel.contentView = fx
    let scroll = NSScrollView(frame: fx.bounds)
    scroll.autoresizingMask = [.width, .height]
    scroll.drawsBackground = false
    scroll.hasVerticalScroller = true
    list = FlippedStack()
    list.orientation = .vertical
    list.alignment = .width
    list.spacing = 0
    list.translatesAutoresizingMaskIntoConstraints = false
    scroll.documentView = list
    NSLayoutConstraint.activate([
      list.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor),
      list.trailingAnchor.constraint(equalTo: scroll.contentView.trailingAnchor),
      list.topAnchor.constraint(equalTo: scroll.contentView.topAnchor),
      list.heightAnchor.constraint(greaterThanOrEqualTo: scroll.contentView.heightAnchor),
    ])
    fx.addSubview(scroll)
    render([])
  }

  func buildStatusItem() {
    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    statusItem.behavior = .removalAllowed  // ⌘-drag it off the menu bar; then only the panel polls
    statusItem.autosaveName = "SwitchyardNeedsYou"
    if let b = statusItem.button {
      b.image = NSImage(systemSymbolName: "arrow.triangle.branch", accessibilityDescription: "Switchyard")
      b.imagePosition = .imageLeading
      b.target = self
      b.action = #selector(toggle(_:))
    }
    setCount(nil)
    removal = statusItem.observe(\.isVisible) { [weak self] _, _ in self?.schedule() }
  }

  func setCount(_ n: Int?) {
    statusItem.button?.title = n == nil ? "○" : n == 0 ? "✓" : "● \(n!)"  // ○ = core not reachable
  }

  // MARK: show / hide
  @objc func toggle(_ s: Any?) { panel.isVisible ? hide() : show() }
  func show() { panel.orderFront(nil); schedule() }
  func hide() { panel.orderOut(nil); schedule() }
  func windowShouldClose(_ sender: NSWindow) -> Bool { hide(); return false }  // ⌘W hides, never destroys

  // MARK: polling
  func schedule() {
    timer?.invalidate()
    timer = nil
    if panel.isVisible { return poll() }
    task?.cancel()
    task = nil
    guard statusItem.isVisible else { return }
    summary()
    timer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in self?.summary() }
  }

  func poll() {
    guard panel.isVisible, task == nil else { return }
    var t: URLSessionDataTask!
    t = request("GET", "api/attention?wait=30&since=\(since)", nil) { status, json in
      guard self.task === t else { return }  // cancelled by hide(); a newer poll may be running
      self.task = nil
      guard self.panel.isVisible else { return }
      if status == 200, let j = json, let items = j["items"] as? [[String: Any]] {
        self.since = j["hash"] as? String ?? ""
        self.render(items)
        self.poll()
      } else if status == 304 {
        self.poll()
      } else {
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { self.poll() }  // core down: back off
      }
    }
    task = t
  }

  func summary() {
    request("GET", "api/attention/summary", nil) { status, json in
      self.setCount(status == 200 ? json?["count"] as? Int : nil)
    }
  }

  @discardableResult
  func request(_ method: String, _ path: String, _ body: [String: Any]?, _ done: @escaping (Int, [String: Any]?) -> Void)
    -> URLSessionDataTask
  {
    var req = URLRequest(url: URL(string: path, relativeTo: app.base)!)
    req.httpMethod = method
    req.timeoutInterval = 40
    if let raw = try? String(contentsOfFile: app.home + "/ui-session", encoding: .utf8) {
      req.setValue("Bearer " + raw.trimmingCharacters(in: .whitespacesAndNewlines), forHTTPHeaderField: "Authorization")
    }
    if let body = body {
      req.setValue("application/json", forHTTPHeaderField: "Content-Type")
      req.httpBody = try? JSONSerialization.data(withJSONObject: body)
    }
    let t = session.dataTask(with: req) { data, resp, _ in
      let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
      let json = data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]
      DispatchQueue.main.async { done(status, json) }
    }
    t.resume()
    return t
  }

  // MARK: rows
  // ponytail: rows are rebuilt on every feed change, so a half-typed answer is lost if the list changes meanwhile.
  func render(_ new: [[String: Any]]) {
    items = new.sorted { ($0["createdAt"] as? Double ?? 0) > ($1["createdAt"] as? Double ?? 0) }
    list.arrangedSubviews.forEach { $0.removeFromSuperview() }
    list.edgeInsets = NSEdgeInsets(top: items.isEmpty ? 24 : 0, left: 0, bottom: 0, right: 0)
    if items.isEmpty {
      let l = label("Nothing needs you", .systemFont(ofSize: 12), color: .secondaryLabelColor)
      l.alignment = .center
      list.addArrangedSubview(l)
    }
    for (i, it) in items.enumerated() {
      if i > 0 {
        let sep = NSBox()
        sep.boxType = .separator
        list.addArrangedSubview(sep)
      }
      list.addArrangedSubview(row(i, it))
    }
    app.log("panel items=\(items.count)")
    setCount(items.count)
    if selftest, let i = items.firstIndex(where: { $0["kind"] as? String == "question" }) {
      selftest = false
      answer(i, "ok")
    }
  }

  func label(_ s: String, _ font: NSFont, color: NSColor = .labelColor, lines: Int = 1) -> NSTextField {
    let l = NSTextField(wrappingLabelWithString: s)
    l.font = font
    l.textColor = color
    l.maximumNumberOfLines = lines
    l.lineBreakMode = .byTruncatingTail
    l.isSelectable = false
    return l
  }

  func row(_ i: Int, _ it: [String: Any]) -> NSView {
    let kind = it["kind"] as? String ?? ""
    let (glyph, chip) = [
      "question": ("questionmark.bubble", "question"), "permission": ("lock.shield", "permission"),
      "needs_input": ("keyboard", "needs input"), "unread": ("envelope.badge", "unread"),
    ][kind] ?? ("bell", kind)
    let icon = NSImageView(image: NSImage(systemSymbolName: glyph, accessibilityDescription: chip) ?? NSImage())
    icon.contentTintColor = .secondaryLabelColor
    let title = label(it["nodeTitle"] as? String ?? "", .systemFont(ofSize: 12, weight: .semibold))
    title.setContentHuggingPriority(.defaultLow, for: .horizontal)
    let tag = NSButton(title: chip, target: nil, action: nil)  // .inline bezel is the native "chip" look
    tag.bezelStyle = .inline
    tag.controlSize = .mini
    tag.isEnabled = false
    let head = NSStackView(views: [icon, title, tag])
    head.distribution = .fill
    let text = label(it["text"] as? String ?? "", .systemFont(ofSize: 11), color: .secondaryLabelColor, lines: 2)
    func button(_ t: String, _ sel: Selector, _ id: String = "") -> NSButton {
      let b = NSButton(title: t, target: self, action: sel)
      b.bezelStyle = .rounded
      b.controlSize = .small
      b.font = .systemFont(ofSize: 11)
      b.tag = i
      b.identifier = NSUserInterfaceItemIdentifier(id)
      return b
    }
    var actions: [NSView] = []
    switch kind {
    case "question":
      let f = NSTextField(string: "")
      f.placeholderString = "Your answer…"
      f.controlSize = .small
      f.font = .systemFont(ofSize: 11)
      f.tag = i
      f.target = self
      f.action = #selector(send(_:))
      f.setContentHuggingPriority(.defaultLow, for: .horizontal)
      actions = [f, button("Send", #selector(send(_:)))]
    case "permission":
      actions = (it["options"] as? [String] ?? ["allow", "deny", "ask"]).map {
        button($0.capitalized, #selector(decide(_:)), $0)
      }
    case "needs_input" where it["prompt"] as? String == "trust":
      actions = [button("Accept", #selector(accept(_:)))]
    case "unread":
      actions = [button("Open", #selector(open(_:)))]
    default: break
    }
    var views: [NSView] = [head, text]
    if !actions.isEmpty {
      let a = NSStackView(views: actions)
      a.distribution = .fill
      views.append(a)
    }
    let col = NSStackView(views: views)
    col.orientation = .vertical
    col.alignment = .width
    col.spacing = 4
    col.edgeInsets = NSEdgeInsets(top: 8, left: 12, bottom: 8, right: 12)
    return col
  }

  // MARK: actions — the same routes the web UI's Needs-you tab calls
  @objc func send(_ s: NSControl) {
    let field = s as? NSTextField ?? (s.superview as? NSStackView)?.arrangedSubviews.compactMap { $0 as? NSTextField }.first
    guard let f = field, !f.stringValue.trimmingCharacters(in: .whitespaces).isEmpty else { return }
    answer(s.tag, f.stringValue)
    f.stringValue = ""
  }

  func answer(_ i: Int, _ text: String) {
    guard i < items.count, let id = items[i]["id"] as? String else { return }
    request("POST", "api/questions/\(id)/answer", ["answer": text]) { status, _ in
      self.app.log("panel answer status=\(status)")
    }
  }

  @objc func decide(_ s: NSButton) {
    guard s.tag < items.count, let id = items[s.tag]["id"] as? String else { return }
    request("POST", "api/permissions/\(id)/decide", ["decision": s.identifier?.rawValue ?? "ask"]) { status, _ in
      self.app.log("panel decide status=\(status)")
    }
  }

  /// Trust prompt: Enter picks "Yes, proceed" in the agent's terminal (what the web UI's Accept does).
  @objc func accept(_ s: NSButton) {
    guard s.tag < items.count, let id = items[s.tag]["nodeId"] as? String else { return }
    request("POST", "api/nodes/\(id)/reply", ["text": "enter", "raw": true]) { status, _ in
      self.app.log("panel accept status=\(status)")
    }
  }

  @objc func open(_ s: Any?) {
    NSApp.activate(ignoringOtherApps: true)
    app.window.makeKeyAndOrderFront(nil)
  }
}
