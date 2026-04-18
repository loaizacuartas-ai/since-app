# Since MVP

MVP funcional de llamadas privadas por salas temporales para **2 personas** usando:

- **Node.js + Express**
- **Socket.IO** para señalización, chat y presencia
- **WebRTC** para audio peer-to-peer
- **Frontend mobile-first** en HTML/CSS/JavaScript

## Qué incluye

- Crear sala automática con numeración del 1 al máximo configurado por servidor
- PIN de 4 dígitos
- Unirse a sala por número + PIN
- Máximo 2 personas por sala
- Chat en tiempo real
- Llamada de voz en tiempo real
- Estado visual de sala: disponible, ocupada o llena
- Liberación de la sala cuando queda vacía
- Expiración por inactividad
- Límite básico de intentos fallidos para acceso inválido

## Requisitos

- Node.js 18+
- npm 9+

## Instalación

```bash
npm install
```

## Ejecución local

```bash
npm run dev
```

La app quedará disponible en:

```bash
http://localhost:3000
```

## Cómo probar rápido

### Opción 1: misma computadora

1. Abre `http://localhost:3000` en dos ventanas o dos navegadores distintos.
2. En la primera, crea una sala.
3. Copia el número y el PIN.
4. En la segunda, entra con esos datos.
5. Acepta permisos de micrófono en ambas ventanas.

### Opción 2: celular real

Para usar micrófono en un celular real, normalmente necesitas **HTTPS** porque `getUserMedia` no funciona en contextos inseguros fuera de `localhost`.

Opciones recomendadas:

- exponer el servidor con un túnel HTTPS como Cloudflare Tunnel o ngrok
- desplegar temporalmente en Render, Railway o Fly.io
- usar certificados locales si dominas ese flujo

## Variables de entorno opcionales

```bash
PORT=3000
MAX_ROOMS=100
ROOM_INACTIVITY_MS=900000
JOIN_RATE_LIMIT_WINDOW_MS=300000
MAX_FAILED_JOIN_ATTEMPTS=8
PIN_SECRET=change-me
```

## Flujo implementado

1. Usuario A crea sala.
2. El servidor asigna la primera sala libre.
3. El servidor genera un PIN de 4 dígitos.
4. Usuario A entra automáticamente a la sala.
5. Usuario B ingresa número de sala + PIN.
6. Si el acceso es correcto y hay un cupo disponible, entra.
7. Cuando hay dos personas, el servidor dispara la señalización WebRTC.
8. El audio fluye peer-to-peer y el chat sigue pasando por Socket.IO.
9. Si una persona sale, la llamada termina y la otra puede esperar.
10. Si la sala queda vacía, el servidor la elimina.

## Estructura

```text
since-mvp/
├── package.json
├── server.js
├── README.md
└── public/
    ├── index.html
    ├── styles.css
    └── app.js
```

## Limitaciones conocidas del MVP

- Usa STUN público; para redes restrictivas o NAT compleja, un entorno productivo debería agregar **TURN**.
- Las salas viven en memoria del proceso. Si reinicias el servidor, se pierden.
- No hay cifrado extremo a extremo del chat a nivel aplicación; el audio de WebRTC sí viaja cifrado por DTLS/SRTP.
- No hay analítica, métricas ni moderación todavía.

## Siguiente paso natural

Migrar esta base a una arquitectura con:

- frontend React Native / Expo o Flutter
- backend Node con Redis para presencia y rate limit
- TURN administrado
- observabilidad
- despliegue con HTTPS por defecto
