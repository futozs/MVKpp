// MVK token-agent  macOS.
//
// 2-es protokoll: a rendszer-hubból parancsot is fogad (az /agent/status
// válaszában): az MVK app újraindítása, a token azonnali küldése, vagy az agent
// újraindítása. A szerver kérésére fél percenként jelentkezik, így a parancs
// gyorsan célba ér; az eredményt /agent/ack-kal jelenti.
//
// A Mac-en futó (App Store-os) MVK MobilON+ app saját tokenjét olvassa ki a
// plistjéből, és HMAC-aláírt kéréssel felküldi a VPS-re. Ha a szerveren lévő
// token hamarosan lejár, vagy az MVK elutasította, újraindítja az appot
// (az app így újra-attesztál és friss tokent kér), majd újra kiolvassa.
//
// Semmit nem tör fel: a saját app saját tokenjét használja, amit az app maga
// ment el. A konténer olvasásához ennek a binárisnak „Teljes lemezhozzáférés”
// kell (Rendszerbeállítások → Adatvédelem és biztonság)  csak neki, nem a
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

/// Az MVK app indítása a háttérben; visszaadja, hogy az `open` sikerült-e.
@discardableResult
func openApp(_ cfg: Config) -> Bool {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    p.arguments = ["-g", "-b", cfg.bundleId] // -g: a háttérben, nem lopja el a fókuszt
    do {
        try p.run()
        p.waitUntilExit()
    } catch {
        log("az app nem indítható: \(error.localizedDescription)")
        return false
    }
    if p.terminationStatus != 0 { log("az app nem indítható: open → \(p.terminationStatus)") }
    return p.terminationStatus == 0
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
    openApp(cfg)
    Thread.sleep(forTimeInterval: cfg.appWarmupSeconds)
}

// MARK: - parancsnapló

/// A hubból kapott parancs a lemezen: végrehajtás előtt beírjuk, az eredményt
/// mellé tesszük, és csak a sikeres /agent/ack után töröljük. Így ha az agent a
/// parancs közben leáll, vagy a nyugta nem jut át, a következő futás pótolja.
struct PendingCommand: Codable {
    let id: Int
    let kind: String
    let startedAt: Date
    /// nil: még fut (vagy az előző agent közben leállt)
    let ok: Bool?
    let note: String?

    func closed(ok: Bool, note: String) -> PendingCommand {
        PendingCommand(id: id, kind: kind, startedAt: startedAt, ok: ok, note: note)
    }
}

let pendingPath = configDir.appendingPathComponent("pending-commands.json")

func loadPending() -> [PendingCommand] {
    guard let data = try? Data(contentsOf: pendingPath) else { return [] }
    do {
        return try JSONDecoder().decode([PendingCommand].self, from: data)
    } catch {
        log("a parancsnapló hibás, eldobom: \(error.localizedDescription)")
        return []
    }
}

func savePending(_ list: [PendingCommand]) {
    do {
        if list.isEmpty {
            if FileManager.default.fileExists(atPath: pendingPath.path) { try FileManager.default.removeItem(at: pendingPath) }
        } else {
            try JSONEncoder().encode(list).write(to: pendingPath, options: .atomic)
        }
    } catch {
        log("a parancsnapló nem írható: \(error.localizedDescription)")
    }
}

func beginCommand(_ id: Int, _ kind: String) {
    savePending(loadPending().filter { $0.id != id } + [PendingCommand(id: id, kind: kind, startedAt: Date(), ok: nil, note: nil)])
}

func finishCommand(_ cfg: Config, _ id: Int, ok: Bool, note: String) {
    savePending(loadPending().map { $0.id == id ? $0.closed(ok: ok, note: note) : $0 })
    flushAcks(cfg)
}

/// A lezárt, de még nem nyugtázott parancsok elküldése; ami átment, kikerül a naplóból.
func flushAcks(_ cfg: Config) {
    let list = loadPending()
    let unacked = list.filter { p in
        guard let ok = p.ok else { return true }
        let (code, _) = post(cfg, "/agent/ack", ["id": p.id, "ok": ok, "note": p.note ?? ""])
        if code != 200 { log("a #\(p.id) parancs nyugtája nem ment át (HTTP \(code)), a következő körben újra") }
        return code != 200
    }
    if unacked.count != list.count { savePending(unacked) }
}

/// Indításkor: az eredmény nélkül maradt parancs végrehajtása közben állt le az
/// előző agent. Lezárjuk, restart-app után pedig gondoskodunk róla, hogy az app fusson.
func recoverInterruptedCommands(_ cfg: Config) {
    let list = loadPending()
    guard list.contains(where: { $0.ok == nil }) else { return }
    savePending(list.map { p in
        guard p.ok == nil else { return p }
        log("a #\(p.id) \(p.kind) parancs közben leállt az agent  lezárom")
        guard p.kind == "restart-app" else {
            return p.closed(ok: false, note: "megszakadt: az agent leállt a végrehajtás közben")
        }
        // a cooldown az újraindulás után is számítson
        lastRestart = max(lastRestart, p.startedAt)
        let apps = NSRunningApplication.runningApplications(withBundleIdentifier: cfg.bundleId)
        if apps.isEmpty {
            return openApp(cfg)
                ? p.closed(ok: true, note: "az agent leállt a parancs közben, az app bezárva maradt  újraindulás után elindítva")
                : p.closed(ok: false, note: "az agent leállt a parancs közben, az app bezárva maradt, és nem indítható")
        }
        guard let launched = apps.compactMap(\.launchDate).max() else {
            return p.closed(ok: true, note: "az agent leállt a parancs közben; az app fut, de az újraindulása nem ellenőrizhető")
        }
        return launched >= p.startedAt
            ? p.closed(ok: true, note: "az agent leállt a parancs közben, de az app újraindult")
            : p.closed(ok: false, note: "megszakadt, mielőtt az app újraindult volna (a régi példány fut)  kérd újra")
    })
}

// MARK: - egy kör

/// Az agent protokoll-verziója: 2-től fogad parancsot a rendszer-hubból (/agent/status → command).
let agentVersion = 2
var lastRestart = Date.distantPast
/// A szerver kérése, hogy mikor jelentkezzünk újra (a hubból kért parancs így fél percen belül célba ér).
var serverPollSeconds: Double? = nil
/// Egymás utáni sikertelen /agent/status-ok (gépindításkor a Docker stack még nem fut).
var failedPolls = 0
/// Sikertelen kör után ennyi mp múlva próbáljuk újra, minden hibánál duplázva, legfeljebb `retryMaxSeconds`-ig.
let retryBaseSeconds = 15.0
let retryMaxSeconds = 120.0

func iso(_ d: Date) -> String {
    d == Date.distantPast ? "" : ISO8601DateFormatter().string(from: d)
}

/// A hubból érkező parancs végrehajtása; az eredményt /agent/ack-kal jelentjük.
/// Visszaadja, hogy a tokent mindenképp el kell-e küldeni ebben a körben.
func runCommand(_ cfg: Config, _ cmd: [String: Any], local: inout Token?) -> Bool {
    guard let id = (cmd["id"] as? NSNumber)?.intValue, let kind = cmd["kind"] as? String else { return false }
    log("parancs a hubból: #\(id) \(kind)")
    beginCommand(id, kind)
    switch kind {
    case "restart-app":
        lastRestart = Date()
        restartApp(cfg)
        local = readToken(cfg)
        let left = local.map { Int(($0.exp - Date().timeIntervalSince1970) / 60) }
        finishCommand(cfg, id, ok: local != nil, note: local != nil ? "az app újraindult, a token \(left ?? 0) percig érvényes" : "az app újraindult, de nincs olvasható token")
        return true
    case "send-token":
        local = readToken(cfg)
        finishCommand(cfg, id, ok: local != nil, note: local != nil ? "token elküldve" : "nincs olvasható token a plistben")
        return true
    case "restart-agent":
        finishCommand(cfg, id, ok: true, note: "az agent újraindul (launchd)")
        log("újraindulás a hub kérésére")
        exit(0)
    default:
        finishCommand(cfg, id, ok: false, note: "ismeretlen parancs: \(kind)")
        return false
    }
}

func cycle(_ cfg: Config) {
    let now = Date().timeIntervalSince1970
    var local = readToken(cfg)
    var info: [String: Any] = [
        "host": Host.current().localizedName ?? "mac",
        "appRunning": appRunning(cfg),
        "plistReadable": plistReadable(cfg),
        "version": agentVersion,
        "macos": ProcessInfo.processInfo.operatingSystemVersionString,
        "lastRestartAt": iso(lastRestart),
    ]
    if let t = local { info["localTokenLeftSec"] = Int(t.exp - now) }
    let (code, status) = post(cfg, "/agent/status", ["agentId": cfg.agentId, "info": info])
    if code == 200 {
        failedPolls = 0
        serverPollSeconds = (status["nextCheckSec"] as? NSNumber)?.doubleValue
        flushAcks(cfg)
    } else {
        // Ne a teljes checkEveryMinutes-t várjuk ki: gépindításkor az agent a szerver előtt indul.
        failedPolls += 1
        let retry = min(retryMaxSeconds, retryBaseSeconds * pow(2, Double(failedPolls - 1)))
        serverPollSeconds = retry
        let why = code == 0
            ? "a szerver nem érhető el (még nem indult el, vagy rossz a serverUrl)"
            : "a szerver elutasította (HTTP \(code))  ellenőrizd a serverUrl-t és az agentSecret-et"
        log("/agent/status: \(why); újrapróbálás \(Int(retry)) mp múlva")
    }
    let serverLeft = (status["expiresInSec"] as? NSNumber)?.doubleValue ?? -1
    let rejected = (status["rejected"] as? Bool) ?? false
    let threshold = cfg.refreshBelowHours * 3600

    var forceSend = false
    if let cmd = status["command"] as? [String: Any] {
        forceSend = runCommand(cfg, cmd, local: &local)
    }

    if local == nil && !plistReadable(cfg) {
        log("a plist nem olvasható  adj Teljes lemezhozzáférést ennek a binárisnak: \(CommandLine.arguments[0])")
    }
    let localLeft = (local?.exp ?? 0) - now

    // Kell-e új token az apptól: a helyi is lejár hamarosan, vagy az MVK elutasította.
    let needAppRefresh = local == nil || localLeft < threshold || (rejected && local != nil && serverLeft > 0 && abs(localLeft - serverLeft) < 120)
    if !forceSend && needAppRefresh && Date().timeIntervalSince(lastRestart) > cfg.restartCooldownMinutes * 60 {
        lastRestart = Date()
        restartApp(cfg)
        local = readToken(cfg)
    } else if !appRunning(cfg) {
        // Az app fusson a háttérben, hogy magától is frissíthesse a tokenjét.
        openApp(cfg)
    }

    guard let tok = local else {
        log("nincs token a plistben  nyisd meg egyszer kézzel az MVK appot")
        return
    }
    let left = tok.exp - Date().timeIntervalSince1970
    // Csak akkor küldjük, ha a szerveren nincs token, vagy a miénk később jár le (kivéve: a hub kérte).
    if !forceSend && code == 200 && serverLeft > 0 && left <= serverLeft + 60 && !rejected {
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

/// A következő kör ideje: a beállítás a felső határ, a szerver kérhet sűrűbbet (legalább 10 mp).
func nextSleepSeconds(_ cfg: Config) -> Double {
    let configured = cfg.checkEveryMinutes * 60
    guard let hint = serverPollSeconds, hint > 0 else { return configured }
    return max(10, min(configured, hint))
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
    recoverInterruptedCommands(cfg)
    cycle(cfg)
default:
    log("MVK token-agent fut  szerver: \(cfg.serverUrl), ellenőrzés \(Int(cfg.checkEveryMinutes)) percenként")
    recoverInterruptedCommands(cfg)
    while true {
        cycle(cfg)
        Thread.sleep(forTimeInterval: nextSleepSeconds(cfg))
    }
}
