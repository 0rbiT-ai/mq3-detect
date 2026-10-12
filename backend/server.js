require("dotenv").config({ path: process.env.ENV_FILE || ".env.local" });

const express = require("express");
const mqtt = require("mqtt");
const { WebSocket, WebSocketServer } = require("ws");
const http = require("node:http");

const config = {
  host: process.env.HOST || "0.0.0.0",
  port: Number(process.env.PORT || 8080),
  mqttUrl: process.env.MQTT_URL || "mqtt://127.0.0.1:1883",
  sensorTopic: process.env.MQTT_SENSOR_TOPIC || "vehicle/001/sensors",
  buzzerTopic: process.env.MQTT_BUZZER_COMMAND_TOPIC || "vehicle/001/command/buzzer",
  threshold: Number(process.env.MQ3_THRESHOLD_RAW || 490),
};

if (!Number.isFinite(config.threshold) || config.threshold < 0 || config.threshold > 4095) {
  throw new Error("MQ3_THRESHOLD_RAW must be a number from 0 to 4095.");
}

const app = express();
app.disable("x-powered-by");
const server = http.createServer(app);
const webSockets = new WebSocketServer({ server, path: "/ws" });
const mqttClient = mqtt.connect(config.mqttUrl, {
  clientId: `alcohol-api-${Math.random().toString(16).slice(2, 10)}`,
  reconnectPeriod: 2000,
});

let mqttConnected = false;
let telemetry = null;
let alarmActive = false;
let buzzerOn = false;
let lastAlertAt = null;

function statePacket() {
  return {
    type: "state",
    mqttConnected,
    threshold: config.threshold,
    alarmActive,
    buzzerOn,
    lastAlertAt,
    updatedAt: telemetry?.receivedAt ?? null,
    telemetry: telemetry?.data ?? null,
    topic: telemetry?.topic ?? config.sensorTopic,
  };
}

function broadcast(packet = statePacket()) {
  const encoded = JSON.stringify(packet);
  for (const socket of webSockets.clients) {
    if (socket.readyState === WebSocket.OPEN) socket.send(encoded);
  }
}

function publishBuzzer(enabled, reason) {
  if (!mqttConnected) {
    console.warn(`Buzzer command skipped (${reason}): MQTT is disconnected.`);
    return;
  }
  mqttClient.publish(config.buzzerTopic, enabled ? "ON" : "OFF", { qos: 1 }, (error) => {
    if (error) console.error("Buzzer MQTT publish failed:", error.message);
    else {
      buzzerOn = enabled;
      console.log(`Buzzer ${enabled ? "ON" : "OFF"} (${reason})`);
      broadcast();
    }
  });
}

function isWhatsAppConfigured() {
  const fields = ["WHATSAPP_GRAPH_API_VERSION", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_ACCESS_TOKEN", "WHATSAPP_TO", "WHATSAPP_TEMPLATE_NAME", "WHATSAPP_TEMPLATE_LANGUAGE"];
  return process.env.WHATSAPP_ENABLED === "true" && fields.every((field) => {
    const value = process.env[field]?.trim();
    return value && !value.includes("YOUR_") && !value.includes("XX.X");
  });
}

async function sendWhatsAppAlert(data) {
  if (!isWhatsAppConfigured()) {
    console.warn("WhatsApp alert not sent: fill the WhatsApp fields in backend/.env.local and set WHATSAPP_ENABLED=true.");
    return;
  }

  const version = process.env.WHATSAPP_GRAPH_API_VERSION.replace(/^v/i, "");
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const url = `https://graph.facebook.com/v${version}/${phoneNumberId}/messages`;
  const recipient = process.env.WHATSAPP_TO.replace(/[^\d]/g, "");
  const body = {
    messaging_product: "whatsapp",
    to: recipient,
    type: "template",
    template: {
      name: process.env.WHATSAPP_TEMPLATE_NAME,
      language: { code: process.env.WHATSAPP_TEMPLATE_LANGUAGE },
      components: [{
        type: "body",
        parameters: [
          { type: "text", text: String(data.mq3_raw ?? "unknown") },
          { type: "text", text: String(config.threshold) },
        ],
      }],
    },
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.message || `HTTP ${response.status}`);
    lastAlertAt = new Date().toISOString();
    console.log(`WhatsApp template sent to configured recipient for MQ-3 raw=${data.mq3_raw}.`);
    broadcast();
  } catch (error) {
    console.error("WhatsApp alert failed:", error.message);
  }
}

app.get("/health", (_request, response) => {
  response.json({ ok: true, mqttConnected, websocketClients: webSockets.clients.size, threshold: config.threshold });
});

mqttClient.on("connect", () => {
  mqttConnected = true;
  console.log(`MQTT connected: ${config.mqttUrl}`);
  mqttClient.subscribe(config.sensorTopic, { qos: 0 }, (error) => {
    if (error) console.error("MQTT subscribe failed:", error.message);
    else console.log(`Subscribed to ${config.sensorTopic}`);
  });
  broadcast();
});

mqttClient.on("reconnect", () => console.log("MQTT reconnecting…"));
mqttClient.on("close", () => {
  mqttConnected = false;
  broadcast();
});
mqttClient.on("error", (error) => console.error("MQTT error:", error.message));

mqttClient.on("message", (topic, payload) => {
  let data;
  try {
    data = JSON.parse(payload.toString());
  } catch {
    console.warn(`Ignored non-JSON MQTT message on ${topic}`);
    return;
  }

  telemetry = { topic, data, receivedAt: new Date().toISOString() };
  const raw = Number(data.mq3_raw);
  if (Number.isFinite(raw)) {
    const crossed = raw >= config.threshold;
    if (crossed && !alarmActive) {
      alarmActive = true;
      publishBuzzer(true, `MQ-3 raw ${raw} reached threshold ${config.threshold}`);
      void sendWhatsAppAlert(data);
    } else if (!crossed && alarmActive) {
      alarmActive = false;
      publishBuzzer(false, `MQ-3 raw ${raw} fell below threshold ${config.threshold}`);
    }
  }
  broadcast();
});

webSockets.on("connection", (socket) => {
  socket.send(JSON.stringify(statePacket()));
  socket.on("message", (rawMessage) => {
    let command;
    try {
      command = JSON.parse(rawMessage.toString());
    } catch {
      socket.send(JSON.stringify({ type: "error", message: "Message must be JSON." }));
      return;
    }

    if (command.type === "buzzer" && typeof command.enabled === "boolean") {
      if (!alarmActive || command.enabled) publishBuzzer(command.enabled, "manual app control");
      else socket.send(JSON.stringify({ type: "error", message: "Buzzer stays on while the threshold alarm is active." }));
      return;
    }

    socket.send(JSON.stringify({ type: "error", message: "Unsupported command." }));
  });
});

webSockets.on("error", (error) => console.error("WebSocket error:", error.message));
server.listen(config.port, config.host, () => {
  console.log(`Express + WebSocket server listening on http://${config.host}:${config.port}`);
  console.log(`WebSocket endpoint: ws://<laptop-lan-ip>:${config.port}/ws`);
  console.log(`MQ-3 prototype trigger: ${config.threshold} raw ADC counts`);
});

function shutdown() {
  console.log("Stopping backend…");
  mqttClient.end(true);
  webSockets.close();
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
