package com.nexo.camara

import org.json.JSONObject
import java.io.BufferedOutputStream
import java.io.DataInputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.LinkedBlockingDeque
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

// Puerto que Nexo Cam abre en el telefono. El PC llega a el por el cable con
// `adb forward`. Es el mismo numero que en el iPhone (PUERTO_CABLE) y que
// CABLE_IPHONE en nexo-desktop/src/main/puertos.js.
const val PUERTO_CABLE = 7000

// Una conexion con el PC: manda el video y el estado, y atiende sus ordenes.
class Sesion(
    private val socket: Socket,
    private val capacidades: JSONObject,
    private val alListo: () -> Unit,
    private val alControl: (JSONObject) -> Unit,
    private val alFin: (Sesion) -> Unit,
) {
    private val cola = LinkedBlockingDeque<ByteArray>()
    private val cerrada = AtomicBoolean(false)
    // Si el PC o el cable no dan abasto, la cola crece y con ella el retraso. Al
    // pasar del tope se tiran fotogramas hasta la siguiente clave: se pierde un
    // instante de imagen, pero se vuelve a directo.
    @Volatile private var esperandoClave = false
    private val TOPE_COLA = 45

    fun iniciar() {
        socket.tcpNoDelay = true
        thread(name = "nexo-escribe", isDaemon = true) { escribir() }
        thread(name = "nexo-lee", isDaemon = true) { leer() }
    }

    private fun escribir() {
        try {
            val salida = BufferedOutputStream(socket.getOutputStream(), 1 shl 16)
            salida.write(Protocolo.saludo(capacidades))
            salida.flush()
            while (!cerrada.get()) {
                val trozo = cola.take()
                salida.write(trozo)
                // Se vacia en cuanto no queda nada esperando: un fotograma no se
                // queda retenido en el bufer a la espera del siguiente.
                if (cola.isEmpty()) salida.flush()
            }
        } catch (e: Exception) {
            // socket cerrado o hilo interrumpido
        } finally {
            cerrar()
        }
    }

    private fun leer() {
        try {
            val entrada = DataInputStream(socket.getInputStream().buffered())
            Protocolo.leerSaludo(entrada)
            alListo()
            while (!cerrada.get()) {
                val t = Protocolo.leerTrama(entrada)
                when (t.tipo) {
                    Protocolo.CONTROL -> t.json()?.let(alControl)
                    Protocolo.LATIDO -> {
                        // Se devuelve la hora del PC junto a la nuestra: con la ida
                        // y vuelta el PC calcula el desfase entre relojes, que es lo
                        // que le permite alinear varias camaras.
                        val pc = t.json()
                        val respuesta = JSONObject()
                        if (pc != null && pc.has("pc")) respuesta.put("pc", pc.get("pc"))
                        respuesta.put("movil", System.currentTimeMillis())
                        cola.offerFirst(Protocolo.json(Protocolo.LATIDO, respuesta))
                    }
                }
            }
        } catch (e: Exception) {
            // fin del flujo o trama invalida: se corta
        } finally {
            cerrar()
        }
    }

    fun enviarVideo(datos: ByteArray, microsegundos: Long, clave: Boolean) {
        if (cerrada.get()) return
        if (esperandoClave) {
            if (!clave) return
            esperandoClave = false
        } else if (!clave && cola.size > TOPE_COLA) {
            esperandoClave = true
            return
        }
        cola.offer(Protocolo.video(microsegundos, clave, datos))
    }

    fun enviarEstado(estado: JSONObject) {
        if (!cerrada.get()) cola.offer(Protocolo.json(Protocolo.ESTADO, estado))
    }

    // Idempotente: la llaman los dos hilos y la actividad.
    fun cerrar() {
        if (!cerrada.compareAndSet(false, true)) return
        try { socket.close() } catch (e: Exception) { }
        // Despierta al hilo que escribe, que puede estar esperando en la cola.
        cola.offer(ByteArray(0))
        alFin(this)
    }
}

// Escucha en el propio telefono. Solo en 127.0.0.1: la unica forma de llegar es
// el tunel del cable (`adb forward`), asi que nadie de la red puede entrar.
class ServidorCable(private val alConectar: (Socket) -> Unit, private val alFallo: (String) -> Unit) {
    @Volatile private var servidor: ServerSocket? = null

    fun iniciar() {
        if (servidor != null) return
        thread(name = "nexo-servidor", isDaemon = true) {
            try {
                val s = ServerSocket()
                s.reuseAddress = true
                s.bind(java.net.InetSocketAddress(InetAddress.getByName("127.0.0.1"), PUERTO_CABLE), 2)
                servidor = s
                while (!s.isClosed) alConectar(s.accept())
            } catch (e: Exception) {
                if (servidor?.isClosed != true) alFallo("No se pudo abrir el puerto $PUERTO_CABLE: ${e.message}")
            }
        }
    }

    fun detener() {
        try { servidor?.close() } catch (e: Exception) { }
        servidor = null
    }
}
