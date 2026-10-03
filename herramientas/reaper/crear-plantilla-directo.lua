-- Crea la plantilla de Reaper para los directos de "solo cantar" sobre un beat.
-- Se ejecuta dentro de Reaper (Acciones > Cargar ReaScript, o pasandolo en la
-- linea de comandos). Deja el proyecto abierto y lo guarda como plantilla.
--
--   Pista "Voz":  entrada In 1 de la M-Audio en mono, armada y con monitoreo
--                 (se oye y suena en el directo, pero no graba), Auto-Tune Artist.
--   Pista "Beat": vacia; ahi se arrastra el instrumental.
--   Master:       ReaLimit (que nunca sature) y ReaStream enviando a OBS
--                 y TikTok, igual que hace FL: identificador "nexo-fl",
--                 127.0.0.1. El puente de Nexo lo reparte.
--
-- El modo enviar y el identificador de ReaStream no se pueden poner por codigo:
-- este script deja la ventana de ReaStream abierta y avisa.

local function aviso(t) reaper.ShowConsoleMsg(t .. "\n") end

reaper.PreventUIRefresh(1)
reaper.Undo_BeginBlock()

-- Proyecto en blanco: quita las pistas que hubiera.
for i = reaper.CountTracks(0) - 1, 0, -1 do
  reaper.DeleteTrack(reaper.GetTrack(0, i))
end

-- Voz
reaper.InsertTrackAtIndex(0, true)
local voz = reaper.GetTrack(0, 0)
reaper.GetSetMediaTrackInfo_String(voz, "P_NAME", "Voz (micro In 1)", true)
reaper.SetMediaTrackInfo_Value(voz, "I_RECINPUT", 0)  -- In 1, mono
reaper.SetMediaTrackInfo_Value(voz, "I_RECMODE", 2)   -- solo monitoreo: no graba
reaper.SetMediaTrackInfo_Value(voz, "I_RECMON", 1)    -- monitoreo activado
reaper.SetMediaTrackInfo_Value(voz, "I_RECARM", 1)    -- armada: sin esto no se oye
local at = reaper.TrackFX_AddByName(voz, "VST3: Auto-Tune Artist (Antares)", false, -1)
if at < 0 then aviso("AVISO: no encontre Auto-Tune Artist; anadelo a mano en la pista Voz") end

-- Beat
reaper.InsertTrackAtIndex(1, true)
local beat = reaper.GetTrack(0, 1)
reaper.GetSetMediaTrackInfo_String(beat, "P_NAME", "Beat (arrastra aqui el instrumental)", true)

-- Master: limitador y ReaStream
local master = reaper.GetMasterTrack(0)
-- Con sus valores por defecto: techo justo por debajo de 0 dB, que es lo que
-- hacia el Fruity Limiter en FL (evitar que un grito sature el directo).
local lim = reaper.TrackFX_AddByName(master, "ReaLimit (Cockos)", false, -1)
local rs = reaper.TrackFX_AddByName(master, "ReaStream (Cockos)", false, -1)
if rs < 0 then aviso("AVISO: no encontre ReaStream") end

reaper.Undo_EndBlock("Plantilla de directo (cantar)", -1)
reaper.PreventUIRefresh(-1)
reaper.TrackList_AdjustWindows(false)
reaper.UpdateArrange()

-- Lista de parametros de ReaStream y ReaLimit, para saber que se puede fijar.
local f = io.open(reaper.GetResourcePath() .. "\\nexo-parametros.txt", "w")
if f then
  for _, fx in ipairs({ { lim, "ReaLimit" }, { rs, "ReaStream" } }) do
    if fx[1] >= 0 then
      for p = 0, reaper.TrackFX_GetNumParams(master, fx[1]) - 1 do
        local _, nombre = reaper.TrackFX_GetParamName(master, fx[1], p, "")
        local _, valor = reaper.TrackFX_GetFormattedParamValue(master, fx[1], p, "")
        f:write(fx[2] .. "\t" .. p .. "\t" .. nombre .. "\t" .. valor .. "\n")
      end
    end
  end
  f:close()
end

-- Abre ReaStream para configurarlo (enviar, nexo-fl, 127.0.0.1).
if rs >= 0 then reaper.TrackFX_Show(master, rs, 3) end
aviso("Plantilla montada. Falta en ReaStream: Send audio/MIDI, identificador nexo-fl, IP 127.0.0.1.")
aviso("Luego: Archivo > Plantillas de proyecto > Guardar como 'Directo - cantar'.")
