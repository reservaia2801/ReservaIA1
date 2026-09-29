# ReservaIA 2.0

Paquete completo: frontend, backend Node.js, OpenAI, Google Calendar y WhatsApp.

## Instalación
1. Copia `.env.example` a `.env`.
2. Completa las credenciales privadas.
3. `npm install`
4. `npm start`
5. Abre `/auth/google` para autorizar Google Calendar.

El número de WhatsApp ya está configurado como `5491140940022`.

Google Calendar se consulta con FreeBusy antes de reservar y se vuelve a comprobar inmediatamente antes de insertar el evento. Se usa un ID determinista para reducir duplicados por reintentos idénticos.

No publiques `.env`, API keys, Google Client Secret ni refresh tokens.
