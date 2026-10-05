// Ayudante de la camara de Nexo: publica en Windows, como una webcam mas, los
// fotogramas que le manda Nexo Desktop. Asi TikTok LIVE Studio, Zoom o Discord
// eligen una fuente "Camara" en vez de capturar una ventana.
//
// No instala nada: usa la camara virtual que ya registra OBS ("OBS Virtual
// Camera"). Ese componente lee de una cola en memoria compartida llamada
// "OBSVirtualCamVideo" (plugins/win-dshow/shared-memory-queue.c de obs-studio),
// y quien la escribe no tiene por que ser OBS: basta respetar su disposicion.
// Comprobado el 05/10/2026 con TikTok LIVE Studio 1.36.6: lista la camara y la
// abre en horizontal (1280x720) y en vertical (720x1280), y lo que lee otro
// programa coincide byte a byte con lo escrito.
//
//   camvirtual.exe <ancho> <alto> <fps> <tuberia> [traza]
//
// Los fotogramas llegan en NV12 por la tuberia con nombre \\.\pipe\<tuberia>,
// que escribe ffmpeg directamente (sin pasar por Nexo: a 720p son 41 MB/s).
// Cuando Nexo cierra la entrada estandar de este programa, o se muere, la
// camara se apaga de forma ordenada.
//
// Lo compila Nexo la primera vez con el csc.exe que trae Windows (ver
// camara-virtual.js): los .exe no viajan en el repositorio.

using System;
using System.IO;
using System.IO.MemoryMappedFiles;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Threading;

static class CamVirtual
{
    const string NOMBRE = "OBSVirtualCamVideo";
    const int CABECERA = 80;           // sizeof(struct queue_header)
    const int CABECERA_FOTOGRAMA = 32; // 8 de marca de tiempo + relleno
    const uint ARRANCANDO = 1, LISTO = 2, PARANDO = 3;
    const int SIN_IMAGEN_MS = 3000;    // sin fotogramas este tiempo, a negro

    static MemoryMappedViewAccessor v;
    static IntPtr memoria;  // direccion de la cola, para copiar los fotogramas
    static readonly uint[] desp = new uint[3];
    static readonly object candado = new object();
    static int tam;
    static uint n;
    static bool parando;
    static bool enNegro;
    static int ultimo;      // Environment.TickCount del ultimo fotograma
    static bool hayUltimo;  // falso tras un negro: ese hueco no cuenta
    static int cuenta;      // fotogramas desde el ultimo informe
    static int huecoMax;    // mayor espera entre dos fotogramas, en ms
    static bool traza;      // una linea por fotograma, para medir el retraso
    static int reales;      // fotogramas con imagen desde el arranque

    static long Alinear(long x) { return (x + 31) & ~31L; }

    static int Main(string[] a)
    {
        if (a.Length < 4)
        {
            Console.Error.WriteLine("uso: camvirtual <ancho> <alto> <fps> <tuberia>");
            return 2;
        }
        int ancho = int.Parse(a[0]), alto = int.Parse(a[1]), fps = Math.Max(1, int.Parse(a[2]));
        string tuberia = a[3];
        traza = a.Length > 4 && a[4] == "traza";
        tam = ancho * alto * 3 / 2;

        long total = Alinear(CABECERA);
        for (int i = 0; i < 3; i++) { desp[i] = (uint)total; total = Alinear(total + tam + CABECERA_FOTOGRAMA); }

        MemoryMappedFile mapa = Crear(total);
        if (mapa == null)
        {
            // OBS (u otro programa) tiene su camara virtual en marcha: no se pisa.
            Console.Out.WriteLine("ocupada");
            return 3;
        }

        v = mapa.CreateViewAccessor();
        memoria = v.SafeMemoryMappedViewHandle.DangerousGetHandle();
        v.Write(8, ARRANCANDO);
        for (int i = 0; i < 3; i++) v.Write(12 + 4 * i, desp[i]);
        v.Write(24, (uint)0);                 // SHARED_QUEUE_TYPE_VIDEO
        v.Write(28, (uint)ancho);
        v.Write(32, (uint)alto);
        v.Write(40, (ulong)(10000000 / fps)); // intervalo en unidades de 100 ns

        // Un fotograma negro nada mas nacer: la camara existe y dice su tamano
        // aunque el iPhone no haya llegado. Si una aplicacion la abre antes de
        // tiempo, sin esto la tomaria a 1920x1080 (el cartel de OBS) y luego
        // deformaria la imagen.
        byte[] negro = new byte[tam];
        for (int i = 0; i < ancho * alto; i++) negro[i] = 16;
        for (int i = ancho * alto; i < tam; i++) negro[i] = 128;
        Escribir(negro, true);

        Console.Out.WriteLine("lista " + ancho + "x" + alto);
        Console.Out.Flush();

        // Entrada estandar cerrada = Nexo pide parar, o ha muerto.
        var control = new Thread(() =>
        {
            try { while (Console.In.Read() >= 0) { } } catch { }
            Parar(0);
        });
        control.IsBackground = true;
        control.Start();

        // Vigia: a negro si el video se corta, e informe cada 5 s para el
        // registro de Nexo (fotogramas y mayor hueco, como la telemetria de OBS).
        var vigia = new Thread(() =>
        {
            int vueltas = 0;
            while (true)
            {
                Thread.Sleep(500);
                bool pintar;
                int c = 0, h = 0;
                lock (candado)
                {
                    pintar = !enNegro && unchecked(Environment.TickCount - ultimo) > SIN_IMAGEN_MS;
                    if (++vueltas >= 10) { vueltas = 0; c = cuenta; h = huecoMax; cuenta = 0; huecoMax = 0; }
                }
                if (pintar) Escribir(negro, true);
                if (c > 0) { Console.Out.WriteLine("t " + c + " " + h); Console.Out.Flush(); }
            }
        });
        vigia.IsBackground = true;
        vigia.Start();

        var buf = new byte[tam];
        while (true)
        {
            try
            {
                using (var t = new NamedPipeServerStream(tuberia, PipeDirection.In, 1,
                    PipeTransmissionMode.Byte, PipeOptions.None, tam * 2, 0))
                {
                    t.WaitForConnection();
                    while (true)
                    {
                        int leido = 0;
                        while (leido < tam)
                        {
                            int r = t.Read(buf, leido, tam - leido);
                            if (r <= 0) { leido = -1; break; }
                            leido += r;
                        }
                        if (leido < 0) break; // ffmpeg cerro: se espera al siguiente
                        Escribir(buf, false);
                    }
                }
            }
            catch (Exception)
            {
                // Tuberia rota o todavia ocupada: se vuelve a ofrecer.
                Thread.Sleep(100);
            }
        }
    }

    // Crea la cola. Si ya existe hay que distinguir dos casos: que alguien la
    // este alimentando (se respeta) o que sea el resto de un escritor que murio
    // sin despedirse. Las aplicaciones que la tenian abierta la mantienen viva,
    // congelada, y no dejan crear otra: se marca como parada para que la suelten.
    static MemoryMappedFile Crear(long total)
    {
        for (int intento = 0; intento < 40; intento++)
        {
            try { return MemoryMappedFile.CreateNew(NOMBRE, total); }
            catch (IOException) { }

            try
            {
                using (var m = MemoryMappedFile.OpenExisting(NOMBRE))
                using (var w = m.CreateViewAccessor(0, CABECERA))
                {
                    if (w.ReadUInt32(8) == LISTO)
                    {
                        uint antes = w.ReadUInt32(0);
                        Thread.Sleep(400);
                        if (w.ReadUInt32(0) != antes) return null; // viva: no es nuestra
                        w.Write(8, PARANDO);
                    }
                }
            }
            catch (FileNotFoundException) { continue; } // la soltaron entre medias
            catch (IOException) { }
            Thread.Sleep(100);
        }
        return null;
    }

    static void Escribir(byte[] datos, bool negro)
    {
        lock (candado)
        {
            if (parando) return;
            n++;
            uint idx = n % 3;
            v.Write(0, n);                                  // write_idx
            v.Write(desp[idx], (ulong)DateTime.UtcNow.Ticks); // marca de tiempo
            // Copia directa a la memoria. WriteArray del acceso a la vista copia
            // elemento a elemento y no llegaba a 30 fotogramas de 720p por
            // segundo: la camara acumulaba 3 s de retraso (medido el 05/10/2026).
            Marshal.Copy(datos, 0, IntPtr.Add(memoria, (int)(desp[idx] + CABECERA_FOTOGRAMA)), tam);
            v.Write(4, n);                                  // read_idx
            v.Write(8, LISTO);

            enNegro = negro;
            if (negro) { hayUltimo = false; return; }
            int ahora = Environment.TickCount;
            if (hayUltimo)
            {
                int hueco = unchecked(ahora - ultimo);
                if (hueco > huecoMax) huecoMax = hueco;
            }
            ultimo = ahora;
            hayUltimo = true;
            cuenta++;
            reales++;
            if (traza)
            {
                // Lo usa herramientas/prueba-camara-virtual.js: numero de
                // fotograma y hora (ms) en que quedo publicado.
                Console.Out.WriteLine("f " + reales + " " + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                Console.Out.Flush();
            }
        }
    }

    // Marca la cola como parada antes de salir: es lo que hace que las
    // aplicaciones la suelten y vuelvan a su cartel de espera.
    static void Parar(int codigo)
    {
        lock (candado)
        {
            parando = true;
            try { v.Write(8, PARANDO); v.Flush(); } catch { }
            Environment.Exit(codigo);
        }
    }
}
