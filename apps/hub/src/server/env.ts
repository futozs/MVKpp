/**
 * A hub beállításai — mind környezeti változóból (infra/.env, docker-compose).
 * Csak szerveroldalon importálható.
 */

const num = (v: string | undefined, d: number) => (v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);
const trimUrl = (v: string | undefined, d: string) => (v ?? d).replace(/\/+$/, "");

export const env = {
  /** a worker belső címe (Compose-ban: http://worker:8090) */
  workerUrl: trimUrl(process.env.WORKER_URL, "http://127.0.0.1:8090"),
  /** a web belső címe (Compose-ban: http://web:3000) */
  webUrl: trimUrl(process.env.WEB_URL, "http://127.0.0.1:3000"),
  /** a nyilvános cím a Caddyn át (opcionális — ezt is méri a hub) */
  publicUrl: process.env.DOMAIN ? `https://${process.env.DOMAIN}` : trimUrl(process.env.PUBLIC_URL, ""),
  adminKey: process.env.ADMIN_KEY ?? "",
  /** a web csak-olvasó metrika-kulcsa (X-Metrics-Key) */
  metricsKey: process.env.METRICS_KEY ?? "",
  password: process.env.HUB_PASSWORD ?? "",
  sessionHours: num(process.env.HUB_SESSION_HOURS, 12),
  /** vesszővel elválasztott CIDR-lista; alapból csak magánhálózat + loopback + VPN-tartományok */
  allowedCidrs: (process.env.HUB_ALLOWED_CIDRS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  /** a hub nevei (Host fejléc), ha nem IP-címmel éred el; IP és localhost mindig mehet (DNS-rebinding ellen) */
  allowedHosts: (process.env.HUB_ALLOWED_HOSTS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  dockerSock: process.env.DOCKER_SOCK ?? "/var/run/docker.sock",
  composeProject: process.env.COMPOSE_PROJECT ?? "mvk",
  /** a repó a konténerben (a telepítéshez és a git-állapothoz) */
  repoDir: process.env.HUB_REPO_DIR ?? "/repo",
  composeFile: process.env.HUB_COMPOSE_FILE ?? "infra/docker-compose.yml",
  composeEnvFile: process.env.HUB_COMPOSE_ENV ?? "infra/.env",
  gitToken: process.env.HUB_GIT_TOKEN ?? "",
  backupDir: process.env.HUB_BACKUP_DIR ?? "/backups",
  backupKeep: num(process.env.HUB_BACKUP_KEEP, 7),
  /** napi automatikus mentés órája (Budapest), -1: kikapcsolva */
  backupHour: num(process.env.HUB_BACKUP_HOUR, 4),
  /** ha nincs Docker (fejlesztés), ez a konténer-név / pg_dump helyett a helyi pg_dump fut */
  dbContainer: process.env.HUB_DB_CONTAINER ?? "",
  probeEveryMs: num(process.env.HUB_PROBE_MS, 30_000),
} as const;

export const MIN_PASSWORD = 12;

export function configProblems(): string[] {
  const out: string[] = [];
  if (env.password.length < MIN_PASSWORD) out.push(`HUB_PASSWORD hiányzik vagy rövidebb ${MIN_PASSWORD} karakternél — a belépés le van tiltva.`);
  if (!env.adminKey) out.push("ADMIN_KEY hiányzik — a worker vezérlése nem működik.");
  if (!env.metricsKey) out.push("METRICS_KEY hiányzik — a web válaszidői nem látszanak.");
  return out;
}
