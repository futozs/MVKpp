import React, { useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import { Crosshair, Plus, Search, SlidersHorizontal, X } from 'lucide-react'
import type { FilterState, LiveVehicle, Route, Stop } from '@/types'
import { api } from '@/services/api'
import { RouteChips } from '@/components/fleet/RouteChips'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { RouteTile } from '@/components/transit/RouteTile'
import { LiveDot } from '@/components/transit/LiveDot'
import { token } from '@/lib/theme'
import { cn } from '@/lib/utils'

export interface TileLayerOption {
  id: string
  name: string
  note: string
  url: string
  /** Utcanevek külön rétegen (az Esri alaptérképek felirat nélkül jönnek). */
  labelsUrl?: string
  attribution: string
  /** Ameddig a szolgáltató valódi csempét ad; efölött Leaflet nagyítja fel. */
  maxNativeZoom: number
  /** Előnézeti szín a választóban. */
  swatch: string
}

/**
 * Alaptérképek.
 *
 * Kizárólag olyan szolgáltatók, amelyek API-kulcs nélkül, ingyenesen adnak
 * csempét — mindegyik le van ellenőrizve. A Carto sötét/világos csempéi
 * szándékosan hiányoznak: ma már kulcsot kérnek, és kulcs nélkül csak egy
 * „API KEY REQUIRED” vízjelet adnak vissza.
 */
export const TILE_LAYERS: TileLayerOption[] = [
  {
    id: 'osm',
    name: 'OpenStreetMap',
    note: 'A klasszikus utcatérkép, legtöbb részlettel',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> közreműködők',
    maxNativeZoom: 19,
    swatch: '#E8E0D8',
  },
  {
    id: 'dark',
    name: 'Sötét',
    note: 'Esri Dark Gray — a járatszínek ezen ütnek ki legjobban',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    labelsUrl:
      'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
    attribution: '&copy; <a href="https://www.esri.com/">Esri</a>, HERE, Garmin, &copy; OpenStreetMap',
    maxNativeZoom: 16,
    swatch: '#2B2B2B',
  },
  {
    id: 'light',
    name: 'Világos',
    note: 'Esri Light Gray — visszafogott, nappali használatra',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    labelsUrl:
      'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
    attribution: '&copy; <a href="https://www.esri.com/">Esri</a>, HERE, Garmin, &copy; OpenStreetMap',
    maxNativeZoom: 16,
    swatch: '#D9D9D6',
  },
  {
    id: 'satellite',
    name: 'Műhold',
    note: 'Esri World Imagery, utcanevekkel',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    labelsUrl:
      'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
    attribution:
      '&copy; <a href="https://www.esri.com/">Esri</a>, Maxar, Earthstar Geographics',
    maxNativeZoom: 19,
    swatch: '#3F5B3C',
  },
  {
    id: 'topo',
    name: 'Domborzat',
    note: 'OpenTopoMap — szintvonalakkal',
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    attribution:
      'Csempe: <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA), adat: &copy; OpenStreetMap',
    maxNativeZoom: 17,
    swatch: '#CBD3B0',
  },
]

const MAX_WATCHED = 12

interface TransitMapProps {
  stops: Stop[]
  routes: Record<string, Route>
  vehicles: LiveVehicle[]
  filters: FilterState
  setFilters: React.Dispatch<React.SetStateAction<FilterState>>
  onClearFilters: () => void
  onSelectStop: (stopId: string) => void
  focusTripId: string | null
  focusVehicleId: string | null
  onExitFocus: () => void
  onFocusTrip: (tripId: string, vehicleId?: string) => void
  tileLayerId: string
  selectedStopId: string | null
  monitoredStopIds: string[]
  onToggleMonitorStop: (stopId: string) => void
}

export function TransitMap({
  stops,
  routes,
  vehicles,
  filters,
  setFilters,
  onClearFilters,
  onSelectStop,
  focusTripId,
  focusVehicleId,
  onExitFocus,
  onFocusTrip,
  tileLayerId,
  selectedStopId,
  monitoredStopIds,
  onToggleMonitorStop,
}: TransitMapProps) {
  const mapContainerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const tileLayerRef = useRef<L.TileLayer | null>(null)
  const labelLayerRef = useRef<L.TileLayer | null>(null)
  const stopLayerRef = useRef<L.LayerGroup | null>(null)
  const busLayerRef = useRef<L.LayerGroup | null>(null)
  const routeLayerRef = useRef<L.LayerGroup | null>(null)
  const focusLayerRef = useRef<L.LayerGroup | null>(null)
  const geoCacheRef = useRef<Record<string, [number, number][][]>>({})
  const lastFocusKeyRef = useRef<string>('')

  /** Mobilon az oldalsáv rácsúszik a térképre; asztali nézetben mindig látszik. */
  const [isPanelOpen, setPanelOpen] = useState(false)
  const [stopQuery, setStopQuery] = useState('')
  const [typedId, setTypedId] = useState('')

  /* ---------------------------------------------------------------- térkép */

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return

    const map = L.map(mapContainerRef.current, {
      // A saját helyén a bal felső sarokban ütközne a mobil „Szűrés” gombbal.
      zoomControl: false,
      // Saját, nem publikus használatra készül, ezért a csempeszolgáltatók
      // forráshivatkozó sávja nincs kirakva.
      attributionControl: false,
      preferCanvas: true,
      center: [48.104, 20.79],
      zoom: 13,
    })
    L.control.zoom({ position: 'bottomright' }).addTo(map)

    const initial = TILE_LAYERS.find((l) => l.id === tileLayerId) || TILE_LAYERS[0]
    tileLayerRef.current = L.tileLayer(initial.url, {
      maxZoom: 19,
      maxNativeZoom: initial.maxNativeZoom,
      // Retina kijelzőn (telefon) negyed méretű csempéket kér eggyel nagyobb
      // zoomról — enélkül a térkép felnagyított, pixeles képként látszik.
      detectRetina: true,
      attribution: initial.attribution,
    }).addTo(map)
    if (initial.labelsUrl) {
      labelLayerRef.current = L.tileLayer(initial.labelsUrl, {
        maxZoom: 19,
        maxNativeZoom: initial.maxNativeZoom,
        detectRetina: true,
        pane: 'shadowPane',
      }).addTo(map)
    }

    routeLayerRef.current = L.layerGroup().addTo(map)
    stopLayerRef.current = L.layerGroup().addTo(map)
    busLayerRef.current = L.layerGroup().addTo(map)
    focusLayerRef.current = L.layerGroup().addTo(map)
    mapRef.current = map

    return () => {
      map.remove()
      mapRef.current = null
    }
  }, [])

  // Alaptérkép cseréje a választóból.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const conf = TILE_LAYERS.find((l) => l.id === tileLayerId) || TILE_LAYERS[0]

    if (tileLayerRef.current) map.removeLayer(tileLayerRef.current)
    if (labelLayerRef.current) {
      map.removeLayer(labelLayerRef.current)
      labelLayerRef.current = null
    }

    tileLayerRef.current = L.tileLayer(conf.url, {
      maxZoom: 19,
      maxNativeZoom: conf.maxNativeZoom,
      detectRetina: true,
      attribution: conf.attribution,
    }).addTo(map)

    if (conf.labelsUrl) {
      labelLayerRef.current = L.tileLayer(conf.labelsUrl, {
        maxZoom: 19,
        maxNativeZoom: conf.maxNativeZoom,
        detectRetina: true,
        pane: 'shadowPane',
      }).addTo(map)
    }
  }, [tileLayerId])

  /**
   * Jármű-jelölő: lekerekített járatcsempe erős vetett árnyékkal, alatta a
   * rendszám külön, jól olvasható címkén. A formát az index.css adja.
   */
  const createVehicleIcon = (
    routeShort: string,
    color: string,
    textColor: string,
    tracked: boolean,
    idText: string | null
  ) =>
    L.divIcon({
      className: '',
      iconSize: [27, 19],
      iconAnchor: [13, 10],
      html: `
        <div class="mvk-vehicle ${tracked ? 'tracked' : ''}">
          <div class="tile" style="background:#${color};color:#${textColor}">${routeShort}</div>
          ${idText ? `<div class="vid">${idText}</div>` : ''}
        </div>
      `,
    })

  const getVisibleVehicles = () => {
    const q = filters.vq.trim().toLowerCase()
    const watchList = filters.watch.map((w) => w.toLowerCase())

    if (watchList.length > 0 || q) {
      const targets = [...watchList]
      if (q && !targets.includes(q)) targets.push(q)
      return vehicles.filter((v) => {
        const vid = String(v.id || '').toLowerCase()
        const label = String(v.label || '').toLowerCase()
        return targets.some((t) => vid.includes(t) || label.includes(t))
      })
    }

    let list = vehicles.slice()

    if (filters.type !== 'all') {
      list = list.filter((v) => {
        const r = routes[v.routeId]
        const isTram = r?.type === '900' || v.label === 'TRAM'
        return filters.type === 'tram' ? isTram : !isTram
      })
    }

    if (filters.routes.length > 0) {
      const routeSet = new Set(filters.routes)
      list = list.filter((v) => routeSet.has(v.routeId))
    }

    if (filters.moving) list = list.filter((v) => (v.speed || 0) > 0.5)

    return list
  }

  // Járatnyomvonalak
  useEffect(() => {
    if (!mapRef.current || !routeLayerRef.current) return
    const layer = routeLayerRef.current
    layer.clearLayers()
    if (!filters.shape || filters.routes.length === 0) return

    const render = async () => {
      const missing = filters.routes.filter((id) => !geoCacheRef.current[id])
      if (missing.length > 0) {
        try {
          const res = await api.getRouteGeo(missing)
          res.routes.forEach((r) => {
            geoCacheRef.current[r.id] = r.shapes
          })
        } catch {
          /* a nyomvonal hiánya nem állítja meg a térképet */
        }
      }

      const halo = token('--background')
      filters.routes.forEach((id) => {
        const shapes = geoCacheRef.current[id]
        if (!shapes) return
        const color = `#${routes[id]?.color || '1FB574'}`
        shapes.forEach((line) => {
          L.polyline(line, { color: halo, weight: 6, opacity: 0.55 }).addTo(layer)
          L.polyline(line, { color, weight: 3, opacity: 0.95 }).addTo(layer)
        })
      })
    }

    render()
  }, [filters.routes, filters.shape, routes])

  // Megállópontok. A megálló nem élő adat, ezért semleges — zöldet csak
  // az kap, amit épp figyelsz.
  useEffect(() => {
    if (!mapRef.current || !stopLayerRef.current) return
    const layer = stopLayerRef.current
    layer.clearLayers()
    if (!filters.stops || focusTripId) return

    const neutral = token('--muted-foreground')
    const brand = token('--primary')
    const outline = token('--background')
    const watched = new Set(monitoredStopIds)

    stops.forEach((s) => {
      const isWatched = watched.has(s.id)
      const isSelected = selectedStopId === s.id

      const marker = L.circleMarker([s.lat, s.lon], {
        radius: isWatched || isSelected ? 6 : 3.5,
        color: outline,
        weight: 1.5,
        fillColor: isWatched || isSelected ? brand : neutral,
        fillOpacity: 1,
      })

      marker.bindTooltip(
        `<strong>${s.name}</strong><br><span style="opacity:.65">${s.code || s.id}</span>`,
        { direction: 'top', offset: [0, -4] }
      )
      marker.on('click', () => onSelectStop(s.id))
      marker.addTo(layer)
    })
  }, [stops, filters.stops, focusTripId, onSelectStop, monitoredStopIds, selectedStopId])

  // Járművek
  useEffect(() => {
    if (!mapRef.current || !busLayerRef.current) return
    const layer = busLayerRef.current
    layer.clearLayers()
    if (focusTripId) return

    const visible = getVisibleVehicles()
    const watchSet = new Set(filters.watch.map((w) => w.toLowerCase()))
    const activeQ = filters.vq.trim().toLowerCase()

    visible.forEach((v) => {
      if (v.lat == null || v.lon == null) return

      const tracked =
        watchSet.has(v.id.toLowerCase()) || (activeQ ? v.id.toLowerCase().includes(activeQ) : false)

      const marker = L.marker([v.lat, v.lon], {
        icon: createVehicleIcon(
          v.routeShort || '?',
          v.routeColor || '1FB574',
          v.routeText || 'FFFFFF',
          tracked,
          filters.labels || tracked ? v.id : null
        ),
        zIndexOffset: tracked ? 1000 : 500,
      })

      const speed = v.speed != null ? `${Math.round(v.speed * 3.6)} km/h` : '—'
      const age = v.timestamp ? Math.max(0, Math.round(Date.now() / 1000 - v.timestamp)) : null

      marker.bindPopup(`
        <div style="min-width:210px">
          <div style="display:flex;align-items:center;gap:9px;margin-bottom:10px">
            <span style="display:inline-flex;align-items:center;justify-content:center;min-width:40px;height:26px;padding:0 8px;border-radius:8px;font-weight:800;font-size:14px;background:#${v.routeColor || '1FB574'};color:#${v.routeText || 'FFFFFF'}">${v.routeShort}</span>
            <strong style="font-size:13px">${v.headsign || 'Járat'}</strong>
          </div>
          <div style="border-radius:10px;background:hsl(var(--primary)/0.09);border:1px solid hsl(var(--primary)/0.25);padding:9px 11px;margin-bottom:8px">
            <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:hsl(var(--muted-foreground))">Rendszám</div>
            <div style="font-family:var(--font-mono);font-size:20px;font-weight:700;font-variant-numeric:tabular-nums;color:hsl(var(--foreground))">${v.id}</div>
          </div>
          <div style="font-family:var(--font-mono);font-size:12px;color:hsl(var(--muted-foreground));display:grid;gap:3px">
            <div>Sebesség <strong style="color:hsl(var(--foreground))">${speed}</strong></div>
            ${age != null ? `<div>Adat kora <strong style="color:hsl(var(--foreground))">${age} mp</strong></div>` : ''}
          </div>
          ${
            v.tripId
              ? `<div style="margin-top:10px">
                   <a href="#" data-trip="${v.tripId}" data-veh="${v.id}"
                      style="display:block;text-align:center;padding:7px;border-radius:8px;background:hsl(var(--primary));color:hsl(var(--primary-foreground));font-size:12px;font-weight:700;text-decoration:none">Követés a térképen</a>
                 </div>`
              : ''
          }
        </div>
      `)

      marker.on('popupopen', (e) => {
        const link = e.popup.getElement()?.querySelector('a[data-trip]')
        link?.addEventListener('click', (ev) => {
          ev.preventDefault()
          const tId = link.getAttribute('data-trip')
          const vId = link.getAttribute('data-veh')
          if (tId) onFocusTrip(tId, vId || undefined)
        })
      })

      marker.addTo(layer)
    })

    if (filters.watch.length > 0 || activeQ) {
      const key = `${filters.watch.join(',')}|${activeQ}`
      if (visible.length > 0 && (filters.follow || key !== lastFocusKeyRef.current)) {
        const points = visible
          .filter((v) => v.lat != null && v.lon != null)
          .map((v) => [v.lat!, v.lon!] as [number, number])

        if (points.length === 1 && mapRef.current) {
          mapRef.current.flyTo(points[0], Math.max(mapRef.current.getZoom(), 15), { duration: 0.6 })
        } else if (points.length > 1 && mapRef.current) {
          mapRef.current.fitBounds(points, { padding: [60, 60], maxZoom: 16 })
        }
      }
      lastFocusKeyRef.current = key
    }
  }, [vehicles, filters, focusTripId, routes, onFocusTrip])

  // Menetkövetés
  useEffect(() => {
    if (!mapRef.current || !focusLayerRef.current) return
    const layer = focusLayerRef.current
    layer.clearLayers()
    if (!focusTripId) return

    let alive = true

    const draw = async (fit: boolean) => {
      try {
        const res = await api.getTripPath(focusTripId, focusVehicleId || undefined)
        if (!alive) return

        layer.clearLayers()
        const color = `#${res.color || '1FB574'}`
        const halo = token('--background')
        const bounds: [number, number][] = []

        if (res.shape?.length) {
          L.polyline(res.shape, { color: halo, weight: 8, opacity: 0.6 }).addTo(layer)
          L.polyline(res.shape, { color, weight: 4, opacity: 0.95 }).addTo(layer)
          res.shape.forEach((pt) => bounds.push(pt))
        }

        if (res.vehicle?.lat != null && res.vehicle?.lon != null) {
          L.marker([res.vehicle.lat, res.vehicle.lon], {
            icon: createVehicleIcon(res.route, res.color, res.text, true, res.vehicle.id),
            zIndexOffset: 1200,
          }).addTo(layer)

          bounds.push([res.vehicle.lat, res.vehicle.lon])

          if (fit && bounds.length && mapRef.current) {
            mapRef.current.fitBounds(bounds, { padding: [60, 60], maxZoom: 16 })
          } else if (mapRef.current) {
            mapRef.current.flyTo([res.vehicle.lat, res.vehicle.lon], 15, { duration: 0.5 })
          }
        } else if (fit && bounds.length && mapRef.current) {
          mapRef.current.fitBounds(bounds, { padding: [60, 60], maxZoom: 16 })
        }
      } catch {
        /* a menet eltűnhet a feedből; a sáv marad, a felhasználó kiléphet */
      }
    }

    draw(true)
    const timer = setInterval(() => draw(false), 5000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [focusTripId, focusVehicleId])

  /* --------------------------------------------------------------- vezérlés */

  const addWatch = (value?: string) => {
    const target = (value ?? typedId).trim()
    if (!target || filters.watch.length >= MAX_WATCHED) return
    if (filters.watch.some((x) => x.toLowerCase() === target.toLowerCase())) return
    setFilters((prev) => ({ ...prev, watch: [...prev.watch, target], vq: '' }))
    setTypedId('')
  }

  const removeWatch = (value: string) =>
    setFilters((prev) => ({
      ...prev,
      watch: prev.watch.filter((x) => x.toLowerCase() !== value.toLowerCase()),
    }))

  const toggleRoute = (routeId: string) =>
    setFilters((prev) => ({
      ...prev,
      routes: prev.routes.includes(routeId)
        ? prev.routes.filter((id) => id !== routeId)
        : [...prev.routes, routeId],
    }))

  const stopResults = useMemo(() => {
    const q = stopQuery.trim().toLowerCase()
    if (!q) return stops.slice(0, 60)
    return stops
      .filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          (s.code && s.code.toLowerCase().includes(q)) ||
          s.id.toLowerCase().includes(q)
      )
      .slice(0, 80)
  }, [stops, stopQuery])

  const vehicleResults = useMemo(
    () =>
      getVisibleVehicles().sort(
        (a, b) =>
          a.routeShort.localeCompare(b.routeShort, 'hu') || a.id.localeCompare(b.id, 'hu')
      ),
    [vehicles, filters]
  )

  const flyToVehicle = (v: LiveVehicle) => {
    if (v.lat != null && v.lon != null && mapRef.current) {
      mapRef.current.flyTo([v.lat, v.lon], 16, { duration: 0.5 })
    }
  }

  const filterActive =
    filters.vq.trim() !== '' ||
    filters.watch.length > 0 ||
    filters.routes.length > 0 ||
    filters.type !== 'all' ||
    filters.moving ||
    !filters.stops

  const filterSummary = filters.watch.length
    ? `${filters.watch.join(', ')} követése`
    : filters.routes.length
      ? `${filters.routes.length} járat kiválasztva`
      : filters.moving
        ? 'Csak mozgó járművek'
        : 'Szűrés aktív'

  const LAYER_TOGGLES = [
    { key: 'stops', label: 'Megállók', description: 'Minden GTFS megállópont' },
    { key: 'shape', label: 'Járatnyomvonal', description: 'A kiválasztott járatok útvonala' },
    { key: 'moving', label: 'Csak mozgó járművek', description: '0,5 km/h fölött' },
    { key: 'labels', label: 'Rendszámok', description: 'Azonosító minden csempe alatt' },
  ] as const

  return (
    <div className="relative flex h-full w-full min-w-0 flex-1 overflow-hidden">
      {/* Mobil háttér: a nyitott panel mögé kattintva bezárul. */}
      {isPanelOpen ? (
        <button
          type="button"
          aria-label="Vezérlőpanel bezárása"
          onClick={() => setPanelOpen(false)}
          className="absolute inset-0 z-drawer bg-background/70 backdrop-blur-sm md:hidden"
        />
      ) : null}

      {/* Oldalsáv */}
      <Tabs
        defaultValue="filter"
        className={cn(
          'absolute inset-y-0 left-0 z-drawer flex w-[86%] max-w-[340px] flex-col overflow-hidden',
          'border-r border-border bg-card shadow-xl transition-transform duration-normal ease-out',
          'md:static md:z-overlay md:w-[340px] md:max-w-none md:shrink-0 md:translate-x-0 md:shadow-none lg:w-[380px]',
          isPanelOpen ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        <div className="shrink-0 border-b border-border p-2">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="filter" className="text-xs">
              Szűrés
            </TabsTrigger>
            <TabsTrigger value="fleet" className="gap-1.5 text-xs">
              Járművek
              <span className="rounded bg-primary/15 px-1 font-mono text-[10px] font-bold tabular-nums text-primary">
                {vehicleResults.length}
              </span>
            </TabsTrigger>
            <TabsTrigger value="stops" className="text-xs">
              Megállók
            </TabsTrigger>
          </TabsList>
        </div>

        {/* Szűrés */}
        <TabsContent
          value="filter"
          className="mt-0 min-h-0 flex-1 overflow-y-auto data-[state=inactive]:hidden focus-visible:outline-none"
        >
          <section className="space-y-3 border-b border-border px-4 py-4">
            <div className="flex items-baseline justify-between gap-2">
              <Label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Jármű követése
              </Label>
              {filters.watch.length > 0 ? (
                <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                  {filters.watch.length}/{MAX_WATCHED}
                </span>
              ) : null}
            </div>

            <div className="flex items-center gap-2">
              <Input
                value={typedId}
                onChange={(e) => {
                  setTypedId(e.target.value)
                  setFilters((prev) => ({ ...prev, vq: e.target.value }))
                }}
                onKeyDown={(e) => e.key === 'Enter' && addWatch()}
                placeholder="Rendszám, pl. 1641"
                aria-label="Jármű rendszáma"
                className="h-9 font-mono tabular-nums"
              />
              <Button
                size="icon"
                className="h-9 w-9 shrink-0"
                onClick={() => addWatch()}
                disabled={!typedId.trim() || filters.watch.length >= MAX_WATCHED}
                aria-label="Jármű hozzáadása a követési listához"
              >
                <Plus />
              </Button>
            </div>

            {filters.watch.length > 0 ? (
              <ul className="flex flex-wrap gap-1.5">
                {filters.watch.map((id) => (
                  <li key={id}>
                    <button
                      type="button"
                      onClick={() => removeWatch(id)}
                      aria-label={`${id} eltávolítása a követésből`}
                      className={cn(
                        'inline-flex h-7 items-center gap-1.5 rounded-md border border-primary/35 bg-primary/12 px-2',
                        'font-mono text-xs font-bold tabular-nums text-primary',
                        'transition-colors duration-fast hover:border-destructive/50 hover:bg-destructive/12 hover:text-destructive',
                        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
                      )}
                    >
                      {id}
                      <X className="h-3 w-3" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}

            <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2.5">
              <Label htmlFor="follow-toggle" className="cursor-pointer leading-snug">
                <span className="block text-xs font-medium">Térkép kövesse a járművet</span>
                <span className="block text-[11px] font-normal text-muted-foreground">
                  Minden frissülésnél ráugrik
                </span>
              </Label>
              <Switch
                id="follow-toggle"
                checked={filters.follow}
                onCheckedChange={(v) => setFilters((prev) => ({ ...prev, follow: v }))}
              />
            </div>
          </section>

          <section className="space-y-2.5 border-b border-border px-4 py-4">
            <Label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Járműtípus
            </Label>
            <div className="grid grid-cols-3 gap-1 rounded-lg border border-border bg-muted/60 p-1">
              {(
                [
                  { id: 'all', label: 'Mind' },
                  { id: 'bus', label: 'Busz' },
                  { id: 'tram', label: 'Villamos' },
                ] as const
              ).map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setFilters((prev) => ({ ...prev, type: option.id }))}
                  aria-pressed={filters.type === option.id}
                  className={cn(
                    'rounded-md py-1.5 text-xs font-semibold transition-all duration-fast',
                    'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                    filters.type === option.id
                      ? 'bg-primary text-primary-foreground shadow-sm'
                      : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </section>

          <section className="space-y-2.5 border-b border-border px-4 py-4">
            <div className="flex items-baseline justify-between gap-2">
              <Label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Járatok
              </Label>
              <span className="text-[11px] text-muted-foreground">
                {filters.routes.length > 0 ? `${filters.routes.length} kiválasztva` : 'mind'}
              </span>
            </div>
            <RouteChips
              routes={routes}
              selectedRoutes={filters.routes}
              onToggleRoute={toggleRoute}
              onSetRoutes={(ids) => setFilters((prev) => ({ ...prev, routes: ids }))}
              liveVehicles={vehicles}
            />
          </section>

          <section className="space-y-1 px-4 py-4">
            <Label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Térképi rétegek
            </Label>
            <div className="mt-2 space-y-1">
              {LAYER_TOGGLES.map(({ key, label, description }) => (
                <div
                  key={key}
                  className="flex items-center justify-between gap-3 rounded-lg px-2 py-2 transition-colors duration-fast hover:bg-accent"
                >
                  <Label htmlFor={`layer-${key}`} className="cursor-pointer leading-snug">
                    <span className="block text-xs font-medium">{label}</span>
                    <span className="block text-[11px] font-normal text-muted-foreground">
                      {description}
                    </span>
                  </Label>
                  <Switch
                    id={`layer-${key}`}
                    checked={filters[key] as boolean}
                    onCheckedChange={(v) => setFilters((prev) => ({ ...prev, [key]: v }))}
                  />
                </div>
              ))}
            </div>
          </section>
        </TabsContent>

        {/* Élő járművek */}
        <TabsContent
          value="fleet"
          className="mt-0 min-h-0 flex-1 overflow-y-auto data-[state=inactive]:hidden focus-visible:outline-none"
        >
          {vehicleResults.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              A jelenlegi szűrésnek egy jármű sem felel meg.
            </p>
          ) : (
            <ul className="divide-y divide-border/60">
              {vehicleResults.map((v) => (
                <li key={v.id}>
                  <button
                    type="button"
                    onClick={() => {
                      flyToVehicle(v)
                      setPanelOpen(false)
                    }}
                    className={cn(
                      'flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors duration-fast hover:bg-accent',
                      'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring'
                    )}
                  >
                    <RouteTile short={v.routeShort} color={v.routeColor} text={v.routeText} />

                    <span className="min-w-0 flex-1">
                      {/* A rendszám a lista fő adata. */}
                      <span className="flex items-center gap-1.5 font-mono text-sm font-bold tabular-nums">
                        {v.id}
                        <LiveDot />
                      </span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {v.headsign}
                      </span>
                    </span>

                    <span className="shrink-0 font-mono text-xs font-semibold tabular-nums text-muted-foreground">
                      {v.speed != null ? `${Math.round(v.speed * 3.6)} km/h` : '—'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </TabsContent>

        {/* Megállók */}
        <TabsContent
          value="stops"
          className="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden data-[state=inactive]:hidden focus-visible:outline-none"
        >
          <div className="shrink-0 border-b border-border px-4 py-3">
            <div className="relative">
              <Search
                aria-hidden
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                value={stopQuery}
                onChange={(e) => setStopQuery(e.target.value)}
                placeholder="Megálló neve vagy kódja"
                aria-label="Megálló keresése"
                className="pl-9"
              />
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {stopResults.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                Nincs „{stopQuery}” nevű megálló.
              </p>
            ) : (
              <ul className="divide-y divide-border/60">
                {stopResults.map((s) => {
                  const watched = monitoredStopIds.includes(s.id)
                  return (
                    <li
                      key={s.id}
                      className={cn(
                        'flex items-center gap-1 transition-colors duration-fast',
                        selectedStopId === s.id ? 'bg-primary/10' : 'hover:bg-accent'
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          onSelectStop(s.id)
                          setPanelOpen(false)
                        }}
                        className="min-w-0 flex-1 px-4 py-2.5 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                      >
                        <span className="block truncate text-xs font-medium">{s.name}</span>
                        <span className="block font-mono text-[11px] tabular-nums text-muted-foreground">
                          {s.code || s.id}
                        </span>
                      </button>

                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant={watched ? 'default' : 'ghost'}
                            size="icon"
                            className="mr-3 h-7 w-7 shrink-0"
                            onClick={() => onToggleMonitorStop(s.id)}
                            aria-pressed={watched}
                            aria-label={
                              watched
                                ? `${s.name} levétele a figyelőről`
                                : `${s.name} felvétele a figyelőre`
                            }
                          >
                            <Plus className={cn(watched && 'rotate-45')} />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                          {watched ? 'Levétel a figyelőről' : 'Felvétel a figyelőre'}
                        </TooltipContent>
                      </Tooltip>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </TabsContent>
      </Tabs>

      {/* Térkép */}
      <div className="relative h-full w-full min-w-0 flex-1 bg-background">
        <div ref={mapContainerRef} className="z-map h-full w-full" />

        {/* Vezérlőpanel nyitása mobilon. */}
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setPanelOpen(true)}
          className="absolute left-3 top-3 z-overlay shadow-lg md:hidden"
        >
          <SlidersHorizontal />
          Szűrés
        </Button>

        {focusTripId ? (
          <div className="absolute left-3 top-3 z-overlay md:left-4 md:top-4">
            <Button onClick={onExitFocus} className="shadow-xl">
              Menetkövetés vége
            </Button>
          </div>
        ) : null}

        {filterActive && !focusTripId ? (
          <div className="absolute right-3 top-3 z-overlay flex max-w-[calc(100%-1.5rem)] items-center gap-2 rounded-xl border border-border bg-card/95 px-3 py-2 shadow-xl backdrop-blur-sm sm:max-w-sm sm:gap-3 sm:px-3.5 sm:py-2.5 md:right-4 md:top-4">
            <Crosshair aria-hidden className="h-4 w-4 shrink-0 text-primary" />
            <span className="min-w-0 truncate text-xs font-medium">{filterSummary}</span>
            <Button variant="ghost" size="sm" className="h-7 shrink-0 px-2 text-xs" onClick={onClearFilters}>
              Alaphelyzet
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  )
}
