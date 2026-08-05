import Foundation
import VideoToolbox
import CoreMedia

// Codificador H.264 por hardware con VideoToolbox. Recibe los fotogramas de la
// camara (CVPixelBuffer) y entrega unidades NAL en formato Annex-B, que es lo
// que espera el decodificador WebCodecs del PC (decodificador.js, modo 'annexb').
//
// VideoToolbox entrega los NAL en formato AVCC (con prefijo de longitud) y los
// parametros SPS/PPS aparte; aqui los convertimos a Annex-B (codigo de inicio
// 00 00 00 01) y anteponemos SPS/PPS a cada fotograma clave, para que el PC
// pueda empezar a decodificar en cualquier momento.

final class Codificador {
    private var sesion: VTCompressionSession?
    private let ancho: Int32
    private let alto: Int32

    // Entrega (datos Annex-B, marca de tiempo en microsegundos, esClave).
    var alFotograma: ((Data, UInt64, Bool) -> Void)?

    private static let codigoInicio = Data([0x00, 0x00, 0x00, 0x01])

    init(ancho: Int32, alto: Int32) {
        self.ancho = ancho
        self.alto = alto
    }

    func iniciar(fps: Int32, bitrate: Int) {
        detener()

        var sesionCreada: VTCompressionSession?
        let estado = VTCompressionSessionCreate(
            allocator: kCFAllocatorDefault,
            width: ancho,
            height: alto,
            codecType: kCMVideoCodecType_H264,
            encoderSpecification: nil,
            imageBufferAttributes: nil,
            compressedDataAllocator: nil,
            outputCallback: nil,
            refcon: nil,
            compressionSessionOut: &sesionCreada
        )
        guard estado == noErr, let s = sesionCreada else {
            NSLog("Nexo: no se pudo crear la sesion de codificacion (%d)", estado)
            return
        }
        sesion = s

        // Tiempo real, sin reordenar fotogramas (menor latencia para un directo).
        VTSessionSetProperty(s, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        VTSessionSetProperty(s, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
        VTSessionSetProperty(s, key: kVTCompressionPropertyKey_ProfileLevel,
                             value: kVTProfileLevel_H264_High_AutoLevel)
        VTSessionSetProperty(s, key: kVTCompressionPropertyKey_H264EntropyMode,
                             value: kVTH264EntropyMode_CABAC)
        VTSessionSetProperty(s, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: NSNumber(value: fps))
        VTSessionSetProperty(s, key: kVTCompressionPropertyKey_AverageBitRate, value: NSNumber(value: bitrate))
        // Un fotograma clave cada 2 segundos: permite reconectar rapido.
        VTSessionSetProperty(s, key: kVTCompressionPropertyKey_MaxKeyFrameInterval, value: NSNumber(value: fps * 2))
        VTCompressionSessionPrepareToEncodeFrames(s)
    }

    func codificar(_ pixelBuffer: CVPixelBuffer, tiempo: CMTime) {
        guard let s = sesion else { return }
        VTCompressionSessionEncodeFrame(
            s,
            imageBuffer: pixelBuffer,
            presentationTimeStamp: tiempo,
            duration: .invalid,
            frameProperties: nil,
            infoFlagsOut: nil
        ) { [weak self] estado, _, sampleBuffer in
            guard estado == noErr, let sb = sampleBuffer else { return }
            self?.procesarSalida(sb)
        }
    }

    // Convierte el CMSampleBuffer (AVCC) a Annex-B y lo entrega.
    private func procesarSalida(_ sb: CMSampleBuffer) {
        guard let dataBuffer = CMSampleBufferGetDataBuffer(sb) else { return }

        // Fotograma clave = el que NO esta marcado como "no sincronizado". Se lee
        // del adjunto del sample buffer, sin punteros crudos.
        let adjuntos = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[CFString: Any]]
        let noSync = (adjuntos?.first?[kCMSampleAttachmentKey_NotSync] as? Bool) ?? false
        let esClave = !noSync

        var salida = Data()

        // En un fotograma clave, anteponer SPS/PPS en Annex-B.
        if esClave, let fmt = CMSampleBufferGetFormatDescription(sb) {
            salida.append(parametrosAnnexB(fmt))
        }

        // Datos del fotograma: vienen en AVCC (longitud de 4 bytes + NAL). Se
        // recorren las NAL y se sustituye el prefijo de longitud por el codigo
        // de inicio Annex-B.
        var lengthAtStart: Int = 0
        var totalLength: Int = 0
        var dataPointer: UnsafeMutablePointer<Int8>?
        guard CMBlockBufferGetDataPointer(dataBuffer, atOffset: 0, lengthAtOffsetOut: &lengthAtStart,
                                          totalLengthOut: &totalLength, dataPointerOut: &dataPointer) == noErr,
              let ptr = dataPointer else { return }

        let bytes = UnsafeRawPointer(ptr).assumingMemoryBound(to: UInt8.self)
        var offset = 0
        while offset + 4 <= totalLength {
            var nalLength: UInt32 = 0
            for i in 0..<4 { nalLength = (nalLength << 8) | UInt32(bytes[offset + i]) }
            offset += 4
            let len = Int(nalLength)
            if offset + len > totalLength { break }
            salida.append(Self.codigoInicio)
            salida.append(Data(bytes: bytes + offset, count: len))
            offset += len
        }

        let pts = CMSampleBufferGetPresentationTimeStamp(sb)
        let micros = UInt64(max(0, CMTimeGetSeconds(pts) * 1_000_000))
        alFotograma?(salida, micros, esClave)
    }

    // Extrae SPS y PPS del formato y los devuelve como NAL Annex-B.
    private func parametrosAnnexB(_ fmt: CMFormatDescription) -> Data {
        var salida = Data()
        var count = 0
        CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmt, parameterSetIndex: 0,
            parameterSetPointerOut: nil, parameterSetSizeOut: nil, parameterSetCountOut: &count, nalUnitHeaderLengthOut: nil)
        for i in 0..<count {
            var ptr: UnsafePointer<UInt8>?
            var size = 0
            if CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmt, parameterSetIndex: i,
                parameterSetPointerOut: &ptr, parameterSetSizeOut: &size,
                parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil) == noErr, let p = ptr {
                salida.append(Self.codigoInicio)
                salida.append(Data(bytes: p, count: size))
            }
        }
        return salida
    }

    func detener() {
        if let s = sesion {
            VTCompressionSessionCompleteFrames(s, untilPresentationTimeStamp: .invalid)
            VTCompressionSessionInvalidate(s)
        }
        sesion = nil
    }
}
