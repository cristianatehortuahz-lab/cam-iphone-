# Instalar Nexo Cam en el iPhone (por cable, gratis)

La app se compila sola en la nube y produce un archivo `.ipa`. Para ponerlo en el
iPhone se "firma" con tu Apple ID gratuito usando **Sideloadly**, por el cable.

> **Recuerda:** con Apple ID gratuito, la app **caduca a los 7 dias**. Reinstalar
> es repetir el paso 4 (un par de minutos). Es el precio de no pagar los 99 $/año
> de la cuenta de desarrollador.

## 1. Descargar el .ipa compilado

1. Entra en el repositorio en GitHub → pestaña **Actions**.
2. Abre la ejecucion mas reciente de **"Compilar Nexo Cam (iOS)"** (en verde).
3. Abajo, en **Artifacts**, descarga **`Nexo-sin-firmar-ipa`**.
4. Descomprimelo: dentro esta `Nexo-sin-firmar.ipa`.

Enlace directo a Actions:
https://github.com/cristianatehortuahz-lab/cam-iphone-/actions

## 2. Instalar Sideloadly (una vez)

1. Descarga Sideloadly desde su web oficial: https://sideloadly.io
2. Instalalo. Ya tienes el soporte de Apple necesario (viene con iTunes/Apple
   Mobile Device Support, que este PC ya tiene).

## 3. Preparar el iPhone (una vez)

1. Conecta el iPhone por el cable USB-C.
2. Desbloquealo y pulsa **Confiar en este equipo** si aparece.

## 4. Firmar e instalar

1. Abre Sideloadly.
2. Arrastra `Nexo-sin-firmar.ipa` a la ventana.
3. En **Apple ID**, escribe el tuyo (el de tu iPhone vale). La contrasena se la
   das a Sideloadly, no a mi — yo nunca la veo.
4. Pulsa **Start**. Sideloadly firma la app y la instala por el cable.
5. La primera vez, en el iPhone: **Ajustes › General › VPN y gestion de
   dispositivos** → toca tu Apple ID → **Confiar**.

Ya tienes Nexo en la pantalla de inicio del iPhone.

## 5. Usar

1. Abre **Nexo** en el iPhone. Da permiso de camara y microfono.
2. En el PC, abre **Nexo Desktop**.
3. Con el cable conectado, el PC encuentra el iPhone y aparece el video.

## Reinstalar cada semana

Cuando la app deje de abrir (a los 7 dias), vuelve a hacer el **paso 4** con el
mismo `.ipa` (o descarga el ultimo de Actions si hubo cambios). El helper
`reinstalar.bat` abre Sideloadly para acortar el proceso.

## Si algo falla

- **Sideloadly no ve el iPhone:** abre iTunes o la app "Dispositivos Apple" una
  vez para que Windows lo reconozca, y vuelve a intentar.
- **"No se pudo verificar la app" al abrir:** falta el paso 4.5 (confiar en el
  perfil).
- **La app se cierra sola al abrir:** puede haber caducado (7 dias) — reinstala.
