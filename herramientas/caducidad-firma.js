// Cuando caduca la firma de Nexo Cam. Lo usa iniciar-directo.ps1.
//
// Sideloadly guarda en installations.db la ultima vez que firmo cada app; con
// Apple ID gratuito la firma dura 7 dias desde ahi. Se lee una COPIA de la base
// para no bloquear al daemon, que la tiene abierta.
//
// Imprime una linea JSON: { firmada, caduca, horasRestantes } o { error }.

const fs = require('fs');
const os = require('os');
const path = require('path');

const DIAS_FIRMA = 7;
let copia = null;

// process.exit corta sin pasar por ningun finally: la copia se borra aqui.
function salir(obj) {
  if (copia) {
    try {
      fs.unlinkSync(copia);
    } catch {
      /* no llego a crearse */
    }
  }
  process.stdout.write(JSON.stringify(obj) + '\n');
  process.exit(0);
}

let DatabaseSync;
try {
  // Aviso de "experimental" en Node 22: no es un error, se silencia.
  process.removeAllListeners('warning');
  ({ DatabaseSync } = require('node:sqlite'));
} catch {
  salir({ error: 'este Node no trae node:sqlite (hace falta Node 22.5 o mas)' });
}

const origen = path.join(process.env.LOCALAPPDATA || '', 'Sideloadly', 'installations.db');
if (!fs.existsSync(origen)) salir({ error: 'no encuentro la base de Sideloadly' });

copia = path.join(os.tmpdir(), `nexo-firma-${process.pid}.db`);
try {
  fs.copyFileSync(origen, copia);
  const db = new DatabaseSync(copia, { readOnly: true });
  const fila = db
    .prepare("SELECT last_updated FROM installations WHERE name LIKE 'Nexo%' ORDER BY last_updated DESC LIMIT 1")
    .get();
  db.close();
  if (!fila || !fila.last_updated) salir({ error: 'Nexo no aparece en Sideloadly' });

  const firmada = new Date(fila.last_updated);
  if (Number.isNaN(firmada.getTime())) salir({ error: `fecha ilegible: ${fila.last_updated}` });
  const caduca = new Date(firmada.getTime() + DIAS_FIRMA * 24 * 3600 * 1000);
  salir({
    firmada: firmada.toISOString(),
    caduca: caduca.toISOString(),
    horasRestantes: Math.round((caduca - Date.now()) / 3600000),
  });
} catch (e) {
  salir({ error: e.message });
}
