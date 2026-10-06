package com.nexo.camara

import android.annotation.SuppressLint
import android.content.Context
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.util.Range
import android.view.Surface
import kotlin.math.max
import kotlin.math.min

// La camara y su codificador H.264. La camara pinta directamente en la
// superficie de entrada del codificador por hardware (MediaCodec): los
// fotogramas no pasan por memoria de la aplicacion, que es lo que mantiene bajo
// el retraso y el consumo.
//
// En esta version la imagen sale SIEMPRE apaisada, como la entrega el sensor.
// Para vertical habria que girarla con OpenGL antes de codificar; mientras, el
// giro se hace en el PC (menu de la bandeja de Nexo, o en OBS).
class Camara(contexto: Context) {
    data class Lente(val id: String, val nombre: String)
    data class Formato(val largo: Int, val corto: Int, val fpsMax: Int)

    // Fotograma codificado: (H.264 Annex-B, microsegundos, es clave).
    var alFotograma: ((ByteArray, Long, Boolean) -> Unit)? = null
    // Las medidas reales ya se conocen (o cambiaron).
    var alCambio: (() -> Unit)? = null
    var alFallo: ((String) -> Unit)? = null

    // Donde se ve la previa en el telefono. Puede no estar.
    @Volatile var previa: Surface? = null

    @Volatile var anchoReal = 0
        private set
    @Volatile var altoReal = 0
        private set

    private val gestor = contexto.getSystemService(Context.CAMERA_SERVICE) as CameraManager
    private val hilo = HandlerThread("nexo-camara").apply { start() }
    private val mano = Handler(hilo.looper)

    private var lenteId: String? = null
    private var ancho = 1920
    private var alto = 1080
    private var fps = 30
    private var linterna = false
    private var zoom = 1f

    private var dispositivo: CameraDevice? = null
    private var sesion: CameraCaptureSession? = null
    private var codec: MediaCodec? = null
    private var superficieCodec: Surface? = null
    private var cabeceras: ByteArray? = null // SPS y PPS: van delante de cada clave
    // Cada reconfiguracion sube este numero: lo que llegue tarde de una anterior
    // (la camara abre de forma asincrona) se reconoce y se descarta.
    private var generacion = 0

    // --- Lo que hay ---------------------------------------------------------

    fun lentes(): List<Lente> {
        var traseras = 0
        return gestor.cameraIdList.mapNotNull { id ->
            val c = try { gestor.getCameraCharacteristics(id) } catch (e: Exception) { return@mapNotNull null }
            val nombre = when (c.get(CameraCharacteristics.LENS_FACING)) {
                CameraCharacteristics.LENS_FACING_BACK -> if (traseras++ == 0) "Principal (trasera)" else "Trasera $traseras"
                CameraCharacteristics.LENS_FACING_FRONT -> "Frontal"
                else -> "Externa $id"
            }
            Lente(id, nombre)
        }
    }

    // Formatos 16:9 que el codificador de este movil admite con esa lente.
    fun formatos(id: String?): List<Formato> {
        if (id == null) return emptyList()
        return try {
            val c = gestor.getCameraCharacteristics(id)
            val mapa = c.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP) ?: return emptyList()
            val rangos = c.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES)
            val fpsMax = min(rangos?.maxOfOrNull { it.upper } ?: 30, 60)
            (mapa.getOutputSizes(MediaCodec::class.java) ?: emptyArray())
                .filter { it.width * 9 == it.height * 16 && it.width in listOf(3840, 2560, 1920, 1280) }
                .sortedByDescending { it.width }
                .map { Formato(it.width, it.height, fpsMax) }
        } catch (e: Exception) {
            emptyList()
        }
    }

    // --- Ordenes ------------------------------------------------------------

    fun configurar(lenteId: String?, ancho: Int, alto: Int, fps: Int) = mano.post {
        this.lenteId = lenteId
        // Siempre apaisado: el lado mayor es el ancho.
        this.ancho = max(ancho, alto)
        this.alto = min(ancho, alto)
        this.fps = fps
        reiniciar()
    }

    fun ponerLinterna(encendida: Boolean) = mano.post { linterna = encendida; repetir() }
    fun ponerZoom(valor: Float) = mano.post { zoom = valor; repetir() }

    // El PC acaba de conectarse: que el primer fotograma que reciba sea una clave.
    fun pedirClave() = mano.post {
        try {
            codec?.setParameters(Bundle().apply { putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0) })
        } catch (e: Exception) { }
    }

    fun parar() = mano.post { generacion++; cerrarTodo() }

    // --- Montaje ------------------------------------------------------------

    private fun bitrate(): Int {
        // La misma tabla que la app de iPhone, por el lado mayor.
        val base = when {
            ancho >= 3840 -> 32
            ancho >= 2560 -> 20
            ancho >= 1920 -> 12
            else -> 6
        }
        return (if (fps >= 50) base * 3 / 2 else base) * 1_000_000
    }

    @SuppressLint("MissingPermission") // el permiso lo pide MainActivity antes de llegar aqui
    private fun reiniciar() {
        val gen = ++generacion
        cerrarTodo()
        val id = lenteId ?: return

        // Si la lente no da lo pedido, lo mas cercano que si de.
        val posibles = formatos(id)
        if (posibles.isNotEmpty() && posibles.none { it.largo == ancho && it.corto == alto }) {
            val f = posibles.firstOrNull { it.largo <= ancho } ?: posibles.last()
            ancho = f.largo; alto = f.corto
        }

        try {
            val c = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
            val formato = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, ancho, alto).apply {
                setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
                setInteger(MediaFormat.KEY_BIT_RATE, bitrate())
                setInteger(MediaFormat.KEY_FRAME_RATE, fps)
                // Una clave cada 2 s, como el iPhone: es donde el PC se reengancha.
                setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 2)
                setInteger(MediaFormat.KEY_PRIORITY, 0) // tiempo real
                if (Build.VERSION.SDK_INT >= 29) setInteger(MediaFormat.KEY_MAX_B_FRAMES, 0)
                if (Build.VERSION.SDK_INT >= 30) setInteger(MediaFormat.KEY_LOW_LATENCY, 1)
            }
            c.setCallback(object : MediaCodec.Callback() {
                override fun onInputBufferAvailable(codec: MediaCodec, index: Int) {}
                override fun onOutputBufferAvailable(codec: MediaCodec, index: Int, info: MediaCodec.BufferInfo) {
                    try {
                        val bufer = codec.getOutputBuffer(index)
                        if (bufer != null && info.size > 0 && gen == generacion) {
                            val datos = ByteArray(info.size)
                            bufer.position(info.offset)
                            bufer.get(datos)
                            if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) {
                                cabeceras = datos
                            } else {
                                val clave = info.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME != 0
                                // SPS y PPS delante de cada clave: el PC puede
                                // engancharse en cualquiera sin haber visto el
                                // principio del flujo.
                                val cab = cabeceras
                                val salida = if (clave && cab != null) cab + datos else datos
                                // Reloj de pared, el mismo que va en los latidos.
                                alFotograma?.invoke(salida, System.currentTimeMillis() * 1000, clave)
                            }
                        }
                        codec.releaseOutputBuffer(index, false)
                    } catch (e: IllegalStateException) {
                        // el codificador se cerro mientras llegaba este fotograma
                    }
                }
                override fun onOutputFormatChanged(codec: MediaCodec, format: MediaFormat) {
                    if (gen != generacion) return
                    anchoReal = format.getInteger(MediaFormat.KEY_WIDTH)
                    altoReal = format.getInteger(MediaFormat.KEY_HEIGHT)
                    alCambio?.invoke()
                }
                override fun onError(codec: MediaCodec, e: MediaCodec.CodecException) {
                    alFallo?.invoke("El codificador fallo: ${e.message}")
                }
            }, mano)
            c.configure(formato, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            superficieCodec = c.createInputSurface()
            c.start()
            codec = c

            gestor.openCamera(id, object : CameraDevice.StateCallback() {
                override fun onOpened(camara: CameraDevice) {
                    if (gen != generacion) { camara.close(); return }
                    dispositivo = camara
                    crearSesion(camara, gen)
                }
                override fun onDisconnected(camara: CameraDevice) { camara.close() }
                override fun onError(camara: CameraDevice, error: Int) {
                    camara.close()
                    alFallo?.invoke("La camara no se pudo abrir (error $error)")
                }
            }, mano)
        } catch (e: Exception) {
            alFallo?.invoke("No se pudo preparar la camara a ${ancho}x$alto: ${e.message}")
            cerrarTodo()
        }
    }

    @Suppress("DEPRECATION") // la variante con SessionConfiguration pide Android 9
    private fun crearSesion(camara: CameraDevice, gen: Int) {
        val destinos = listOfNotNull(superficieCodec, previa?.takeIf { it.isValid })
        try {
            camara.createCaptureSession(destinos, object : CameraCaptureSession.StateCallback() {
                override fun onConfigured(s: CameraCaptureSession) {
                    if (gen != generacion) return
                    sesion = s
                    repetir()
                }
                override fun onConfigureFailed(s: CameraCaptureSession) {
                    alFallo?.invoke("La camara no acepta ${ancho}x$alto a $fps fps")
                }
            }, mano)
        } catch (e: Exception) {
            alFallo?.invoke("La camara no acepta ${ancho}x$alto: ${e.message}")
        }
    }

    // (Re)lanza la captura continua con los ajustes actuales.
    private fun repetir() {
        val camara = dispositivo ?: return
        val s = sesion ?: return
        try {
            val pedido = camara.createCaptureRequest(CameraDevice.TEMPLATE_RECORD)
            superficieCodec?.let(pedido::addTarget)
            previa?.takeIf { it.isValid }?.let(pedido::addTarget)

            // El rango de fps que mas se acerque: fijo si lo hay (30-30), y si no
            // el que llegue a esa cifra.
            val rangos = gestor.getCameraCharacteristics(camara.id)
                .get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES)
            val rango = rangos?.filter { it.upper == fps }?.maxByOrNull { it.lower }
                ?: rangos?.filter { it.upper >= fps }?.minByOrNull { it.upper }
            if (rango != null) pedido.set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, Range(rango.lower, rango.upper))

            pedido.set(CaptureRequest.FLASH_MODE,
                if (linterna) CaptureRequest.FLASH_MODE_TORCH else CaptureRequest.FLASH_MODE_OFF)
            if (Build.VERSION.SDK_INT >= 30) pedido.set(CaptureRequest.CONTROL_ZOOM_RATIO, zoom)
            s.setRepeatingRequest(pedido.build(), null, mano)
        } catch (e: Exception) {
            alFallo?.invoke("La camara rechazo los ajustes: ${e.message}")
        }
    }

    private fun cerrarTodo() {
        try { sesion?.close() } catch (e: Exception) { }
        try { dispositivo?.close() } catch (e: Exception) { }
        try { codec?.stop() } catch (e: Exception) { }
        try { codec?.release() } catch (e: Exception) { }
        try { superficieCodec?.release() } catch (e: Exception) { }
        sesion = null
        dispositivo = null
        codec = null
        superficieCodec = null
        cabeceras = null
        anchoReal = 0
        altoReal = 0
    }
}
