package com.nexo.camara

import org.json.JSONObject
import java.io.DataInputStream
import java.io.IOException
import java.nio.ByteBuffer

// Protocolo binario de Nexo, lado Android. Es el mismo que habla la app de
// iPhone (nexo-ios/Sources/ProtocoloNexo.swift) y que lee el PC
// (nexo-desktop/src/main/protocolo.js): si cambia en uno, cambia en los tres.
//
//   Saludo (una vez):  "NEXO1" | version u8 | longitud u32-BE | JSON
//   Tramas:            tipo u8 | longitud u32-BE | carga
//   VIDEO (1):         u64-BE microsegundos | u8 flags (bit 0 = clave) | H.264 Annex-B
//   ESTADO (3), CONTROL (4), LATIDO (5): JSON
object Protocolo {
    const val VIDEO = 1
    const val AUDIO = 2
    const val ESTADO = 3
    const val CONTROL = 4
    const val LATIDO = 5

    // Mismo techo que en el PC: una longitud absurda corta la sesion en vez de
    // agotar la memoria.
    const val MAX_TRAMA = 4 * 1024 * 1024

    private val MAGIA = "NEXO1".toByteArray(Charsets.US_ASCII)
    private const val VERSION = 1

    fun saludo(capacidades: JSONObject): ByteArray {
        val json = capacidades.toString().toByteArray(Charsets.UTF_8)
        return ByteBuffer.allocate(MAGIA.size + 1 + 4 + json.size)
            .put(MAGIA).put(VERSION.toByte()).putInt(json.size).put(json).array()
    }

    fun trama(tipo: Int, carga: ByteArray): ByteArray =
        ByteBuffer.allocate(5 + carga.size).put(tipo.toByte()).putInt(carga.size).put(carga).array()

    fun json(tipo: Int, obj: JSONObject): ByteArray = trama(tipo, obj.toString().toByteArray(Charsets.UTF_8))

    fun video(microsegundos: Long, clave: Boolean, datos: ByteArray): ByteArray =
        ByteBuffer.allocate(5 + 9 + datos.size)
            .put(VIDEO.toByte()).putInt(9 + datos.size)
            .putLong(microsegundos).put((if (clave) 1 else 0).toByte())
            .put(datos).array()

    // Lee el saludo del PC. Devuelve sus capacidades.
    fun leerSaludo(entrada: DataInputStream): JSONObject {
        val magia = ByteArray(MAGIA.size)
        entrada.readFully(magia)
        if (!magia.contentEquals(MAGIA)) throw IOException("Saludo invalido: no es un flujo Nexo")
        entrada.readUnsignedByte() // version
        val largo = entrada.readInt()
        if (largo < 0 || largo > MAX_TRAMA) throw IOException("Saludo de $largo bytes")
        val json = ByteArray(largo)
        entrada.readFully(json)
        return try { JSONObject(String(json, Charsets.UTF_8)) } catch (e: Exception) { JSONObject() }
    }

    class Trama(val tipo: Int, val carga: ByteArray) {
        // Las tramas de JSON pueden venir vacias (un latido a secas).
        fun json(): JSONObject? =
            if (carga.isEmpty()) null
            else try { JSONObject(String(carga, Charsets.UTF_8)) } catch (e: Exception) { null }
    }

    fun leerTrama(entrada: DataInputStream): Trama {
        val tipo = entrada.readUnsignedByte()
        val largo = entrada.readInt()
        if (largo < 0 || largo > MAX_TRAMA) throw IOException("Trama de $largo bytes")
        val carga = ByteArray(largo)
        entrada.readFully(carga)
        return Trama(tipo, carga)
    }
}
