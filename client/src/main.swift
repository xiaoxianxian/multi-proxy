import AppKit
import WebKit
import Foundation

// MARK: - 落盘日志（注意：插值必须是单反斜杠 \( ，写成 \\( 会生成反斜杠开头的非法路径 → 静默写不进去）
func log(_ s: String) {
    let home = NSHomeDirectory()
    let dir  = "\(home)/Library/Logs"
    let path = "\(dir)/MultiProxy-client.log"
    if !FileManager.default.fileExists(atPath: dir) {
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    }
    // 注意：直接用 "\(Date())" 打出来的是 UTC，比本地早 8 小时，排障会看错时间
    let f = DateFormatter()
    f.locale = Locale(identifier: "zh_CN")
    f.timeZone = TimeZone.current
    f.dateFormat = "yyyy-MM-dd HH:mm:ss"
    let line = "\(f.string(from: Date())) \(s)\n"
    if FileManager.default.fileExists(atPath: path),
       let h = FileHandle(forWritingAtPath: path) {
        h.seekToEndOfFile(); h.write(Data(line.utf8)); try? h.synchronize()
    } else {
        try? line.write(toFile: path, atomically: true, encoding: .utf8)
    }
    fputs(line, stderr)
}

// MARK: - 常量
/// ⚠️ 开源脱敏：本机绝对路径不能写死。
/// 底座目录按「环境变量 MULTIPROXY_DIR → 若干候选目录探测（含 codex-proxy/proxy.js 落点校验）」解析。
/// 别人 clone 后把目录改成任意名字都能跑；本机（~/Documents/AI项目/multi-proxy）命中第一个候选。
let PROXY_DIR: String = {
    if let d = ProcessInfo.processInfo.environment["MULTIPROXY_DIR"], !d.isEmpty { return d }
    let fm = FileManager.default
    let home = NSHomeDirectory()
    let candidates = [
        home + "/Documents/AI项目/multi-proxy",
        home + "/Documents/multi-proxy",
        home + "/multi-proxy",
        home + "/Developer/multi-proxy",
        "/opt/multi-proxy",
    ]
    for c in candidates {
        var isDir: ObjCBool = true
        if fm.fileExists(atPath: c, isDirectory: &isDir), isDir.boolValue,
           fm.fileExists(atPath: c + "/codex-proxy/proxy.js") { return c }
    }
    return candidates[0]
}()
let MANAGE      = "\(PROXY_DIR)/manage.sh"
let CODEX_DIR   = "\(PROXY_DIR)/codex-proxy"
let PROXY_JS    = "\(CODEX_DIR)/proxy.js"
/// node：环境变量 MULTIPROXY_NODE → 托管版本候选 → which node。
let NODE: String = {
    if let n = ProcessInfo.processInfo.environment["MULTIPROXY_NODE"], !n.isEmpty { return n }
    let fm = FileManager.default
    let home = NSHomeDirectory()
    for c in [home + "/.workbuddy/binaries/node/versions/22.22.2-3/bin/node",
              home + "/.workbuddy/binaries/node/current/bin/node",
              "/opt/homebrew/bin/node", "/usr/local/bin/node"] {
        if fm.isExecutableFile(atPath: c) { return c }
    }
    return "node"
}()
let HEALTH      = "http://127.0.0.1:18790/health"
let DASHBOARD   = "http://127.0.0.1:18792/dashboard.html"
let APP_NAME    = "MultiProxy 底座"
let AGENT_ID    = "com.multi-proxy.dashboard"
let DSH_APP     = "DeepSeek Harness"
let PATCH_FILE  = "\(NSHomeDirectory())/.dsh/profiles/desktop/cordis.patch.yml"
let SETTINGS    = "\(NSHomeDirectory())/.dsh/settings.yaml.imported"
let LAUNCHDIR   = "\(NSHomeDirectory())/Library/LaunchAgents"
let AGENT_PLIST = "\(LAUNCHDIR)/\(AGENT_ID).plist"

// MARK: - 工具
/// 子进程环境：只给必要的，别把 Shell 会话的自定义变量（BASH_ENV 之类）传染过去。
/// PATH 里的 node/python3 用本机的 WorkBuddy 托管版本（/opt/homebrew/bin 下没有 node）。
func childEnvironment() -> [String: String] {
    let home = NSHomeDirectory()
    // node/python 目录同样做候选探测，别写死本机托管版本路径（开源后默认回退通用 PATH）
    let nodeDir  = (NODE as NSString).deletingLastPathComponent
    let pythonDir: String = {
        let c = home + "/.workbuddy/binaries/python/versions/3.13.12/bin"
        if FileManager.default.isExecutableFile(atPath: c + "/python3") { return c }
        return "/opt/homebrew/bin"
    }()
    return [
        "PATH": (nodeDir.isEmpty ? "" : nodeDir + ":")
                 + (pythonDir.isEmpty ? "" : pythonDir + ":")
                 + "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        "HOME": home,
        "SHELL": "/bin/bash",
        "TERM": "dumb",
        "LANG": "zh_CN.UTF-8",
        "USER": NSUserName(),
        "LOGNAME": NSUserName(),
    ]
}

/// ⚠️ 踩过的坑：原来用 Pipe + readDataToEndOfFile() 读输出，
/// 结果卡死 —— manage.sh 里 nohup 起来的一堆 node/python 守护进程继承了管道的写端，
/// 一直往里灌日志把 16KB 管道缓冲区写满，manage.sh 自己卡在 write，
/// 父进程又卡在 readDataToEndOfFile 等 EOF，两边互等死锁（底座起不来、DSH 也开不了）。
/// 改法：子进程 stdout/stderr 直接指向临时文件（非管道 ⇒ 没有 EOF 概念 ⇒ 不会卡），
/// 父进程只在「子进程自己退出」后才去读文件。
func runShell(_ cmd: String, timeout: TimeInterval = 90) -> String {
    let dir = "\(NSHomeDirectory())/Library/Logs/MultiProxy-client-tmp"
    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    let outPath = "\(dir)/\(UUID().uuidString).txt"
    FileManager.default.createFile(atPath: outPath, contents: nil)
    guard let fh = FileHandle(forWritingAtPath: outPath) else { return "" }
    defer { try? fh.close(); try? FileManager.default.removeItem(atPath: outPath) }

    let t0 = Date()
    log("runShell -> \(cmd.prefix(80))")
    let t = Process()
    t.launchPath = "/bin/bash"
    t.arguments = ["-c", cmd]
    // ⚠️ 关键：必须给子进程一套「干净环境」。
    // 直接继承父进程环境的话，会把 Shell 会话里的 BASH_ENV（指向 agent 的 shim 脚本）
    // 一起带过去 —— bash -c 会先 source 它，shim 在 GUI 应用进程里会卡死，
    // 表现就是「双击客户端底座起不来、日志只有第一行 startBase」。
    t.environment = childEnvironment()
    t.standardOutput = fh
    t.standardError = fh
    do { try t.run() } catch { return "" }

    // 只等「这个 bash 自己」退出，不等它 fork 出去的守护进程。
    // ⚠️ 别用 Timer.scheduledTimer 轮询 —— 本函数常在后台队列里跑，后台队列没有 run loop，
    // Timer 一次都不触发，只能干等到 90s 信号量超时才返回。用忙等最稳。
    let deadline = Date().addingTimeInterval(timeout)
    while t.isRunning && Date() < deadline {
        Thread.sleep(forTimeInterval: 0.3)
    }
    if t.isRunning {
        log("runShell timeout \(timeout)s -> 杀掉: \(cmd.prefix(60))")
        t.terminate()
    }
    t.waitUntilExit()
    let dt = Date().timeIntervalSince(t0)
    log("runShell 子进程已退出 用时=\(String(format: "%.1f", dt))s cmd=\(cmd.prefix(50))")

    let d = FileManager.default.contents(atPath: outPath) ?? Data()
    return String(data: d, encoding: .utf8) ?? ""
}

func fileMtime(_ path: String) -> Date? {
    guard FileManager.default.fileExists(atPath: path) else { return nil }
    return (try? FileManager.default.attributesOfItem(atPath: path)[.modificationDate] as? Date) ?? nil
}

/// 配置"最后被改"的时间：两处入口都算（agnes 有两份独立配置源）
func configMtime() -> Date? {
    let a = fileMtime(PATCH_FILE), b = fileMtime(SETTINGS)
    guard let x = a, let y = b else { return a ?? b }
    return x > y ? x : y
}

/// macOS 的 ps 没有 `etimes` 这个关键字（只有 Linux 有），写了会报
/// "ps: etimes: keyword not found" 且**只吐 pid + command 两列**，
/// 于是下游 "parts.count >= 3" 永远不成立 ⇒ 永远判"DSH 没起来" ⇒ 永远打不开 DSH。
/// macOS 用 `etime`，格式 `mm:ss` / `hh:mm:ss` / `dd-hh:mm:ss`。
func parseEtime(_ s: Substring) -> Double? {
    var secs: Double = 0
    var tok = s
    if let d = tok.split(separator: "-", omittingEmptySubsequences: true).first,
       tok.contains("-"), let days = Double(d) { secs += days * 86400; tok = tok.split(separator: "-").dropFirst().first ?? tok }
    let cols = tok.split(separator: ":", omittingEmptySubsequences: true)
    guard let last = cols.last, let second = Double(last) else { return nil }
    secs += second
    if cols.count >= 2, let m = Double(cols[cols.count - 2]) { secs += m * 60 }
    if cols.count >= 3, let h = Double(cols[cols.count - 3]) { secs += h * 3600 }
    return secs
}

/// DSH 主进程 pid + 已运行秒数。ago = -1 表示判断不了（宁可不重启，也不能乱杀维护者开着的东西）。
/// ⚠️ 历史坑串：① 早先用 `ps lstart` 解析日期 → split 吃双空格 ⇒ 只有 5 段 ⇒ 恒判"旧配置"狂杀 DSH；
///              ② 后来改 `etimes`（Linux 关键字，macOS 不认）⇒ 永远 nil ⇒ 永远打不开 DSH。
///              现在用 `etime` + parseEtime 自己算秒，不碰任何日期解析。
func dshInfo() -> (pid: Int, ago: Double)? {
    // 过滤 Helper：Electron 的 helper 进程路径里也含 Contents/MacOS/，混进来 pid 就不是主进程
    let out = runShell("ps -eo pid,etime,command | grep -i 'DeepSeek Harness' | grep -v grep | grep -v Helper | head -1")
    let parts = out.split(separator: " ", maxSplits: 2, omittingEmptySubsequences: true)
    guard parts.count >= 3, let pid = Int(parts[0]) else { return nil }
    guard let ago = parseEtime(parts[1]) else { return (pid, -1) }
    return (pid, ago)
}

/// 配置最后被改距今几秒；nil = 读不到
func configAgeSeconds() -> Double? {
    guard let cm = configMtime() else { return nil }
    return Date().timeIntervalSince(cm)
}

func healthOK() -> Bool {
    guard let url = URL(string: HEALTH) else { return false }
    var req = URLRequest(url: url); req.timeoutInterval = 3
    var ok = false
    let sem = DispatchSemaphore(value: 0)
    let task = URLSession.shared.dataTask(with: req) { _, resp, _ in
        if let r = resp as? HTTPURLResponse, r.statusCode == 200 { ok = true }
        sem.signal()
    }
    task.resume()
    _ = sem.wait(timeout: .now() + 4)
    log("health -> \(ok)")
    return ok
}

/// ⚠️ 别再从客户端调 `manage.sh start codex`：同样的命令在终端里 15 秒跑完，
/// 从 GUI 客户端的 bash 子进程里跑就会卡死（输出 0 字节、进程不退出，实测复现多次）。
/// 绕开 shell，客户端直接用 node 起 proxy.js，行为可控、日志自己能收。
func startBase() -> (ok: Bool, output: String) {
    if healthOK() { return (true, "底座本来就在跑") }
    guard FileManager.default.fileExists(atPath: PROXY_JS) else {
        log("startBase 缺 proxy.js: \(PROXY_JS)")
        return (false, "找不到 \(PROXY_JS)，请跑一次依赖安装")
    }

    let logDir = "\(NSHomeDirectory())/Library/Logs/MultiProxy-client"
    try? FileManager.default.createDirectory(atPath: logDir, withIntermediateDirectories: true)
    let logPath = "\(logDir)/codex-proxy.log"
    FileManager.default.createFile(atPath: logPath, contents: nil)
    guard let fh = FileHandle(forWritingAtPath: logPath) else {
        return (false, "打不开日志 \(logPath)")
    }

    let t = Process()
    t.launchPath = NODE
    t.arguments = ["proxy.js"]
    t.currentDirectoryPath = CODEX_DIR
    t.environment = childEnvironment()
    t.standardOutput = fh
    t.standardError = fh
    do {
        log("startBase: 起 node proxy.js（cwd=\(CODEX_DIR)）")
        try t.run()
    } catch {
        log("startBase 起 node 失败: \(error)")
        return (false, "起代理失败：\(error)")
    }

    var waited: TimeInterval = 0
    while waited < 45 {
        if healthOK() {
            log("startBase ok=true 用时 \(Int(waited))s")
            return (true, "底座已启动，日志：\(logPath)")
        }
        Thread.sleep(forTimeInterval: 2); waited += 2
        log("startBase 等 health \(Int(waited))s")
    }
    return (false, "等了 45 秒没起来，看日志 \(logPath)")
}

/// 这个 pid 还活着吗（kill 前必查，防误杀）
func pidAlive(_ pid: Int) -> Bool {
    runShell("ps -p \(pid) -o pid=").trimmingCharacters(in: .whitespacesAndNewlines).count > 0
}

/// 打开 DSH。返回是否真起来了。
/// ⚠️ 两个坑：
/// 1) `open -a '/全路径/xxx.app'`（带 -a 又给全路径）macOS 不认，会静默失败；
///    要么 `open '/全路径/xxx.app'`（直接给路径），要么 `open -a 'xxx'`（只给不带 .app 的名字）。
/// 2) Electron 冷启动要 15~25 秒，等 3 秒判断必然是「没起来」，必须轮询到 25 秒。
@discardableResult
func openDSHApp(pollSeconds: TimeInterval = 25) -> Bool {
    _ = runShell("open '/Applications/DeepSeek Harness.app' 2>/dev/null")
    var waited: TimeInterval = 0
    while waited < pollSeconds {
        sleep(2); waited += 2
        log("openDSHApp 等待进程 \(Int(waited))s")
        if dshInfo() != nil { return true }
    }
    return false
}

// MARK: - 应用委托
final class AppDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var statusLabel: NSTextField!
    var webView: WKWebView!
    var spinner: NSProgressIndicator!

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildUI()
        log("app launched")
        checkAndStart()
    }

    func buildUI() {
        let w = 1080, h = 760
        window = NSWindow(contentRect: NSRect(x: 260, y: 140, width: w, height: h),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                          backing: .buffered, defer: false)
        window.title = APP_NAME
        window.titlebarAppearsTransparent = true
        window.center()

        let content = NSView(frame: NSRect(x: 0, y: 0, width: w, height: h))
        window.contentView = content

        statusLabel = NSTextField(frame: NSRect(x: 20, y: h - 48, width: w - 60, height: 32))
        statusLabel.isBezeled = false
        statusLabel.drawsBackground = false
        statusLabel.isEditable = false
        statusLabel.isSelectable = false
        statusLabel.font = NSFont.systemFont(ofSize: 13, weight: .semibold)
        statusLabel.stringValue = "正在检查底座…"
        content.addSubview(statusLabel)

        spinner = NSProgressIndicator(frame: NSRect(x: w - 52, y: h - 42, width: 20, height: 20))
        spinner.style = .spinning
        spinner.startAnimation(nil)
        content.addSubview(spinner)

        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: w, height: h - 54))
        webView.autoresizingMask = [.width, .height]
        webView.isHidden = true
        content.addSubview(webView)

        buildMenu()
    }

    func buildMenu() {
        let appMenu = NSMenu()
        appMenu.addItem(NSMenuItem(title: "打开 DSH 客户端", action: #selector(openDSH), keyEquivalent: "d"))
        appMenu.addItem(NSMenuItem(title: "检查并启动底座", action: #selector(recheck), keyEquivalent: "r"))
        appMenu.addItem(NSMenuItem(title: "重新加载面板", action: #selector(reloadPanel), keyEquivalent: "R"))
        let agentItem = NSMenuItem(title: "开机自动启动本客户端", action: #selector(toggleAgent), keyEquivalent: "s")
        agentItem.state = FileManager.default.fileExists(atPath: AGENT_PLIST) ? .on : .off
        appMenu.addItem(agentItem)
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(NSMenuItem(title: "关于 \(APP_NAME)", action: #selector(about), keyEquivalent: ""))
        appMenu.addItem(NSMenuItem(title: "退出", action: #selector(quitApp), keyEquivalent: "q"))
        let appItem = NSMenuItem()
        appItem.submenu = appMenu
        let main = NSMenu()
        main.addItem(appItem)
        NSApp.mainMenu = main
    }

    /// 状态刷新一律回主线程（整套检查跑在后台队列里，setStatus 会被频繁调用）
    func setStatus(_ s: String, ok: Bool) {
        DispatchQueue.main.async {
            self.statusLabel.stringValue = s
            self.statusLabel.textColor = ok
                ? NSColor(red: 0.05, green: 0.55, blue: 0.25, alpha: 1)
                : .systemRed
            self.spinner.stopAnimation(nil)
            self.spinner.isHidden = true
        }
    }

    // MARK: 核心流程
    // 1) 底座没起就起；2) DSH 若还在跑旧配置（进程启动早于配置 mtime）就重启它；3) DSH 没开就给它开；4) 绿了才加载面板
    @objc func checkAndStart() {
        log("checkAndStart begin")
        // 先把窗口顶出来，别让维护者盯着桌面空白
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        spinner.startAnimation(nil); spinner.isHidden = false
        statusLabel.stringValue = "正在检查底座…"
        statusLabel.textColor = .labelColor
        webView.isHidden = true
        // 整套检查（起底座 / 等 DSH 冷启动）最长 40s+，绝不能占主线程，否则窗口一直白屏
        DispatchQueue.global(qos: .userInitiated).async { self.checkAndStartBody() }
    }

    func checkAndStartBody() {
        var msg = ""
        var okFlag = false

        if healthOK() {
            msg = "✅ 底座运行中（127.0.0.1:18790）"
            okFlag = true
        } else {
            setStatus("底座未运行，正在启动…", ok: true)
            let r = startBase()
            if healthOK() {
                msg = "✅ 底座已启动（127.0.0.1:18790）"
                if !r.output.isEmpty { msg += "\n" + trim(r.output, max: 160) }
                okFlag = true
            } else {
                msg = "❌ 底座启动失败。\n手动自查：cd \(PROXY_DIR) && bash ./manage.sh start codex"
                if !r.output.isEmpty { msg += "\n\n" + trim(r.output, max: 300) }
            }
        }

        // —— 判 DSH 是不是吃的旧配置：DSH 已跑秒数 < 配置改完至今秒数 = 旧 ——
        // 安全原则：判断不了就别动它，宁可不重启，也不能乱杀维护者开着的东西。
        guard let dsh = dshInfo() else {
            msg += openDSHApp() ? "\n已帮你打开 DSH 客户端 ✅" : "\n⚠️ DSH 没拉起来，请手动点开 DeepSeek Harness"
            finish(msg, ok: okFlag)
            return
        }

        let dshAgo = dsh.ago
        guard dshAgo >= 0, pidAlive(dsh.pid), let cfgAge = configAgeSeconds() else {
            log("dsh pid=\(dsh.pid) 时间算不出来 -> 不动它")
            msg += "\nDSH 在跑（判断不了新旧，没动它）"
            finish(msg, ok: okFlag)
            return
        }

        log("dsh pid=\(dsh.pid) ago=\(dshAgo)s configAge=\(cfgAge)s")
        if dshAgo < cfgAge {
            msg += "\nDSH 吃的是旧配置，正在重启…"
            setStatus(msg, ok: okFlag)
            _ = runShell("kill \(dsh.pid) >/dev/null 2>&1; sleep 3")
            log("killed dsh pid=\(dsh.pid)")
            let opened = openDSHApp()
            log("reopened dsh -> \(opened)")
            msg += opened
                ? "\nDSH 已用新配置重启 ✅"
                : "\n⚠️ 已重启 DSH 但没拉起来，请手动点开 DSH"
        } else {
            msg += "\nDSH 已加载新配置 ✅"
        }

        finish(msg, ok: okFlag)
    }

    func finish(_ msg: String, ok: Bool) {
        log("checkAndStart done: \(msg)")
        DispatchQueue.main.async {
            self.setStatusNow(msg, ok: ok)
            self.showPanel(ok: ok)
        }
    }

    func setStatusNow(_ s: String, ok: Bool) {
        statusLabel.stringValue = s
        statusLabel.textColor = ok
            ? NSColor(red: 0.05, green: 0.55, blue: 0.25, alpha: 1)
            : .systemRed
        spinner.stopAnimation(nil)
        spinner.isHidden = true
    }

    func showPanel(ok: Bool) {
        if ok {
            webView.isHidden = false
            webView.load(URLRequest(url: URL(string: DASHBOARD)!))
        }
    }

    @objc func recheck() { checkAndStart() }

    @objc func openDSH() {
        log("openDSH")
        DispatchQueue.global().async {
            if !healthOK() { _ = startBase() }
            _ = runShell("open '/Applications/DeepSeek Harness.app' 2>/dev/null")
            DispatchQueue.main.async {
                self.setStatusNow("已发指令打开 DSH（冷启动约 15~25 秒）", ok: true)
                self.window.makeKeyAndOrderFront(nil)
                NSApp.activate(ignoringOtherApps: true)
            }
        }
    }

    @objc func reloadPanel() {
        if healthOK() { webView.load(URLRequest(url: URL(string: DASHBOARD)!)) }
        else { checkAndStart() }
    }

    @objc func quitApp() { NSApplication.shared.terminate(nil) }

    @objc func toggleAgent() {
        let fm = FileManager.default
        if fm.fileExists(atPath: AGENT_PLIST) {
            _ = runShell("launchctl unload '\(AGENT_PLIST)' 2>/dev/null; rm -f '\(AGENT_PLIST)'")
            setStatus("已关闭开机自动启动", ok: true)
        } else {
            try? fm.createDirectory(atPath: LAUNCHDIR, withIntermediateDirectories: true)
            let plist = """
            <?xml version="1.0" encoding="UTF-8"?>
            <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
            <plist version="1.0">
            <dict>
              <key>Label</key><string>\(AGENT_ID)</string>
              <key>ProgramArguments</key>
              <array><string>open</string><string>-a</string><string>MultiProxy</string></array>
              <key>RunAtLoad</key><true/>
              <key>KeepAlive</key><false/>
              <key>ProcessType</key><string>Background</string>
            </dict>
            </plist>
            """
            do {
                try plist.write(toFile: AGENT_PLIST, atomically: true, encoding: .utf8)
                _ = runShell("launchctl load '\(AGENT_PLIST)' 2>&1")
                setStatus("已开启开机自动启动（下次登录生效）", ok: true)
            } catch {
                setStatus("写 LaunchAgent 失败：\(error.localizedDescription)", ok: false)
            }
        }
        buildMenu()
    }

    @objc func about() {
        let a = NSAlert()
        a.messageText = "\(APP_NAME)"
        a.informativeText = """
        双击本客户端 = 起本地底座 + 打开管理面板 + 保证 DSH 用的是新配置。

        底座跑在 127.0.0.1:18790，DSH 桌面端的 agnes 已指向它，不需要再敲任何命令。

        日常路径：双击 MultiProxy → 状态条变绿 → 回 DSH 直接发话。
        """
        a.addButton(withTitle: "好")
        a.runModal()
    }

    func trim(_ s: String, max: Int) -> String {
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.count > max ? String(t.prefix(max)) + "…" : t
    }
}

// MARK: - main
let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
