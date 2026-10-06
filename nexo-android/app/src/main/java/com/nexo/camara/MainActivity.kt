package com.nexo.camara

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.SurfaceTexture
import android.os.BatteryManager
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.Surface
import android.view.TextureView
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
import java.net.Socket

// Nexo Cam para Android: el movil como camara del PC por cable USB.
//
// Hace lo mismo que la app de iPhone, con el mismo protocolo: escucha en el
// puerto 7000 del propio telefono, el PC llega por el cable (`adb forward`, que
// pide tener activada la "Depuracion por USB") y por ahi sale el video H.264 y
// entran las ordenes del estudio de Nexo.
//
// Como en el iPhone, la app tiene que estar abierta y en pantalla: Android no
// deja usar la camara en segundo plano.
class MainActivity : Activity() {
    private lateinit var camara: Camara
    private lateinit var servidor: ServidorCable
    private lateinit var texto: TextView
    private lateinit var vista: TextureView

    @Volatile private var sesion: Sesion? = null
    private var lentes: List<Camara.Lente> = emptyList()
    private var lenteId: String? = null
    // Lo pedido. Lo que de verdad sale lo dice la camara (anchoReal x altoReal).
    private var resolucion = "1920x1080"
    private var fps = 30
    private var zoom = 1.0
    private var linterna = false
    private var enMarcha = false

    override fun onCreate(estadoGuardado: Bundle?) {
        super.onCreate(estadoGuardado)
        // La pantalla no se apaga en mitad de un directo.
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        vista = TextureView(this)
        texto = TextView(this).apply {
            setTextColor(Color.WHITE)
            setBackgroundColor(Color.argb(140, 0, 0, 0))
            textSize = 15f
            setPadding(24, 12, 24, 12)
        }
        setContentView(FrameLayout(this).apply {
            setBackgroundColor(Color.BLACK)
            addView(vista, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
            addView(texto, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.START))
        })

        camara = Camara(this)
        camara.alFotograma = { datos, micros, clave -> sesion?.enviarVideo(datos, micros, clave) }
        camara.alCambio = { runOnUiThread { publicarEstado(); pintar() } }
        camara.alFallo = { motivo -> runOnUiThread { texto.text = motivo } }

        servidor = ServidorCable(
            alConectar = { socket -> runOnUiThread { adoptar(socket) } },
            alFallo = { motivo -> runOnUiThread { texto.text = motivo } },
        )

        vista.surfaceTextureListener = object : TextureView.SurfaceTextureListener {
            override fun onSurfaceTextureAvailable(st: SurfaceTexture, ancho: Int, alto: Int) { arrancarSiSePuede() }
            override fun onSurfaceTextureSizeChanged(st: SurfaceTexture, ancho: Int, alto: Int) {}
            override fun onSurfaceTextureDestroyed(st: SurfaceTexture): Boolean { camara.previa = null; return true }
            override fun onSurfaceTextureUpdated(st: SurfaceTexture) {}
        }
        mensaje("Preparando la camara...")
    }

    override fun onStart() {
        super.onStart()
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.CAMERA), 1)
        } else {
            arrancarSiSePuede()
        }
    }

    override fun onRequestPermissionsResult(codigo: Int, permisos: Array<out String>, resultados: IntArray) {
        super.onRequestPermissionsResult(codigo, permisos, resultados)
        if (resultados.isNotEmpty() && resultados[0] == PackageManager.PERMISSION_GRANTED) arrancarSiSePuede()
        else mensaje("Nexo Cam necesita el permiso de camara: Ajustes > Aplicaciones > Nexo Cam > Permisos")
    }

    override fun onStop() {
        super.onStop()
        // Fuera de pantalla Android quita la camara: se suelta todo limpiamente y
        // el PC ve cerrarse la sesion, en vez de quedarse con la imagen congelada.
        enMarcha = false
        camara.parar()
        sesion?.cerrar()
        servidor.detener()
    }

    // --- Arranque -----------------------------------------------------------

    private fun arrancarSiSePuede() {
        if (enMarcha) return
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) return
        val st = vista.surfaceTexture ?: return
        enMarcha = true

        lentes = camara.lentes()
        if (lenteId == null || lentes.none { it.id == lenteId }) {
            lenteId = lentes.firstOrNull { it.nombre.startsWith("Principal") }?.id ?: lentes.firstOrNull()?.id
        }
        if (lenteId == null) { mensaje("Este movil no tiene ninguna camara disponible"); return }

        aplicarCamara(st)
        servidor.iniciar()
        pintar()
    }

    private fun medidas(): Pair<Int, Int> {
        val p = resolucion.split("x").mapNotNull { it.toIntOrNull() }
        return if (p.size == 2) Pair(p[0], p[1]) else Pair(1920, 1080)
    }

    private fun aplicarCamara(st: SurfaceTexture? = vista.surfaceTexture) {
        val (ancho, alto) = medidas()
        if (st != null) {
            st.setDefaultBufferSize(maxOf(ancho, alto), minOf(ancho, alto))
            camara.previa = Surface(st)
        }
        camara.configurar(lenteId, ancho, alto, fps)
        camara.ponerLinterna(linterna)
    }

    // --- Conexion -----------------------------------------------------------

    private fun adoptar(socket: Socket) {
        if (!enMarcha) { try { socket.close() } catch (e: Exception) { }; return }
        sesion?.cerrar()
        val capacidades = JSONObject()
            .put("rol", "emisor")
            .put("app", "Nexo Cam")
            .put("modelo", "${Build.MANUFACTURER} ${Build.MODEL}")
            .put("sistema", "android")
        val nueva = Sesion(
            socket, capacidades,
            alListo = { runOnUiThread { camara.pedirClave(); publicarEstado(); pintar() } },
            alControl = { orden -> runOnUiThread { atender(orden) } },
            // Solo si la que termina es la que esta en uso: al llegar una nueva se
            // cierra la anterior y su aviso llega despues.
            alFin = { cual -> runOnUiThread { if (sesion === cual) { sesion = null; pintar() } } },
        )
        sesion = nueva
        nueva.iniciar()
    }

    // --- Ordenes del PC -----------------------------------------------------

    private fun atender(orden: JSONObject) {
        when (orden.optString("accion")) {
            "cambiar-lente" -> orden.optString("valor").takeIf { v -> lentes.any { it.id == v } }?.let { lenteId = it; aplicarCamara() }
            "cambiar-resolucion" -> orden.optString("valor").takeIf { it.matches(Regex("\\d+x\\d+")) }?.let { resolucion = it; aplicarCamara() }
            "cambiar-fps" -> orden.optInt("valor", 0).takeIf { it in 1..120 }?.let { fps = it; aplicarCamara() }
            "zoom" -> orden.optDouble("valor", Double.NaN).takeIf { !it.isNaN() }?.let { zoom = it.coerceIn(1.0, 10.0); camara.ponerZoom(zoom.toFloat()) }
            "linterna" -> { linterna = !linterna; camara.ponerLinterna(linterna) }
            // exposicion, iso, foco, enfoque y balance: aun no en Android. Se
            // contesta igualmente con el estado para que el PC no de la orden por
            // perdida.
        }
        publicarEstado()
        pintar()
    }

    // --- Estado hacia el PC -------------------------------------------------

    private fun publicarEstado() {
        val s = sesion ?: return
        val bateria = (getSystemService(Context.BATTERY_SERVICE) as BatteryManager)
            .getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
        val estado = JSONObject()
            .put("transmitiendo", true)
            .put("lenteActual", lenteId ?: "")
            .put("zoom", zoom)
            .put("linterna", linterna)
            .put("resolucion", resolucion)
            .put("fps", fps)
            .put("bateria", bateria)
            .put("lentes", JSONArray().apply { lentes.forEach { put(JSONObject().put("id", it.id).put("nombre", it.nombre)) } })
            .put("formatos", JSONArray().apply {
                camara.formatos(lenteId).forEach { put(JSONObject().put("largo", it.largo).put("corto", it.corto).put("fpsMax", it.fpsMax)) }
            })
        // La resolucion de arriba es la PEDIDA; esta es la que sale de verdad.
        if (camara.anchoReal > 0) {
            estado.put("resolucionReal", "${camara.anchoReal}x${camara.altoReal}")
            estado.put("formatoSensor", "${camara.anchoReal}x${camara.altoReal}")
        }
        s.enviarEstado(estado)
    }

    // --- Pantalla -----------------------------------------------------------

    private fun pintar() {
        val real = if (camara.anchoReal > 0) "${camara.anchoReal}x${camara.altoReal} a $fps fps" else resolucion
        texto.text = if (sesion != null) "Nexo Cam · en directo por cable · $real"
        else "Nexo Cam · esperando al PC · conecta el cable y activa la Depuracion por USB"
    }

    private fun mensaje(t: String) { texto.text = t }
}
