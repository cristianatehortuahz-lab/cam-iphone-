-- Guarda el proyecto abierto como plantilla "Directo - cantar" (Archivo >
-- Plantillas de proyecto). La abre iniciar-directo.ps1 en el modo cantar.
local dir = reaper.GetResourcePath() .. "\\ProjectTemplates"
reaper.RecursiveCreateDirectory(dir, 0)
local ruta = dir .. "\\Directo - cantar.RPP"
reaper.Main_SaveProjectEx(0, ruta, 1)  -- 1 = como plantilla (sin rutas de medios)
local f = io.open(ruta, "r")
if f then f:close(); reaper.ShowConsoleMsg("Plantilla guardada: " .. ruta .. "\n")
else reaper.ShowConsoleMsg("ERROR: no se pudo guardar " .. ruta .. "\n") end
