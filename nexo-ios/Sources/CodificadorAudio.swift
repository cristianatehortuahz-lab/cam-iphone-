import Foundation
import AVFoundation
import AudioToolbox

// Codificador de audio AAC. Recibe los bloques que entrega el microfono y los
// entrega comprimidos, listos para la trama AUDIO del protocolo, que ya estaba
// reservada desde el principio y hasta ahora iba siempre vacia.
//
// Se emite AAC-LC en ADTS: cada paquete lleva su propia cabecera de 7 bytes con
// el perfil, la frecuencia y los canales. Asi el PC puede decodificar sin
// necesitar una configuracion previa fuera de banda, igual que el video se
// manda en Annex-B con SPS/PPS delante de cada clave. Si se perdiera el primer
// paquete, los siguientes siguen siendo decodificables por si solos.

final class CodificadorAudio {
    private var convertidor: AVAudioConverter?
    private var formatoEntrada: AVAudioFormat?
    private var formatoSalida: AVAudioFormat?

    // Entrega (datos AAC en ADTS, marca de tiempo en microsegundos).
    var alPaquete: ((Data, UInt64) -> Void)?

    private let tasa: Double = 44100
    private let canales: AVAudioChannelCount = 1
    // Suficiente para voz y no castiga el ancho de banda del cable.
    private let bitrate = 64000

    func detener() {
        convertidor = nil
        formatoEntrada = nil
    }

    // Prepara el convertidor para el formato que entrega el microfono. Se rehace
    // solo si cambia, igual que el codificador de video se redimensiona con el
    // buffer real en vez de fiarse de lo que se le pidio.
    private func prepararSiHaceFalta(_ entrada: AVAudioFormat) -> Bool {
        if let actual = formatoEntrada, actual == entrada, convertidor != nil { return true }

        var descripcion = AudioStreamBasicDescription(
            mSampleRate: tasa,
            mFormatID: kAudioFormatMPEG4AAC,
            mFormatFlags: 0,
            mBytesPerPacket: 0,
            mFramesPerPacket: 1024,
            mBytesPerFrame: 0,
            mChannelsPerFrame: canales,
            mBitsPerChannel: 0,
            mReserved: 0
        )
        guard let salida = AVAudioFormat(streamDescription: &descripcion) else {
            NSLog("Nexo: no se pudo describir el formato AAC")
            return false
        }
        guard let conv = AVAudioConverter(from: entrada, to: salida) else {
            NSLog("Nexo: no se pudo crear el convertidor de audio")
            return false
        }
        conv.bitRate = bitrate
        convertidor = conv
        formatoEntrada = entrada
        formatoSalida = salida
        NSLog("Nexo: audio a AAC %.0f Hz, %d kbps", tasa, bitrate / 1000)
        return true
    }

    func codificar(_ muestras: CMSampleBuffer) {
        guard let formatoCM = CMSampleBufferGetFormatDescription(muestras),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(formatoCM) else { return }

        let entrada = AVAudioFormat(streamDescription: asbd)
        guard let entrada = entrada, prepararSiHaceFalta(entrada),
              let conv = convertidor, let salida = formatoSalida else { return }

        // CMSampleBuffer -> AVAudioPCMBuffer
        let cuantas = CMSampleBufferGetNumSamples(muestras)
        guard cuantas > 0,
              let pcm = AVAudioPCMBuffer(pcmFormat: entrada, frameCapacity: AVAudioFrameCount(cuantas))
        else { return }
        pcm.frameLength = AVAudioFrameCount(cuantas)

        let copiado = CMSampleBufferCopyPCMDataIntoAudioBufferList(
            muestras, at: 0, frameCount: Int32(cuantas), into: pcm.mutableAudioBufferList
        )
        guard copiado == noErr else { return }

        let comprimido = AVAudioCompressedBuffer(
            format: salida, packetCapacity: 8, maximumPacketSize: conv.maximumOutputPacketSize
        )

        var entregado = false
        var error: NSError?
        conv.convert(to: comprimido, error: &error) { _, estado in
            if entregado { estado.pointee = .noDataNow; return nil }
            entregado = true
            estado.pointee = .haveData
            return pcm
        }
        if let error = error {
            NSLog("Nexo: fallo al codificar audio: %@", error.localizedDescription)
            return
        }
        guard comprimido.packetCount > 0, let datos = comprimido.data as UnsafeMutableRawPointer? else { return }

        let pts = CMSampleBufferGetPresentationTimeStamp(muestras)
        let micros = UInt64(max(0, CMTimeGetSeconds(pts) * 1_000_000))

        // Cada paquete AAC sale con su cabecera ADTS delante, para que el PC no
        // dependa de haber recibido una configuracion inicial.
        var salidaBytes = Data()
        var desplazamiento = 0
        let descripciones = comprimido.packetDescriptions
        for i in 0..<Int(comprimido.packetCount) {
            var longitud = Int(comprimido.byteLength)
            var inicio = 0
            if let d = descripciones {
                longitud = Int(d[i].mDataByteSize)
                inicio = Int(d[i].mStartOffset)
            } else {
                inicio = desplazamiento
            }
            guard longitud > 0 else { continue }
            salidaBytes.append(cabeceraADTS(longitud: longitud))
            salidaBytes.append(Data(bytes: datos.advanced(by: inicio), count: longitud))
            desplazamiento += longitud
        }
        guard !salidaBytes.isEmpty else { return }
        alPaquete?(salidaBytes, micros)
    }

    // Cabecera ADTS de 7 bytes (sin CRC) para un paquete AAC-LC.
    private func cabeceraADTS(longitud: Int) -> Data {
        // Cada byte se calcula por separado y con el tipo escrito: juntarlo todo
        // en una expresion hacia que el compilador se rindiera con
        // "unable to type-check this expression in reasonable time".
        let indiceTasa: UInt8 = indiceFrecuencia(tasa)
        let numCanales: UInt8 = UInt8(canales)
        let total: Int = longitud + 7
        let perfil: UInt8 = 1                          // AAC-LC

        let byte2Alto: UInt8 = perfil << 6
        let byte2Medio: UInt8 = (indiceTasa & 0x0F) << 2
        let byte2Bajo: UInt8 = (numCanales >> 2) & 0x01

        let byte3Alto: UInt8 = (numCanales & 0x03) << 6
        let byte3Bajo: UInt8 = UInt8((total >> 11) & 0x03)

        let byte4: UInt8 = UInt8((total >> 3) & 0xFF)
        let byte5Alto: UInt8 = UInt8(total & 0x07) << 5

        var c = Data(count: 7)
        c[0] = 0xFF                                    // sincronismo
        c[1] = 0xF1                                    // MPEG-4, capa 0, sin CRC
        c[2] = byte2Alto | byte2Medio | byte2Bajo
        c[3] = byte3Alto | byte3Bajo
        c[4] = byte4
        c[5] = byte5Alto | 0x1F                        // relleno de buffer
        c[6] = 0xFC                                    // un solo bloque por trama
        return c
    }

    private func indiceFrecuencia(_ hz: Double) -> UInt8 {
        let tablas: [Double] = [96000, 88200, 64000, 48000, 44100, 32000,
                                24000, 22050, 16000, 12000, 11025, 8000, 7350]
        return UInt8(tablas.firstIndex(of: hz) ?? 4)   // 4 = 44100 Hz
    }
}
