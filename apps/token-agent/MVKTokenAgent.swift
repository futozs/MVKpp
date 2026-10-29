// MVK token-agent — macOS.
//
// A Mac-en futó (App Store-os) MVK MobilON+ app saját tokenjét olvassa ki a
// plistjéből, és HMAC-aláírt kéréssel felküldi a VPS-re. Ha a szerveren lévő
// token hamarosan lejár, vagy az MVK elutasította, újraindítja az appot
// (az app így újra-attesztál és friss tokent kér), majd újra kiolvassa.
//
// Semmit nem tör fel: a saját app saját tokenjét használja, amit az app maga
// ment el. A konténer olvasásához ennek a binárisnak „Teljes lemezhozzáférés”
// kell (Rendszerbeállítások → Adatvédelem és biztonság) — csak neki, nem a
// teljes shellnek.
//
// Fordítás:   swiftc -O MVKTokenAgent.swift -o mvk-token-agent
// Futtatás:   mvk-token-agent run      (folyamatos, launchd alól)
//             mvk-token-agent once     (egy kör, teszteléshez)
//             mvk-token-agent status   (helyi token állapota, küldés nélkül)

import AppKit
import CryptoKit
import Foundation

struct Config: Codable {
    var serverUrl: String
    var agentSecret: String
    var agentId: String
    var bundleId: String = "com.hclinear.metaccazeMiskolc"
    /// Ennyi óránál kevesebb hátralévő érvénynél frissítünk (a token ~9 órás).
    var refreshBelowHours: Double = 3.5
    var checkEveryMinutes: Double = 10
    var restartCooldownMinutes: Double = 30
    var appWarmupSeconds: Double = 75
}

let configDir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/MVKTokenAgent")
let configPath = configDir.appendingPathComponent("config.json")

func log(_ msg: String) {
    let f = ISO8601DateFormatter()
    f.timeZone = TimeZone(identifier: "Europe/Budapest")
    print("\(f.string(from: Date())) \(msg)")
    fflush(stdout)
}

func loadConfig() -> Config {
    guard let data = try? Data(contentsOf: configPath), var cfg = try? JSONDecoder().decode(Config.self, from: data) else {
        log("HIBA: nincs vagy hibás konfiguráció: \(configPath.path) (futtasd az install.sh-t)")
        exit(2)
    }
    cfg.serverUrl = cfg.serverUrl.trimmingCharacters(in: CharacterSet(charactersIn: "/ "))
    return cfg
}

// MARK: - token a plistből

struct Token {
    let jwt: String
    let exp: Double
    let installationId: String?
}

func claims(_ jwt: String) -> [String: Any] {
    let parts = jwt.split(separator: ".")
    guard parts.count == 3 else { return [:] }
    var b64 = String(parts[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    while b64.count % 4 != 0 { b64 += "=" }
    guard let data = Data(base64Encoded: b64), let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
    return obj
}

/// Az app tokenje: a plist bármely mélységében lévő, legkésőbb lejáró JWT.
func readToken(_ cfg: Config) -> Token? {
    let home = FileManager.default.homeDirectoryForCurrentUser
    let candidates = [
        home.appendingPathComponent("Library/Containers/\(cfg.bundleId)/Data/Library/Preferences/\(cfg.bundleId).plist"),
        home.appendingPathComponent("Library/Preferences/\(cfg.bundleId).plist"),
    ]
    var best: Token?
    for url in candidates {
        guard let data = try? Data(contentsOf: url) else { continue }
        guard let plist = try? PropertyListSerialization.propertyList(from: data, options: [], format: nil) else { continue }
        var strings: [String] = []
        func walk(_ v: Any) {
            if let s = v as? String { strings.append(s) }
            else if let d = v as? [String: Any] { d.values.forEach(walk) }
            else if let a = v as? [Any] { a.forEach(walk) }
            else if let d = v as? Data, let s = String(data: d, encoding: .utf8) { strings.append(s) }
        }
        walk(plist)
        let re = try! NSRegularExpression(pattern: #"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+"#)
        for s in strings {
            for m in re.matches(in: s, range: NSRange(s.startIndex..., in: s)) {
                guard let r = Range(m.range, in: s) else { continue }
                let jwt = String(s[r])
                let c = claims(jwt)
                guard let exp = (c["exp"] as? NSNumber)?.doubleValue else { continue }
                if best == nil || exp > best!.exp {
                    best = Token(jwt: jwt, exp: exp, installationId: c["installation-id"] as? String)
                }
            }
        }
    }
    return best
}

func plistReadable(_ cfg: Config) -> Bool {
    let url = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Containers/\(cfg.bundleId)/Data/Library/Preferences/\(cfg.bundleId).plist")
    return FileManager.default.isReadableFile(atPath: url.path) && (try? Data(contentsOf: url)) != nil
}

// MARK: - szerver

func sign(_ secret: String, _ ts: Int, _ body: String) -> String {
    let key = SymmetricKey(data: Data(secret.utf8))
    let mac = HMAC<SHA256>.authenticationCode(for: Data("\(ts).\(body)".utf8), using: key)
    return mac.map { String(format: "%02x", $0) }.joined()
}

func post(_ cfg: Config, _ path: String, _ payload: [String: Any]) -> (Int, [String: Any]) {
    guard let url = URL(string: cfg.serverUrl + path), let body = try? JSONSerialization.data(withJSONObject: payload), let bodyStr = String(data: body, encoding: .utf8) else {
        return (0, [:])
    }
    let ts = Int(Date().timeIntervalSince1970)
    var req = URLRequest(url: url, timeoutInterval: 20)
    req.httpMethod = "POST"
    req.httpBody = body
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.setValue(String(ts), forHTTPHeaderField: "X-Agent-Ts")
    req.setValue(sign(cfg.agentSecret, ts, bodyStr), forHTTPHeaderField: "X-Agent-Signature")
    req.setValue(cfg.agentId, forHTTPHeaderField: "X-Agent-Id")
    let sem = DispatchSemaphore(value: 0)
    var out: (Int, [String: Any]) = (0, [:])
    URLSession.shared.dataTask(with: req) { data, resp, err in
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        let obj = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
        if let err { log("hálózati hiba: \(err.localizedDescription)") }
        out = (code, obj)
        sem.signal()
    }.resume()
    sem.wait()
    return out
}

// MARK: - app

func appRunning(_ cfg: Config) -> Bool {
    !NSRunningApplication.runningApplications(withBundleIdentifier: cfg.bundleId).isEmpty
}

func restartApp(_ cfg: Config) {
    log("az MVK app újraindítása (friss token kérése)…")
    for app in NSRunningApplication.runningApplications(withBundleIdentifier: cfg.bundleId) {
        _ = app.terminate()
    }
    Thread.sleep(forTimeInterval: 4)
    for app in NSRunningApplication.runningApplications(withBundleIdentifier: cfg.bundleId) {
        _ = app.forceTerminate()
    }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    p.arguments = ["-g", "-b", cfg.bundleId] // -g: a háttérben, nem lopja el a fókuszt
    do { try p.run(); p.waitUntilExit() } catch { log("az app nem indítható: \(error.localizedDescription)") }
    Thread.sleep(forTimeInterval: cfg.appWarmupSeconds)
}

// MARK: - egy kör

var lastRestart = Date.distantPast

func cycle(_ cfg: Config) {
    let now = Date().timeIntervalSince1970
    let info: [String: Any] = ["host": Host.current().localizedName ?? "mac", "appRunning": appRunning(cfg), "plistReadable": plistReadable(cfg)]
    let (code, status) = post(cfg, "/agent/status", ["agentId": cfg.agentId, "info": info])
    if code != 200 {
        log("a szerver nem elérhető vagy elutasított (/agent/status → HTTP \(code)) — ellenőrizd a serverUrl-t és az agentSecret-et")
    }
    let serverLeft = (status["expiresInSec"] as? NSNumber)?.doubleValue ?? -1
    let rejected = (status["rejected"] as? Bool) ?? false
    let threshold = cfg.refreshBelowHours * 3600

    var local = readToken(cfg)
    if local == nil && !plistReadable(cfg) {
        log("a plist nem olvasható — adj Teljes lemezhozzáférést ennek a binárisnak: \(CommandLine.arguments[0])")
    }
    let localLeft = (local?.exp ?? 0) - now

    // Kell-e új token az apptól: a helyi is lejár hamarosan, vagy az MVK elutasította.
    let needAppRefresh = local == nil || localLeft < threshold || (rejected && local != nil && serverLeft > 0 && abs(localLeft - serverLeft) < 120)
    if needAppRefresh && Date().timeIntervalSince(lastRestart) > cfg.restartCooldownMinutes * 60 {
        lastRestart = Date()
        restartApp(cfg)
        local = readToken(cfg)
    } else if !appRunning(cfg) {
        // Az app fusson a háttérben, hogy magától is frissíthesse a tokenjét.
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        p.arguments = ["-g", "-b", cfg.bundleId]
        try? p.run()
    }

    guard let tok = local else {
        log("nincs token a plistben — nyisd meg egyszer kézzel az MVK appot")
        return
    }
    let left = tok.exp - now
    // Csak akkor küldjük, ha a szerveren nincs token, vagy a miénk később jár le.
    if code == 200 && serverLeft > 0 && left <= serverLeft + 60 && !rejected {
        return
    }
    var payload: [String: Any] = ["jwt": tok.jwt, "agentId": cfg.agentId, "info": info]
    if let inst = tok.installationId { payload["installationId"] = inst }
    let (c2, r2) = post(cfg, "/agent/token", payload)
    if c2 == 200 {
        log("token elküldve, \(Int(left / 60)) percig érvényes")
    } else {
        log("a token küldése sikertelen: HTTP \(c2) \(r2["error"] ?? "")")
    }
}

// MARK: - belépési pont

let mode = CommandLine.arguments.dropFirst().first ?? "run"
let cfg = loadConfig()
switch mode {
case "status":
    if let t = readToken(cfg) {
        log("helyi token: \(Int((t.exp - Date().timeIntervalSince1970) / 60)) perc van hátra, installation-id: \(t.installationId ?? "?")")
    } else {
        log("nincs olvasható token (plist olvasható: \(plistReadable(cfg)))")
    }
case "once":
    cycle(cfg)
default:
    log("MVK token-agent fut — szerver: \(cfg.serverUrl), ellenőrzés \(Int(cfg.checkEveryMinutes)) percenként")
    while true {
        cycle(cfg)
        Thread.sleep(forTimeInterval: cfg.checkEveryMinutes * 60)
    }
}
