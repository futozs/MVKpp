"use client";
import { Archive, Download, History, Trash2, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { bytes, dateTime, duration, ago } from "@/lib/format";
import { useAction, useHub, useNow } from "@/lib/hooks";
import type { BackupMeta, Disk, TaskInfo } from "@/lib/types";
import { PageHeader } from "../shell/Shell";
import { ConfirmDialog } from "../ui/dialog";
import { Button, Empty, ErrorNote, Input, KeyValue, Loading, Meter, Panel, Pill, type Tone } from "../ui/primitives";
import { TaskConsole } from "./TaskConsole";

type Backups = { backups: BackupMeta[]; disk: Disk; running: TaskInfo | null; schedule: { hour: number; keep: number }; dockerAvailable: boolean; dir: string };

const KIND: Record<BackupMeta["kind"], { label: string; tone: Tone }> = {
  auto: { label: "napi", tone: "idle" },
  manual: { label: "kézi", tone: "info" },
  "pre-restore": { label: "visszaállítás előtti", tone: "warn" },
  upload: { label: "feltöltött", tone: "info" },
};

const RESTORE_CONFIRM = "VISSZAÁLLÍT";

export function BackupsPage() {
  const { data, error, isLoading, refetch } = useHub<Backups>("/api/backups", 15_000);
  const now = useNow(30_000);
  const { busy, run } = useAction();
  const [note, setNote] = useState("");
  const [taskId, setTaskId] = useState<string | null>(null);
  const [restore, setRestore] = useState<BackupMeta | null>(null);
  const [remove, setRemove] = useState<BackupMeta | null>(null);
  const [safety, setSafety] = useState(true);
  const [keepOld, setKeepOld] = useState(false);
  const [uploading, setUploading] = useState<number | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  if (isLoading) return <Loading />;
  if (!data) return <ErrorNote error={error} />;
  const activeTask = taskId ?? data.running?.id ?? null;

  const create = async () => {
    const r = await run<{ taskId: string }>("create", "/api/backups", { note: note || undefined });
    if (r) {
      setTaskId(r.taskId);
      setNote("");
    }
  };

  const upload = (file: File) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `/upload/backup?name=${encodeURIComponent(file.name)}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && setUploading(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => {
      setUploading(null);
      if (xhr.status >= 200 && xhr.status < 300) {
        toast.success("a mentés feltöltve");
        void refetch();
      } else toast.error((() => { try { return JSON.parse(xhr.responseText).error; } catch { return `HTTP ${xhr.status}`; } })());
    };
    xhr.onerror = () => {
      setUploading(null);
      toast.error("a feltöltés megszakadt");
    };
    setUploading(0);
    xhr.send(file);
  };

  return (
    <>
      <PageHeader
        title="Mentések"
        lead={`Teljes adatbázis-mentés (pg_dump, az adatbázis saját konténerében — a TimescaleDB-verzió mindig egyezik). Napi automatikus mentés ${data.schedule.hour >= 0 ? `${data.schedule.hour}:00 körül, az utolsó ${data.schedule.keep} marad` : "kikapcsolva"}. A fájlok a gépen: data/backups.`}
        actions={
          <>
            <input ref={fileInput} type="file" accept=".dump" className="hidden" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
            <Button size="sm" icon={<Upload className="h-3.5 w-3.5" />} busy={uploading != null} onClick={() => fileInput.current?.click()}>
              {uploading != null ? `feltöltés ${uploading}%` : "Mentés feltöltése"}
            </Button>
          </>
        }
      />
      {!data.dockerAvailable ? <ErrorNote className="mb-5" error="A mentéshez a hubnak látnia kell a Dockert (vagy HUB_DB_CONTAINER-t). Fejlesztéskor ez normális." /> : null}

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <Panel title="Új mentés most" className="xl:col-span-2">
          <div className="flex flex-wrap gap-2">
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="megjegyzés (pl. „frissítés előtt”)" className="min-w-[220px] flex-1" maxLength={200} />
            <Button variant="primary" icon={<Archive className="h-3.5 w-3.5" />} busy={busy === "create"} disabled={Boolean(data.running) || !data.dockerAvailable} onClick={() => void create()}>
              Mentés készítése
            </Button>
          </div>
          {data.running && !taskId ? <p className="mt-2 text-xs text-nosignal">Épp fut: {data.running.title}</p> : null}
          {activeTask ? <TaskConsole className="mt-4" taskId={activeTask} onDone={() => void refetch()} /> : null}
        </Panel>
        <Panel title="Lemez">
          {data.disk ? (
            <>
              <div className="mb-1 flex justify-between gap-3 text-xs text-muted-foreground">
                <span className="truncate" title={data.disk.path}>
                  {data.disk.path}
                </span>
                <span className="font-mono">{data.disk.usedPct}%</span>
              </div>
              <Meter value={data.disk.usedPct} tone={data.disk.usedPct >= 90 ? "crit" : data.disk.usedPct >= 80 ? "warn" : "ok"} label="lemez" />
              <KeyValue className="mt-3" rows={[["szabad", `${data.disk.freeGb} GB`], ["összesen", `${data.disk.totalGb} GB`], ["mentések", bytes(data.backups.reduce((a, b) => a + b.bytes, 0))]]} />
            </>
          ) : (
            <p className="text-xs text-muted-foreground">A mentési mappa ({data.dir}) nem elérhető.</p>
          )}
        </Panel>
      </div>

      <Panel title={`${data.backups.length} mentés`} className="mt-5">
        {data.backups.length ? (
          <ul className="divide-y divide-border">
            {data.backups.map((b) => (
              <li key={b.name} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[12.5px] font-semibold">{b.name}</span>
                    <Pill tone={KIND[b.kind]?.tone ?? "idle"}>{KIND[b.kind]?.label ?? b.kind}</Pill>
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {dateTime(b.createdAt)} ({ago(b.createdAt, now)}) · {bytes(b.bytes)}
                    {b.dbBytes ? ` · az adatbázis ekkor ${bytes(b.dbBytes)}` : ""}
                    {b.durationMs ? ` · ${duration(b.durationMs / 1000)}` : ""}
                    {b.note ? ` · ${b.note}` : ""}
                  </div>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <a href={`/api/backups/${encodeURIComponent(b.name)}/download`} download>
                    <Button size="sm" variant="ghost" icon={<Download className="h-3.5 w-3.5" />}>
                      Letöltés
                    </Button>
                  </a>
                  <Button size="sm" icon={<History className="h-3.5 w-3.5" />} disabled={Boolean(data.running) || !data.dockerAvailable} onClick={() => setRestore(b)}>
                    Visszaállítás
                  </Button>
                  <Button size="sm" variant="ghost" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => setRemove(b)} aria-label="törlés" />
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>Még nincs mentés. Készíts egyet most — a napi automatikus is ide kerül.</Empty>
        )}
      </Panel>

      <ConfirmDialog
        open={restore != null}
        onOpenChange={(o) => !o && setRestore(null)}
        danger
        title="Adatbázis visszaállítása"
        description={
          <>
            A <span className="font-mono text-foreground">{restore?.name}</span> állapota kerül vissza. A worker és a web leáll a művelet idejére (pár perc kiesés). A mostani adatbázist nem törli azonnal: félreállítja, és ha bármi hibázik, automatikusan visszaállítja.
          </>
        }
        confirmLabel="Visszaállítás"
        requireText={RESTORE_CONFIRM}
        onConfirm={async (typed) => {
          if (!restore) return;
          const r = await run<{ taskId: string }>("restore", `/api/backups/${encodeURIComponent(restore.name)}/restore`, { confirm: typed, safetyBackup: safety, keepOld });
          if (r) setTaskId(r.taskId);
        }}
      >
        <label className="flex items-start gap-2 text-[13px]">
          <input type="checkbox" checked={safety} onChange={(e) => setSafety(e.target.checked)} className="mt-0.5 accent-[hsl(var(--primary))]" />
          <span>
            Előtte biztonsági mentés a mostani állapotról <span className="text-muted-foreground">(ajánlott)</span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-[13px]">
          <input type="checkbox" checked={keepOld} onChange={(e) => setKeepOld(e.target.checked)} className="mt-0.5 accent-[hsl(var(--primary))]" />
          <span>
            A régi adatbázis maradjon meg félreállítva <span className="text-muted-foreground">(dupla lemezhely)</span>
          </span>
        </label>
      </ConfirmDialog>
      <ConfirmDialog
        open={remove != null}
        onOpenChange={(o) => !o && setRemove(null)}
        danger
        title="Mentés törlése"
        description={`${remove?.name} (${bytes(remove?.bytes)}) véglegesen törlődik a lemezről.`}
        confirmLabel="Törlés"
        onConfirm={() => remove && run("delete", `/api/backups/${encodeURIComponent(remove.name)}/delete`, {}, { success: "mentés törölve", refresh: ["/api/backups"] })}
      />
    </>
  );
}
