import "dotenv/config";
import express from "express";
import crypto from "crypto";
import { google } from "googleapis";
import OpenAI from "openai";

const app = express();

const PORT = Number(process.env.PORT || 3000);
const TIME_ZONE =
  process.env.TIME_ZONE || "America/Argentina/Buenos_Aires";
const CALENDAR_ID =
  process.env.GOOGLE_CALENDAR_ID || "primary";
const MODEL =
  process.env.OPENAI_MODEL || "gpt-5-mini";
function fingerprint(value) {
  return crypto
    .createHash("sha256")
    .update(value || "")
    .digest("hex");
}
app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    })
  : null;

function getOAuthClient() {
  const {
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  } = process.env;

  if (
    !GOOGLE_CLIENT_ID ||
    !GOOGLE_CLIENT_SECRET ||
    !GOOGLE_REDIRECT_URI
  ) {
    return null;
  }

  return new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );
}

function getCalendarClient() {
  const oauth2 = getOAuthClient();

  if (!oauth2 || !process.env.GOOGLE_REFRESH_TOKEN) {
    return null;
  }

  oauth2.setCredentials({
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN
  });

  return google.calendar({
    version: "v3",
    auth: oauth2
  });
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "ReservaIA 2.0",
    aiConfigured: Boolean(openai),
    calendarConfigured: Boolean(getCalendarClient()),
    timeZone: TIME_ZONE
  });
});
app.get("/debug/google-config", (_req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID || "";
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || "";
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || "";
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN || "";

  res.json({
    clientId: {
      present: Boolean(clientId),
      length: clientId.length,
      startsCorrectly: clientId.startsWith("155555631757-"),
      endsCorrectly: clientId.endsWith(
        ".apps.googleusercontent.com"
      )
    },
    clientSecret: {
      present: Boolean(clientSecret),
      length: clientSecret.length,
      hasLeadingWhitespace: clientSecret !== clientSecret.trimStart(),
      hasTrailingWhitespace: clientSecret !== clientSecret.trimEnd()
    },
    redirectUri: {
      value: redirectUri,
      exact: redirectUri ===
        "https://reservaia1-1.onrender.com/auth/google/callback"
    },
    refreshToken: {
      present: Boolean(refreshToken),
      length: refreshToken.length,
      hasLeadingWhitespace: refreshToken !== refreshToken.trimStart(),
      hasTrailingWhitespace: refreshToken !== refreshToken.trimEnd(),
      fingerprint: refreshToken ? fingerprint(refreshToken) : ""
    }
  });
});
app.get("/auth/google", (req, res) => {
  const oauth2 = getOAuthClient();

  if (!oauth2) {
    return res.status(500).send(
      "Faltan las credenciales de Google."
    );
  }

  const url = oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [
      "https://www.googleapis.com/auth/calendar"
    ]
  });

  res.redirect(url);
});

app.get("/auth/google/callback", async (req, res) => {
  try {
    const oauth2 = getOAuthClient();

    if (!oauth2) {
      return res.status(500).send(
        "Google Calendar no está configurado."
      );
    }

    if (!req.query.code) {
      return res.status(400).send(
        "Falta el código de Google."
      );
    }

    const { tokens } = await oauth2.getToken(
  String(req.query.code)
);

let freshRefreshTest = "no_refresh_token";
let freshRefreshFingerprint = "";

if (tokens.refresh_token) {
  freshRefreshFingerprint =
    fingerprint(tokens.refresh_token);
  try {
    oauth2.setCredentials({
      refresh_token: tokens.refresh_token
    });

    const { token } = await oauth2.getAccessToken();

    freshRefreshTest = token
      ? "success"
      : "no_access_token";
  } catch (refreshError) {
    console.error(
      "DEBUG FRESH REFRESH:",
      refreshError?.response?.data ||
      refreshError?.message ||
      refreshError
    );

    freshRefreshTest =
      refreshError?.response?.data?.error ||
      refreshError?.message ||
      "refresh_failed";
  }
}

res.type("text/plain").send(
  `Google Calendar autorizado.

Refresh token recibido: ${Boolean(tokens.refresh_token)}
Refresh token recién emitido funciona: ${freshRefreshTest}
Huella del refresh token recién emitido: ${freshRefreshFingerprint}`
);
  } catch (error) {
    console.error(error);

    res.status(500).send(
      "No se pudo autorizar Google Calendar."
    );
  }
});

function parseDateTime(date, time) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !/^\d{2}:\d{2}$/.test(time)
  ) {
    throw new Error(
      "Fecha u hora inválida."
    );
  }

  const value = new Date(
    `${date}T${time}:00-03:00`
  );

  if (Number.isNaN(value.getTime())) {
    throw new Error(
      "Fecha u hora inválida."
    );
  }

  return value;
}

async function isSlotFree(
  calendar,
  start,
  end
) {
  const result =
    await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 20
    });

  return (
    (result.data.items || []).length === 0
  );
}

app.get(
  "/api/availability",
  async (req, res) => {
    try {
      const calendar =
        getCalendarClient();

      if (!calendar) {
        return res.status(503).json({
          error:
            "Google Calendar todavía no está configurado."
        });
      }

      const date = String(
        req.query.date || ""
      );

      const time = String(
        req.query.time || ""
      );

      const duration = Math.max(
        15,
        Number(req.query.duration || 60)
      );

      const start =
        parseDateTime(date, time);

      const end = new Date(
        start.getTime() +
          duration * 60000
      );

      const available =
        await isSlotFree(
          calendar,
          start,
          end
        );

      res.json({
        available,
        start,
        end
      });

    } catch (error) {
      console.error(error);

      res.status(400).json({
        error:
          error.message ||
          "No se pudo comprobar disponibilidad."
      });
    }
  }
);

app.post("/api/chat", async (req, res) => {
  try {
    const message = String(
      req.body?.message || ""
    ).trim();

    if (!message) {
      return res.status(400).json({
        error: "message es obligatorio"
      });
    }

    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return res.status(503).json({
        reply: "La IA todavía no está configurada."
      });
    }

    const url =
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent";

    const payload = {
      system_instruction: {
        parts: [{
          text:
            "Eres ReservaIA, una asistente virtual " +
            "de reservas. Responde en español, " +
            "de forma breve, amable y clara. " +
            "No inventes disponibilidad. " +
            "Si necesitas comprobar un horario, " +
            "indica que debes consultar el calendario. " +
            "No confirmes reservas: estas deben " +
            "realizarse mediante el sistema de reservas."
        }]
      },
      contents: [{
        role: "user",
        parts: [{ text: message }]
      }]
    };

    let response;
    let data;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(30000)
        });

        data = await response.json();

        if (response.ok) {
          break;
        }

        const retryable =
          [429, 500, 502, 503, 504].includes(
            response.status
          );

        if (!retryable || attempt === 2) {
          break;
        }
      } catch (error) {
        if (attempt === 2) {
          throw error;
        }
      }

      await new Promise(resolve =>
        setTimeout(resolve, 1500 * (attempt + 1))
      );
    }

    if (!response) {
      return res.status(502).json({
        error: "Gemini no respondió. Intenta nuevamente."
      });
    }

    if (!response.ok) {
  console.error(
    "Gemini API error:",
    JSON.stringify(data)
  );

  return res.status(502).json({
    error: "Gemini rechazó la solicitud.",
    status: response.status,
    detail: data?.error?.message || "Sin mensaje adicional"
  });
}

   const reply = (
      data.candidates?.[0]?.content?.parts || []
    )
      .map(part => part.text || "")
      .join("")
      .trim();

    res.json({
      reply: reply || "No pude generar una respuesta."
    });

  } catch (error) {
    console.error(
      "Gemini error:",
      error?.message || error
    );

    res.status(500).json({
      error: "No se pudo consultar la IA."
    });
  }
});
app.post(
  "/api/book",
  async (req, res) => {
    try {
      const calendar =
        getCalendarClient();

      if (!calendar) {
        return res.status(503).json({
          error:
            "Google Calendar todavía no está configurado."
        });
      }

      const name = String(
        req.body?.name || ""
      ).trim();

      const service = String(
        req.body?.service || ""
      ).trim();

      const date = String(
        req.body?.date || ""
      );

      const time = String(
        req.body?.time || ""
      );

      const duration = Math.max(
        15,
        Number(req.body?.duration || 60)
      );

      if (
        !name ||
        !service ||
        !date ||
        !time
      ) {
        return res.status(400).json({
          error:
            "Faltan datos de la reserva."
        });
      }

      const start =
        parseDateTime(date, time);

      const end = new Date(
        start.getTime() +
          duration * 60000
      );

      // Comprobación final antes de reservar.
      const free =
        await isSlotFree(
          calendar,
          start,
          end
        );

      if (!free) {
        return res.status(409).json({
          error:
            "Ese horario acaba de ser ocupado. Elige otro."
        });
      }

      const event =
        await calendar.events.insert({
          calendarId: CALENDAR_ID,

          requestBody: {
            summary:
              `${service} - ${name}`,

            description:
              `Reserva creada por ReservaIA 2.0.
Cliente: ${name}
Servicio: ${service}`,

            start: {
              dateTime:
                start.toISOString(),
              timeZone: TIME_ZONE
            },

            end: {
              dateTime:
                end.toISOString(),
              timeZone: TIME_ZONE
            }
          }
        });

      res.status(201).json({
        ok: true,
        message:
          "Reserva confirmada.",
        eventId: event.data.id,
        htmlLink:
          event.data.htmlLink
      });

    } catch (error) {
      console.error(error);

      res.status(400).json({
        error:
          error.message ||
          "No se pudo crear la reserva."
      });
    }
  }
);

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `ReservaIA 2.0 funcionando en puerto ${PORT}`
    );
  }
);
